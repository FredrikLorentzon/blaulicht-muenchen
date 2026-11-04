'use strict';

/*
 * Client for the Claude powered agents served by server.py.
 * Without that server (a static host, or no API key) it stays disabled and
 * the agents run on their rules alone.
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

  async function init() {
    try {
      const response = await fetch('/api/llm/status', { cache: 'no-store' });
      if (!response.ok) return;
      const status = await response.json();
      llm.enabled = Boolean(status.enabled);
      llm.model = status.model || null;
      llm.label = status.label || 'Claude';
    } catch (error) {
      llm.enabled = false;
    }
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
