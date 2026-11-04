"""Local server for Blaulicht München.

Serves the static app and gives the triage and dispatch agents access to
Claude. The API key is read from the environment or from a .env file next to
this script, and never reaches the browser.
"""

import json
import os
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import anthropic
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8800"))
MAX_BODY_BYTES = 64_000
PUBLIC_FILES = {"/", "/index.html"}
PUBLIC_DIRS = ("/js/", "/css/")

TRIAGE_SYSTEM = (
    "You are the triage agent in a Munich ambulance dispatch centre. "
    "You receive one emergency call with the caller's words, age, vitals and a rule based score. "
    "Rank it with the Manchester Triage System colours: RED (immediate, score 88 to 100), "
    "ORANGE (very urgent, 72 to 87), YELLOW (urgent, 55 to 71), GREEN (standard, 0 to 54). "
    "Agree with the rule score unless the call clearly warrants a different colour. "
    "Write the reason as one short sentence of at most 18 words, in plain English, "
    "without contractions and without dashes."
)

DISPATCH_SYSTEM = (
    "You are the dispatch coordinator in a Munich ambulance dispatch centre. "
    "A traffic agent has ranked the free ambulances by forecast drive time and the capable hospitals "
    "by transport time and emergency room load. Choose one ambulance and one hospital for the patient. "
    "Prefer the fastest unit for RED and ORANGE patients. For lower priorities you may keep a unit that "
    "protects coverage. Avoid hospitals above 90 percent load unless no alternative is close. "
    "Write the reason as one short sentence of at most 22 words, in plain English, "
    "without contractions and without dashes."
)

TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": ["RED", "ORANGE", "YELLOW", "GREEN"]},
        "score": {"type": "integer"},
        "reason": {"type": "string"},
    },
    "required": ["category", "score", "reason"],
    "additionalProperties": False,
}

DISPATCH_SCHEMA = {
    "type": "object",
    "properties": {
        "unit": {"type": "string"},
        "hospital": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["unit", "hospital", "reason"],
    "additionalProperties": False,
}

AGENTS = {
    "/api/llm/triage": (TRIAGE_SYSTEM, TRIAGE_SCHEMA),
    "/api/llm/dispatch": (DISPATCH_SYSTEM, DISPATCH_SCHEMA),
}


def has_credentials() -> bool:
    """Return whether an Anthropic API key is configured in the environment."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def model_label(model: str) -> str:
    """Return a short display name such as Opus or Haiku for a model id."""
    for family in ("fable", "opus", "sonnet", "haiku"):
        if family in model:
            return family.capitalize()
    return "Claude"


def ask_model(client: anthropic.Anthropic, system: str, schema: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    """Send one agent brief to the model and return the JSON object it answers with."""
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=4000,
        system=system,
        messages=[{"role": "user", "content": json.dumps(brief, ensure_ascii=False)}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined this request.")
    text = next(block.text for block in response.content if block.type == "text")
    return json.loads(text)


class AppHandler(SimpleHTTPRequestHandler):
    """Serves the app files and the two agent endpoints."""

    client: anthropic.Anthropic | None = None

    def log_message(self, format: str, *args: Any) -> None:
        """Log only agent calls, not every static file request."""
        if self.path.startswith("/api/"):
            sys.stderr.write(f"{self.address_string()} {format % args}\n")

    def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        """Write a JSON response with the given status code."""
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        """Disable caching so edits to the app show up on reload."""
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:
        """Answer the status endpoint or serve a static file."""
        if self.path == "/api/llm/status":
            status = {"enabled": self.client is not None, "model": MODEL, "label": model_label(MODEL)}
            self.send_json(HTTPStatus.OK, status)
            return
        if not self.is_public():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        """Serve HEAD requests for public app files only."""
        if not self.is_public():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            return
        super().do_HEAD()

    def is_public(self) -> bool:
        """Return whether the path is an app file, which keeps .env and the server code private."""
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if ".." in path or "/." in path:
            return False
        return path in PUBLIC_FILES or path.startswith(PUBLIC_DIRS)

    def read_brief(self) -> dict[str, Any] | None:
        """Read and parse the JSON request body, or return None when it is invalid."""
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            brief = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            return None
        return brief if isinstance(brief, dict) else None

    def do_POST(self) -> None:
        """Run the triage or dispatch agent on the posted brief."""
        agent = AGENTS.get(self.path)
        if agent is None:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "Unknown endpoint."})
            return
        if self.client is None:
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "No ANTHROPIC_API_KEY is set."})
            return
        brief = self.read_brief()
        if brief is None:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "The request body must be a JSON object."})
            return
        system, schema = agent
        try:
            self.send_json(HTTPStatus.OK, ask_model(self.client, system, schema, brief))
        except anthropic.AuthenticationError:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "The API key was rejected."})
        except anthropic.RateLimitError:
            self.send_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Rate limited by the API."})
        except anthropic.APIStatusError as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": f"API error {error.status_code}."})
        except anthropic.APIConnectionError:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": "Could not reach the API."})
        except (RuntimeError, StopIteration, json.JSONDecodeError) as error:
            self.send_json(HTTPStatus.BAD_GATEWAY, {"error": str(error) or "Unexpected model answer."})


def main() -> None:
    """Start the server, with the model agents enabled when an API key is present."""
    AppHandler.client = anthropic.Anthropic(timeout=30.0, max_retries=1) if has_credentials() else None
    mode = f"{model_label(MODEL)} agents on ({MODEL})" if AppHandler.client else "rules only, set ANTHROPIC_API_KEY in .env"
    server = ThreadingHTTPServer((HOST, PORT), partial(AppHandler, directory=str(ROOT)))
    print(f"Blaulicht München on http://{HOST}:{PORT} ({mode})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
