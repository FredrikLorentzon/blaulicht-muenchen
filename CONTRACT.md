# Blaulicht München: build contract

A hackathon demo. A browser app that simulates ambulances in Munich on a playful top down map. When a 112 call comes in, a multi agent system recommends which ambulance goes, which route it drives and which hospital takes the patient. The demo must look great and run without errors for a 10 minute pitch.

Agents in this version:

- **Triage agent** ranks patients (Manchester style colours RED, ORANGE, YELLOW, GREEN) and re-ranks waiting patients as they age.
- **Traffic agent** predicts congestion per road for now and the next 60 minutes (rush hour, events, accidents, snow) and serves travel time forecasts.
- **Dispatch coordinator** is the orchestrator. It asks the traffic agent for forecasts, combines them with the triage ranking and recommends ambulance, route and hospital. A human dispatcher ("You") approves, or auto-approve does it after a countdown.

More agents will be added later (hospital capacity agent, fleet rebalancing agent), so keep agents as separate classes that talk through the message bus.

## Ground rules for every module

- Plain browser JavaScript, no build step, no frameworks, no ES modules (the page must also work when opened as `file://`). Every file is an IIFE that attaches to `window.BL`. `'use strict'` at the top.
- Load order in `index.html`: `js/data.js`, `js/agents.js`, `js/sim.js`, `js/map.js`, `js/ui.js`. A file may only use things from files loaded before it at load time. At call time anything on `BL` is available.
- `js/data.js` is finished and owned by the lead. Read it, never edit it. It provides geography in a metre grid (x east, y south, origin at the north west corner, `BL.MAP_W` about 16.3 km, `BL.MAP_H` about 15.6 km), the road graph, hospitals, stations, priorities, decoration geometry and helpers.
- Simulation time `t` is in seconds since Monday 00:00. `BL.START_T` is Tuesday 07:35. At speed 1, one real second is `BL.SIM_RATE` (20) sim seconds.
- Light theme only. Never add a dark mode.
- UI copy is English, plain and short. Do not use contractions in UI copy ("do not", "cannot"). Do not use em dashes or en dashes anywhere in copy, and never use a lone dot character (·) as a separator. Use line breaks, chips or commas instead.
- No `alert`, `confirm`, `prompt`, `window.print`, no network calls except Google Fonts.
- Code quality must be high: small named functions, clear names, no dead code, no console noise.

## Design tokens (defined in `css/app.css` `:root`, used by `css/map.css`)

```
--canvas #E6ECF2   page background (cool light grey blue)
--paper #FFFFFF    panels
--ink #15213A      main text (deep navy)
--ink-2 #475673    secondary text
--muted #7A87A1    captions
--line #DCE3EC     hairlines
--signal #2160E8   accent, the blue light of the ambulance
--signal-soft #E4ECFE
--p-red #E23D3D  --p-orange #F07A1B  --p-yellow #E5AE06  --p-green #2E9E68   priority colours
--a-intake #64748B  --a-triage #D9467C  --a-traffic #E99A0B  --a-coord #2160E8  --a-you #15213A   agent colours
--s-idle #2E9E68  --s-scene #2160E8  --s-onscene #E99A0B  --s-hosp #8B4FD8  --s-hand #7A87A1  --s-return #1E9AA8   ambulance state colours
--land #EDF1E1  --park #BDE3A3  --tree #8CCB74  --tree-dark #6DB25A  --water #7FC3EE  --water-bank #CBE8F6
--road #FFFFFF  --road-case #CED5C2  --ring #FFDF85  --ring-case #E5BE55  --hwy #FFC98A  --hwy-case #E6A55A
--font-display "Fredoka", "Nunito Sans", system-ui, sans-serif     headings, brand, big numbers, map labels
--font-body "Nunito Sans", system-ui, -apple-system, "Segoe UI", sans-serif
--font-mono "JetBrains Mono", ui-monospace, Menlo, monospace        clock, ids, timestamps
```

Google Fonts link (in `index.html`): `https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=JetBrains+Mono:wght@500;600&family=Nunito+Sans:opsz,wght@6..12,400;6..12,600;6..12,700;6..12,800&display=swap`

