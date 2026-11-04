'use strict';

/*
 * Client for the Claude powered agents served by server.py.
 * The page learns from js/config.js whether server.py is serving it and has
 * an API key. Opened as a file or on another static server, the client stays
 * disabled and the agents run on their rules alone.
 */
window.BL = window.BL || {};

(function (BL) {
  const TIMEOUT_MS = 25000;

  const llm = {
    enabled: false,
    model: null,
    label: 'Claude',
    pending: 0,
    listeners: [],
    init,
    triage: (brief) => ask('/api/llm/triage', brief),
    dispatch: (brief) => ask('/api/llm/dispatch', brief),
    onChange(fn) {
      this.listeners.push(fn);
      fn(this);
    }
  };

  function notify() {
    llm.listeners.forEach((fn) => fn(llm));
  }

  function init() {
    const config = BL.serverConfig || {};
    llm.enabled = Boolean(config.modelServer && config.enabled);
    llm.model = config.model || null;
    llm.label = config.label || 'Claude';
    notify();
  }

  async function ask(path, brief) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
    llm.pending += 1;
    notify();
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(brief),
        signal: controller.signal
      });
      const answer = await response.json();
      if (!response.ok) throw new Error(answer.error || `Status ${response.status}`);
      return answer;
    } finally {
      window.clearTimeout(timer);
      llm.pending -= 1;
      notify();
    }
  }

  BL.llm = llm;
})(window.BL);