Visual direction: a friendly toy city seen from above. Pastel blocks, chunky rounded roads, a bright blue Isar, cartoon ambulances with blinking blue lights, pulsing patient pins. The sidebar feels like a calm control room: white cards, crisp type, agent colours used as small accents only.

## Shared runtime objects

### Location and route

```
Loc   = { e: edgeIndex, t: 0..1 }            // position along BL.EDGES[e] from node a (t=0) to node b (t=1)
Leg   = { e: edgeIndex, t0, t1 }             // traversal of one edge from t0 to t1 (t1 may be smaller than t0)
Route = { legs: Leg[], depart, arrive, duration, length }   // seconds, seconds, seconds, metres
```

### Patient (created by sim, assessed by triage)

```
{
  id: 'P-001', n: 1,
  caseKey, label, emoji,             // from BL.CASES
  age, vitals: { hr, spo2, gcs },    // spo2 may be null (cardiac arrest)
  call,                              // caller sentence, e.g. "My father's face is drooping..."
  finding,                           // short clinical finding
  loc: Loc, x, y,                    // road position for routing; x,y display point offset 25 m beside the road
  street, area,                      // edge name and BL.nearestNeighborhood
  callT, sceneDur,                   // call time, on scene treatment seconds
  score, cat, need, reasons: [],     // set by triage: 0..100, 'RED'|'ORANGE'|'YELLOW'|'GREEN', capability key, short strings
  status,                            // 'waiting'|'pending'|'assigned'|'onScene'|'transport'|'delivered'
  amb, hosp, rec,                    // runtime references or null
  holdUntil, queueNoted, divertTried,
  arriveT, responseT, doneT          // set by sim
}
```

### Ambulance (sim)

```
{
  id: 'RTW1', n: 1, name: 'RTW 1', station,   // runtime station object
  loc: Loc, x, y, heading,                    // heading in radians, map frame
  state,                                      // 'idle'|'toScene'|'onScene'|'toHospital'|'handover'|'returning'
  siren,                                      // true while driving to scene or to hospital with RED/ORANGE/YELLOW
  path: Route|null, legIdx, legPos,           // legPos metres into the current leg
  patient, hosp, timerEnd, reservedBy         // reservedBy is a recommendation id or null
}
```

Available for dispatch means `state` is `'idle'` or `'returning'` and `reservedBy` is null.

### Hospital and station (sim runtime copies of the data entries)

```
hospital = { ...BL.HOSPITALS[i], nodeIdx, loc, x, y, load, baseline }   // load is a float bed count, baseline 0.45..0.75
station  = { ...BL.STATIONS[i], nodeIdx, loc, x, y }
```

### Recommendation (coordinator)

```
{
  id, createdT,
  p,                                   // patient
  amb, route1,                         // chosen unit and its route to the patient (forecast, siren)
  alt: { amb, route } | null,          // second best unit
  hosp, route2,                        // chosen hospital and route patient -> hospital, departing route1.arrive + sceneDur
  altHosp: { hosp, route } | null,
  sceneDur,
  divertFrom: patient | null,          // set when the unit is diverted away from a lower priority patient
  reasons: [ { agent: 'triage'|'traffic'|'coord', text } ],   // 3 to 5 short bullet sentences for the card
  revealed: false,                     // UI sets true when the coordinator message that announces it is shown
  remainingMs                          // auto-approve countdown, starts at BL.AUTO_APPROVE_MS (4000), UI decrements
}
```

## Module: `js/agents.js` (agents subagent)

Exposes on `BL`:

- `BL.CASES`: array of case types. Each `{ key, label, emoji, weight, base, need, scene: [minMin, maxMin], age: [min, max], vitals(): {hr, spo2, gcs}, finding, calls: [two caller sentences] }`. Cases: cardiac arrest (❤️, cardiac, base 96), suspected stroke (🧠, stroke, 86), major trauma cyclist or scooter (🚲, trauma, 84), severe breathing difficulty (🫁, general, 74), chest pain (💔, cardiac, 74), unconscious person (😵, general, 78), severe allergic reaction (🐝, general, 72), childbirth (👶, obstetrics, 62), child with seizure (🧸, pediatric, 70), fall with hip injury elderly (🦴, general, 56), minor injury (🩹, general, 40), intoxication (🍺, general, 46). Weights roughly: minor 12, fall 10, breathing 9, chest 9, stroke 7, unconscious 7, trauma 6, cardiac 5, allergy 4, child 4, intoxication 4, birth 3.
- `BL.AUTO_APPROVE_MS = 4000`.
- `BL.createBus()` returns `{ post(msg), subscribe(fn) }`. `post({ from, to, text, onShow })` stamps `id` and `t` (sim time, the bus gets a `getTime` function at creation: `BL.createBus(() => sim.t)`) and calls subscribers synchronously. Agent ids: `'intake'`, `'triage'`, `'traffic'`, `'coord'`, `'you'`.
- `BL.travelTime(sim, edge, metres, T, opts)`: seconds to drive `metres` on `edge` entering at time `T`. `opts = { siren, forecast }`. Factor `f = sim.traffic.factor(edge, T, forecast ? 'forecast' : 'actual')`. With siren the effective factor is `1 + (f - 1) * BL.SIREN_RELIEF`. Speed is `BL.BASE_SPEED[edge.type]`, times 0.8 without siren.
- `BL.findRoute(sim, from, to, depart, opts)`: time dependent Dijkstra over `BL.NODES` and `BL.ADJ` (about 60 nodes, an O(n²) scan is fine). Sources are both ends of `from.e` with partial costs, targets both ends of `to.e` with partial costs, plus the direct case when `from.e === to.e`. Returns a `Route`. Drop legs shorter than 0.5 m. Same location returns an empty route with duration 0.
- `BL.routePoints(route, fromLegIdx = 0, startPoint = null)`: polyline `[[x, y], ...]` for drawing.
- `BL.routeVia(route)`: "via Ismaninger Straße and Isarring", the two road names with the most metres, in driving order.
- `BL.remainingTime(sim, amb)`: forecast seconds for the rest of `amb.path` from `legIdx`/`legPos`, or null.

`class BL.TrafficAgent(sim)`

- `rush(T)`: weekday curve with peaks at 08:00 (amplitude 1.15, width 0.9 h), 17:24 (1.35, 1.1 h), a midday bump 12:30 (0.35, 2.2 h), floor 0.04. Weekend (Sat, Sun) is flatter.
- `factor(edge, T, mode)`: `1 + rush(T) * edge.commute + eventLoad(edge) + accidentLoad(edge, T)`, times 1.35 with snow. `mode === 'actual'` adds a smooth wobble of about ±8 % from `sin(edge.i * 1.93 + T / 420)`. Never below 1.
- Events from `sim.scenario`: `wiesn` adds up to +1.5 within 1.6 km of `BL.WIESN.center`. `match` adds up to +2.0 within 4.2 km of `BL.ARENA` and +0.8 on `hwy` edges. `snow` is the global multiplier above.
- `accidents: [{ id, e, start, dur, sev }]`. Load on the edge is `sev`, on `BL.EDGES[e].neighbors` 30 % of it, full for the first 60 % of `dur` then fading to 0. `addAccident(edgeIdx)` (random ring or arterial edge when omitted, dur 25 min, sev 2.8) posts a traffic message ("Crash reported on Garmischer Straße. Expect ×3.6 there for about 25 min.") and calls `sim.coordinator.onAccident(acc)`. Also spawn a random accident on its own about once per 70 sim minutes. Remove expired ones.
- `cityIndex(T, mode)`: length weighted mean factor. `forecastSeries(now)`: 7 points `{ t, v }` at 0, 10 ... 60 minutes ahead (forecast mode). `trend(now)`: 'rising' | 'easing' | 'steady' comparing now and +20 min.
- `confidence(horizonS)`: integer percent, 95 minus 0.6 per minute of horizon, minus 4 per active accident, minus 6 with snow, clamped 60..97.
- `worstRoad(T)`: `{ name, f }` road name with the highest length weighted factor.
- `phaseLabel(T)`: 'Morning rush', 'Evening rush', 'Midday', 'Off peak', 'Night', 'Weekend'.
- `tick(dt)`: random accidents, expiry, and a proactive bulletin every 20 sim minutes and when the phase changes, e.g. to `coord`: "Forecast for 08:05: Landshuter Allee heading to ×2.3 as the morning peak builds. City index ×1.7, rising."
- `status()`: short line for the agent map, e.g. "×1.62 rising".

`class BL.TriageAgent(sim)`

- `assess(p)`: score = case base, +5 age ≥ 75, +5 age ≤ 5, +7 SpO₂ < 90, +8 GCS ≤ 8, +4 HR ≥ 130, clamped 5..100. Category from `BL.PRIORITY[*].min` (RED ≥ 88, ORANGE ≥ 72, YELLOW ≥ 55, else GREEN). Sets `p.score`, `p.cat`, `p.need = case.need`, `p.reasons`. Posts two messages: intake → triage with the call ("112 call from Leopoldstraße, Schwabing: “…”"), triage → coord with the verdict ("P-012 Suspected stroke, 71 y. FAST positive, onset about 20 min ago. Score 94, RED Immediate. Needs a stroke unit. Target response 8 min.").
- `rescore(p)`: waiting aging adds 1 point per 2 minutes waited (cap +20) while status is `waiting` or `pending`. On a category change post triage → coord ("P-009 has waited 14 min. Upgraded to YELLOW.") and return true.
- `tick(dt)`: rescore waiting and pending patients every 30 sim seconds. When anything was upgraded, call `sim.coordinator.plan()`.
- `queue()`: patients with status waiting or pending sorted by score, highest first.
- `status()`: "4 ranked" or "Queue empty".

`class BL.Coordinator(sim)`

- `recs`: open recommendations, oldest first.
- `available()`: ambulances available for dispatch.
- `plan()`: for every waiting patient (not held: `sim.t >= (p.holdUntil || 0)`) in triage order: if free units exist, `recommend(p)`. Else if `p.cat === 'RED'` and not `p.divertTried`, try a diversion: an ambulance in `toScene` whose patient is GREEN or YELLOW, the one with the fastest route to `p`. Else note once (`p.queueNoted`) with coord → triage "No free unit for P-014. Holding it at queue position 2."
- `recommend(p, divertFrom)`: route every candidate (`siren: true, forecast: true`, depart `sim.t`), best and second best. Hospitals with `caps.includes(p.need)` (fall back to all): route from `p.loc` departing at `route1.arrive + p.sceneDur`, cost = duration + load penalty (`max(0, load / capacity - 0.6) * 1500` s, or 1800 s when full). Reserve the unit (`amb.reservedBy = rec.id`), `p.status = 'pending'`, `p.rec = rec`, push to `recs`. Post coord → traffic ("Need travel forecasts for P-012: 5 free units to the scene, then 3 hospitals with a stroke unit."), traffic → coord (fastest unit, minutes, `routeVia`, the worst factor on the route, second best unit, hospital leg minutes, confidence), and coord → you with `onShow: () => { rec.revealed = true; }` ("Recommend RTW 8 to P-012, then Klinik Bogenhausen (stroke unit, ER 62 %). 18 min door to door. Response 5.4 min, target 8 min."). Fill `rec.reasons` with one triage, one or two traffic and one or two coord bullets.
- `approve(rec)`: remove from `recs`. If `rec.amb.reservedBy !== rec.id` or the unit is no longer available (and this is not a diversion), release and `plan()` again. Otherwise `sim.dispatch(rec)`, post coord → you "RTW 8 dispatched to P-012.", then `plan()`.
- `hold(rec)`: remove, release the unit, `p.status = 'waiting'`, `p.holdUntil = sim.t + 180`, post a message, `plan()`.
- `onAccident(acc)`: for every unit driving with a path whose remaining legs include `acc.e`, compute a new route from `amb.loc` to the current destination. If it saves more than 20 s, call `sim.reroute(amb, route)` and post coord → you "Rerouting RTW 6 around Garmischer Straße. Saves 2.4 min."
- `onUnitFree(amb)`: called by sim when a unit becomes available, runs `plan()`.
- `status()`: "3 on mission" style.

## Module: `js/sim.js` (simulation subagent)

`BL.createSim()` returns the world:

- Fields: `t` (starts `BL.START_T`), `speed` (1), `paused` (false), `scenario: { wiesn: false, match: false, snow: false }`, `autoApprove` (true), `ambs`, `patients`, `hospitals`, `stations`, `bus`, `traffic`, `triage`, `coordinator`, `kpi: { responses: [{ resp, target, cat }] }`.
- Construction order: bus (with `() => sim.t`), hospitals and stations as runtime copies (`nodeIdx = BL.NODE[entry.node].i`, `loc = BL.nodeLoc(nodeIdx)`, `x, y` from the node, hospital `baseline` random 0.45..0.75, `load = baseline * capacity`), one ambulance per station (`RTW 1`..`RTW 8`, idle at its station), then `traffic`, `triage`, `coordinator`. Post a coord → you welcome message: "Coordinator online. 8 units at their stations. Triage and traffic agents connected."
- `on(type, fn)` / `emit(type, payload)`. Types: `'toast'` `{ text, kind: 'info'|'good'|'warn' }`, `'patient'` (new patient), `'dispatch'` (rec), `'arrived'` (patient), `'delivered'` (patient), `'scenario'`.
- `step(simSeconds)`: no-op when paused or `simSeconds <= 0`. Sub-steps of at most 5 s. Each sub-step: advance time, spawn calls, move ambulances, run timers, `traffic.tick`, `triage.tick`, hospital load relaxation toward `baseline * capacity` with a 3 hour time constant.
- Call spawning: Poisson. Rate per hour `(7 + 5 * traffic.rush(t)) * (wiesn ? 1.35 : 1) * (snow ? 1.25 : 1)`. First call 30 sim seconds after start so the demo starts moving at once. Case weighted by `weight`, intoxication weight ×4 with wiesn. Location: a random edge weighted by `len * (exp(-dist_to_Marienplatz / 4500) + 0.25)`, with wiesn intoxication calls on edges within 1.2 km of the Wiesn; `t` random 0.1..0.9; display point offset 25 m to a random side perpendicular to the edge.
- `spawnCall({ caseKey, x, y } = {})`: optional case and map point (click to place snaps with `BL.nearestLoc`). Creates the patient (age random within case range, `sceneDur` random within case scene minutes, `call` one of the two sentences), pushes it, `triage.assess(p)`, emits `'patient'`, then `coordinator.plan()`. Returns it.
- Movement: follow `amb.path` legs. Speed on the current edge from `BL.travelTime` logic with the actual factor at `sim.t` and the unit's `siren`. Update `loc`, `x`, `y`, `heading` (edge angle, plus π when `t1 < t0`). On path end call the arrival handler.
- Lifecycle:
  - `dispatch(rec)`: if `rec.divertFrom`, put that patient back (`status 'waiting'`, `amb null`, `queueNoted false`), toast. Unit: `state 'toScene'`, `siren true`, `path rec.route1`, `legIdx 0`, `legPos 0`, `patient`, `hosp`, `reservedBy null`. Patient: `status 'assigned'`, `amb`, `hosp`. Emit `'dispatch'`.
  - Arrival at scene: `state 'onScene'`, `timerEnd = t + p.sceneDur`, patient `status 'onScene'`, `arriveT`, `responseT = t - callT`, push to `kpi.responses`, coord → you message "RTW 8 on scene at P-012 after 5.6 min (target 8 min)." Emit `'arrived'`.
  - Scene timer done: route to the hospital from `amb.loc` (`siren` true unless GREEN, forecast true), `state 'toHospital'`, patient `status 'transport'`.
  - Arrival at hospital: `state 'handover'`, `timerEnd = t + 360`, patient `status 'delivered'`, `doneT`, `hosp.load += 1`, message, emit `'delivered'`.
  - Handover done: route home (no siren), `state 'returning'`, `patient null`, `coordinator.onUnitFree(amb)`.
  - Arrival at station: `state 'idle'`, `path null`.
- `reroute(amb, route)`: replace `path`, reset `legIdx`/`legPos`.
- `jumpTo('HH:MM')`: move to that clock time on the same day, or the next day when it is earlier than now. Shift every stored timestamp (patients, timers, accidents, next call, route depart and arrive) by the same delta so nothing completes instantly. Toast.
- `setScenario(key, on)`: set flag, post a traffic message ("Oktoberfest is on. Expect heavy traffic around the Theresienwiese and more intoxication calls."), emit `'scenario'`.
- `metrics()`: `{ openCalls, freeUnits, totalUnits, avgResponse (seconds or null, last 20), onTargetPct (or null), cityIndex, trend, forecast }`.
- `etaOf(amb)`: `BL.remainingTime(sim, amb)`.
- Patients delivered more than 30 sim minutes ago are dropped from `patients` (keep the last 30 delivered in `sim.history` for the list).

## Module: `js/map.js` and `css/map.css` (map subagent)

`BL.createMap(svgEl, sim)` returns `{ render(nowMs), setTrafficMode(mode), focus(x, y, w), setPlacing(on), onMapClick(fn), onEntityClick(fn), highlightPatient(id), refreshScenario() }`.

- SVG in map metres (`viewBox` in metres). Layers in order: land, Wiesn ground, parks with trees, river (bank then water, about 190 m and 120 m wide), buildings, road casings, road fills, traffic overlay, routes, neighbourhood and park labels, landmarks, stations, hospitals, accidents, patients, ambulances.
- Decoration is generated once with `BL.mulberry32(seed)`: about 1500 small pastel buildings (50..110 m × 40..90 m, corner radius, a soft offset shadow, rotated to the nearest road angle), denser near the centre, never on roads (keep 70 m clear), parks, river (140 m) or the Wiesn. Trees as small two tone circles inside park polygons.
- Roads: one path per road class, `vector-effect: non-scaling-stroke`, round caps and joins. Pixel widths: casing local 6, art 8, ring and hwy 10; fill local 3.5, art 5, ring and hwy 7. Bridges get a slightly darker casing.
- Icons stay a constant screen size: icon groups use `translate(x, y) scale(mpp)` where `mpp` is metres per screen pixel, recomputed on zoom. Labels likewise (font size 12 px equivalent, white halo with `paint-order: stroke`).
- Entities in pixel units inside their scaled groups:
  - Ambulance: top down van about 28 × 14 px, white body, red side stripe, darker cab at the front, a blue and red light bar that blinks while `siren`. Rotated to `heading`. A small unrotated number tag above it coloured by state.
  - Patient: pin, circle r 11 in the priority colour with a white ring and the case emoji, a pulsing halo, hidden while `status` is `transport` or `delivered`. A "pending" patient gets a stronger ripple.
  - Hospital: white rounded square 26 px with a red cross, a small ER load bar under it, short name label.
  - Station: small 16 px garage icon.
  - Accident: a pulsing warning triangle at the edge midpoint.
  - Landmarks: small cute vector drawings (Frauenkirche twin towers with green domes, Olympiaturm, Allianz Arena that glows red during a match, Friedensengel, Chinesischer Turm, Schloss Nymphenburg, Deutsches Museum). Oktoberfest tents and a Ferris wheel on the Wiesn only while `scenario.wiesn`.
- Routes: for units driving with siren, the remaining route as a dashed line (to scene in `--s-scene`, to hospital in `--s-hosp`), dashes flowing forward. The first revealed recommendation (`sim.coordinator.recs.find(r => r.revealed)`) is previewed as a thicker glowing line for both legs with the chosen hospital ringed.
- Traffic overlay modes: `'off'`, `'live'` (factor at `sim.t`), `'forecast'` (factor at `sim.t + 900`, forecast mode). Colours: < 1.3 green, < 1.8 yellow, < 2.5 orange, else red. Redraw every 2 real seconds or on mode or scenario change. Default `'live'`.
- Snow: a light animated snowfall overlay on the map container while `scenario.snow`.
- Pan by dragging, zoom with the wheel around the cursor and with +, − and fit buttons (top right of the map). Zoom limits: width between 2500 m and 1.15 × `BL.MAP_W`. Keep the view aspect equal to the element aspect and handle resize. Initial view fits the whole map.
- A click (pointer moved less than 5 px) calls the `onMapClick` handlers with map coordinates. Clicking an entity calls `onEntityClick(kind, id)` instead.
- Hover tooltip (a positioned div in the map container) for patients, ambulances, hospitals, stations, accidents and landmarks. Example patient: title line "P-012 Suspected stroke", then lines "RED, score 94", "71 years", "RTW 8 en route, 3.2 min".
- `focus(x, y, w)` animates the view over 600 ms.
- `setPlacing(true)` switches to a crosshair cursor.
- Performance: create DOM nodes once per entity and only update attributes per frame.

## Module: `index.html`, `css/app.css`, `js/ui.js` (UI subagent)

- `index.html` is a full document: doctype, `lang="en"`, charset and viewport (`viewport-fit=cover`) metas, `<title>Blaulicht München</title>`, `<meta name="claude:viewport-fit-sides" content="cover">`, the font link, `css/app.css`, `css/map.css`, the scripts in load order. Keep `<!doctype html>`, `<html>`, `<head>`, `</head>`, `<body>`, `</body>`, `</html>` and the charset and viewport metas each on their own line (a publish step strips them).
- Layout: `html, body { height: 100% }`, an app grid with a top bar and a main area. Main: the map card on the left (rounded, fills the space) and a 400 px sidebar on the right. Side gutters `padding-left: max(16px, env(safe-area-inset-left, 0px))` and the right equivalent on the app wrapper. Below 960 px wide, stack: map at 62vh (min 380 px), sidebar below, page scrolls. Never scroll horizontally.
- Top bar: brand (small blue mark and "Blaulicht München", subtitle "Multi-agent ambulance dispatch"), clock ("Tue 07:42" in mono plus the traffic phase chip and a "Jump to" select: 03:00, 07:30, 12:30, 17:15, 22:00), speed segmented control (Pause, 1×, 2×, 4×, 8×), scenario toggles (Oktoberfest, FC Bayern home game, Snowfall) and a "Crash on the Ring" button, an "Auto-approve" switch, and the primary red "New emergency" button. The button opens a popover with a grid of the 12 cases (emoji and label) plus "Random case". Choosing one enters placing mode: a banner on the map "Click the map to place: Suspected stroke" with a Cancel button and a "Random location" button. Esc cancels.
- Map card overlays: traffic layer control top left (Off, Live, In 15 min), legend bottom left (priority colours, unit states), KPI strip bottom centre: Open calls, Free units "5/8", Avg response, On target %, Traffic index "×1.6" with a tiny forecast sparkline of `metrics().forecast`. Toasts top centre.
- Sidebar, top to bottom:
  1. Agent network card. A small SVG diagram: 112 Intake → Triage agent and Traffic agent → Coordinator → You, plus a dashed ghost node "Next agent" to show it is extensible. Each node shows its name and `status()`. When a chat message is shown, a dot in the sender colour travels along the link from sender to receiver.
  2. Recommendation card. Shows the first revealed recommendation: patient line (priority pill, emoji, label, id, street and area), a three stop journey RTW 8 (Wache Bogenhausen) → 5.4 min → patient → 9.8 min → Klinik Bogenhausen, a proportional timeline bar (drive, on scene, transport), the reasons as bullets marked with the agent colour, the alternative ("Next best: RTW 1, 7.9 min"), a diversion warning when `divertFrom` is set, buttons "Dispatch RTW 8" and "Hold", and "+2 more waiting" when more are revealed. With auto-approve on, a countdown bar that runs `remainingMs` down while not paused, then `sim.coordinator.approve(rec)`. Empty state: "All calls are covered. The next recommendation appears here."
  3. Tabs: "Agent chat", "Calls (n)", "Fleet", "Hospitals". Chat: bubbles with agent avatar (small coloured rounded square with a simple inline SVG icon), "Triage agent → Coordinator", sim time, text. New messages are shown one at a time with at least 450 ms between them (120 ms when more than 6 are waiting). Call `msg.onShow` when shown. Auto scroll unless the user scrolled up. Keep the last 150. Calls: open calls by score with priority stripe, emoji, label, id, area, waited minutes, status chip and ETA, then "Completed" with the last 6. Clicking a call focuses the map on it. Fleet: one row per unit with state chip and task. Hospitals: name, capability chips (`BL.CAP_LABEL`), ER load bar with percent, and a footnote "Capabilities are simplified for this simulation."
- Main loop in `ui.js`: `requestAnimationFrame`, real dt clamped to 0.1 s, `sim.step(dt * BL.SIM_RATE * sim.speed)`, `map.render(now)`, UI updates. Lists and KPIs re-render at most 4 times per second.
- Keyboard: Space toggles pause, N opens the emergency popover, Esc closes popovers and placing mode.
- Accessible: buttons are real buttons, visible focus rings, `aria-pressed` on toggles, `prefers-reduced-motion` stops pulses and dash flow.

## Change 1: scenario picker (overrides the scenario parts above)

Scenarios are data in `js/data.js`: `BL.SCENARIOS` (array) and `BL.SCENARIO[id]`. Ids: `normal`, `marathon`, `christmas`, `match`, `wiesn`. Each has `{ id, name, icon, tagline, startTime ('HH:MM' or null), callRate, crowdCallShare, caseBoost {caseKey: multiplier}, typeLoad, hotspots, closures (Set of edge indexes), spill, crowds [{ name, x, y, people, radius }], people (total), briefing { traffic, triage } }`.

Helpers: `BL.scenarioEdgeEffect(def, edge)` returns `{ load, closed }`. `BL.CLOSURE_FACTOR = 30`. `BL.pickCrowd(def, Math.random)` picks a crowd weighted by people. `BL.crowdAt(def, x, y)` returns the crowd near a point or null.

- `sim.scenario` becomes `{ id: 'normal', snow: false }`. `sim.activeScenario()` returns `BL.SCENARIO[sim.scenario.id]`.
- `sim.setScenario(id)`: sets the id, jumps the clock to `startTime` when it is set (via `jumpTo`), posts `def.briefing.traffic` from traffic to coord and `def.briefing.triage` from triage to coord, emits `'scenario'`, toasts. `sim.setSnow(on)` toggles snow (traffic message), emits `'scenario'`.
- Traffic agent `factor`: replace the wiesn and match event loads with `BL.scenarioEdgeEffect(sim.activeScenario(), edge)`. Add `load`. When `closed`, return `max(f, BL.CLOSURE_FACTOR)`. Snow stays a ×1.35 multiplier from `sim.scenario.snow`. `closedRoads()` returns the names of closed roads for messages. When a route crosses a closed edge, mention it.
- Sim call spawning: rate times `def.callRate` (and 1.25 with snow). Case weights times `def.caseBoost[key]` (default 1). With probability `def.crowdCallShare` the call spawns on the edge nearest to a random point inside `BL.pickCrowd(def, Math.random)` (within its radius). Store `p.crowd = crowd.name` when `BL.crowdAt` finds one.
- Map: draw scenario crowds as soft translucent heat circles (radius from the data, colour by scenario) with a constant size label "25,000 people" and the crowd name in the tooltip. Draw closed roads as a red and white dashed overlay with small barrier icons at their midpoints. Arena glows when `match`, Wiesn tents and Ferris wheel when `wiesn`, small Christmas trees and market stalls at the crowd points when `christmas`, a finish arch at the first marathon crowd when `marathon`. Snow overlay from `sim.scenario.snow`.
- UI: replace the three scenario toggles with a "Scenario" picker button showing the active scenario icon and name. It opens a popover with one card per scenario: icon, name, tagline, and three facts (people from `def.people` formatted with thousands separators, closed roads count from `def.closures.size`, call volume `×1.3`), plus the typical start time. Selecting calls `sim.setScenario(id)`. Keep a separate "Snowfall" toggle (`sim.setSnow`) and the "Crash on the Ring" button.

