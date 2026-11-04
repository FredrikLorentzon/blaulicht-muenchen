'use strict';

/*
 * App shell and control room sidebar for Blaulicht München.
 * Owns the main loop, the top bar controls, the map overlays and the sidebar cards.
 */
window.BL = window.BL || {};

(function (BL) {
  const SLOW_UPDATE_MS = 250;
  const CHAT_GAP_MS = 450;
  const CHAT_GAP_FAST_MS = 120;
  const CHAT_BACKLOG = 6;
  const CHAT_LIMIT = 150;
  const DOT_TRAVEL_MS = 750;
  const TOAST_MS = 3600;
  const TOAST_LIMIT = 3;
  const FOCUS_WIDTH_M = 3200;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const ICON_PATHS = {
    intake: '<path d="M4.2 2.5h2l1 2.6-1.3 1a7 7 0 0 0 3.9 3.9l1-1.3 2.6 1v2a1.3 1.3 0 0 1-1.4 1.3A10.5 10.5 0 0 1 2.9 3.9 1.3 1.3 0 0 1 4.2 2.5z"/>',
    triage: '<path d="M1.5 8.5h3l1.5-4 2.5 8 2-5.5 1 1.5h3"/>',
    traffic: '<rect x="5" y="1.5" width="6" height="13" rx="3"/><circle cx="8" cy="5" r="1" fill="#fff"/><circle cx="8" cy="8" r="1" fill="#fff"/><circle cx="8" cy="11" r="1" fill="#fff"/>',
    coord: '<circle cx="8" cy="8.5" r="2.2"/><circle cx="3" cy="3.5" r="1.4"/><circle cx="13" cy="3.5" r="1.4"/><circle cx="8" cy="14" r="1.1"/><path d="M6.4 7 4 4.6M9.6 7 12 4.6M8 10.7v2.2"/>',
    you: '<circle cx="8" cy="5.5" r="2.6"/><path d="M3 14c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3"/>',
    plus: '<path d="M8 4v8M4 8h8"/>'
  };

  const AGENTS = {
    intake: { name: '112 Intake', short: '112 Intake', color: 'var(--a-intake)' },
    triage: { name: 'Triage agent', short: 'Triage', color: 'var(--a-triage)' },
    traffic: { name: 'Traffic agent', short: 'Traffic', color: 'var(--a-traffic)' },
    coord: { name: 'Coordinator', short: 'Coordinator', color: 'var(--a-coord)' },
    you: { name: 'You', short: 'You', color: 'var(--a-you)' }
  };

  const NETWORK_LAYOUT = {
    intake: { x: 46, y: 72 },
    triage: { x: 140, y: 30 },
    traffic: { x: 140, y: 120 },
    coord: { x: 234, y: 72 },
    you: { x: 326, y: 40 }
  };
  const NETWORK_GHOST = { x: 326, y: 124 };
  const NETWORK_LINKS = [['intake', 'triage'], ['triage', 'coord'], ['traffic', 'coord'], ['coord', 'you']];
  const NODE_W = 84;
  const NODE_H = 52;

  const UNIT_STATES = {
    idle: { label: 'Free', color: 'var(--s-idle)' },
    toScene: { label: 'To scene', color: 'var(--s-scene)' },
    onScene: { label: 'On scene', color: 'var(--s-onscene)' },
    toHospital: { label: 'To hospital', color: 'var(--s-hosp)' },
    handover: { label: 'Handover', color: 'var(--s-hand)' },
    returning: { label: 'Returning', color: 'var(--s-return)' }
  };

  const CALL_STATES = {
    waiting: { label: 'Waiting', color: 'var(--p-orange)' },
    pending: { label: 'Proposed', color: 'var(--signal)' },
    assigned: { label: 'En route', color: 'var(--s-scene)' },
    onScene: { label: 'On scene', color: 'var(--s-onscene)' },
    transport: { label: 'To hospital', color: 'var(--s-hosp)' },
    delivered: { label: 'Delivered', color: 'var(--s-hand)' }
  };

  const PRIORITY_COLOR = { RED: 'var(--p-red)', ORANGE: 'var(--p-orange)', YELLOW: 'var(--p-yellow)', GREEN: 'var(--p-green)' };
  const PRIORITY_SOFT = { RED: '#FCE7E7', ORANGE: '#FDEEDF', YELLOW: '#FBF3D6', GREEN: '#E2F3EA' };

  const CHECK_SVG = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5 8.5 14l7-8"/></svg>';

  const state = {
    sim: null,
    map: null,
    lastFrame: 0,
    lastSlow: 0,
    chatQueue: [],
    lastChatShown: 0,
    chatPinned: true,
    dots: [],
    netNodes: {},
    netLinks: {},
    netDots: null,
    recId: null,
    recHover: false,
    placing: null,
    activeTab: 'chat',
    lastCallCount: 0,
    rowRefs: new WeakMap()
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function iconSvg(key) {
    return `<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[key]}</svg>`;
  }

  function agentOf(id) {
    return AGENTS[id] || { name: String(id), short: String(id), color: 'var(--muted)' };
  }

  function minutes(seconds) {
    return (Math.max(0, seconds) / 60).toFixed(1);
  }

  function stationShort(name) {
    return name.replace(/^Rettungswache\s+/, 'Wache ').replace(/^Feuerwache\s+\d+\s+/, 'Wache ');
  }

  function formatPeople(n) {
    return Number(n).toLocaleString('en-US');
  }

  function svgEl(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    if (parent) parent.appendChild(el);
    return el;
  }

  function isTypingTarget(target) {
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }

  /* Boot */

  function createSimCapturingMessages(onMessage) {
    const createBus = BL.createBus;
    let attached = false;
    BL.createBus = function captureBus(getTime) {
      const bus = createBus(getTime);
      bus.subscribe(onMessage);
      attached = true;
      return bus;
    };
    let sim;
    try {
      sim = BL.createSim();
    } finally {
      BL.createBus = createBus;
    }
    if (!attached) sim.bus.subscribe(onMessage);
    return sim;
  }

  function boot() {
    state.sim = createSimCapturingMessages((msg) => state.chatQueue.push(msg));
    if (typeof state.sim.announce === 'function') state.sim.announce();
    state.map = BL.createMap($('map'), state.sim);
    BL.createPatientDrag({ stage: $('mapStage'), sim: state.sim, map: state.map });
    bindModelBadge($('modelBadge'));
    BL.llm.init();
    buildNetwork();
    buildCaseGrid();
    buildScenarioList();
    bindTopBar();
    bindMapOverlays();
    bindRecommendation();
    bindTabs();
    bindChat();
    bindKeyboard();
    bindSimEvents();
    if (window.matchMedia('(max-width: 600px)').matches) $('legend').open = false;
    syncControls();
    slowUpdate();
    requestAnimationFrame((now) => {
      state.lastFrame = now;
      requestAnimationFrame(frame);
    });
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const { sim, map } = state;
    const dt = Math.min(0.1, Math.max(0, (now - state.lastFrame) / 1000));
    state.lastFrame = now;
    sim.step(dt * BL.SIM_RATE * sim.speed);
    map.render(now);
    pumpChat(now);
    animateNetwork(now);
    updateRecommendation(dt * 1000);
    if (now - state.lastSlow >= SLOW_UPDATE_MS) {
      state.lastSlow = now;
      slowUpdate();
    }
  }

  function slowUpdate() {
    updateClock();
    updateKpis();
    updateNetworkStatus();
    updateCallsCount();
    renderActivePanel();
  }

  /* Top bar */

  function bindTopBar() {
    const { sim } = state;
    $('speedControl').addEventListener('click', (event) => {
      const button = event.target.closest('[data-speed]');
      if (button) setSpeed(button.dataset.speed);
    });
    $('jumpSelect').addEventListener('change', (event) => {
      if (event.target.value) sim.jumpTo(event.target.value);
      event.target.value = '';
    });
    $('snowToggle').addEventListener('click', () => sim.setSnow(!sim.scenario.snow));
    $('crashButton').addEventListener('click', crashOnTheRing);
    $('autoApproveSwitch').addEventListener('click', () => {
      sim.autoApprove = !sim.autoApprove;
      syncControls();
    });
    $('emergencyButton').addEventListener('click', () => togglePopover('emergency'));
    $('scenarioButton').addEventListener('click', () => togglePopover('scenario'));
    document.addEventListener('pointerdown', closePopoversOnOutsideClick);
  }

  function setSpeed(value) {
    const { sim } = state;
    if (value === 'pause') {
      sim.paused = !sim.paused;
    } else {
      sim.speed = Number(value);
      sim.paused = false;
    }
    syncControls();
  }

  function crashOnTheRing() {
    const ring = BL.EDGES.filter((e) => e.type === 'ring');
    state.sim.traffic.addAccident(ring[Math.floor(Math.random() * ring.length)].i);
  }

  function syncControls() {
    const { sim } = state;
    $('app').classList.toggle('is-paused', sim.paused);
    document.querySelectorAll('#speedControl [data-speed]').forEach((button) => {
      const pressed = button.dataset.speed === 'pause' ? sim.paused : Number(button.dataset.speed) === sim.speed;
      button.setAttribute('aria-pressed', String(pressed));
    });
    const pause = document.querySelector('[data-speed="pause"]');
    pause.setAttribute('aria-label', sim.paused ? 'Resume' : 'Pause');
    $('autoApproveSwitch').setAttribute('aria-checked', String(sim.autoApprove));
    $('snowToggle').setAttribute('aria-pressed', String(Boolean(sim.scenario.snow)));
    syncScenario();
  }

  function activeScenario() {
    return BL.SCENARIO[state.sim.scenario.id] || BL.SCENARIOS[0];
  }

  function syncScenario() {
    const def = activeScenario();
    $('scenarioIcon').textContent = def.icon;
    $('scenarioName').textContent = def.name;
    document.querySelectorAll('.scenario-card').forEach((card) => {
      card.setAttribute('aria-pressed', String(card.dataset.scenario === def.id));
    });
  }

  function updateClock() {
    const { sim } = state;
    const clock = BL.fmtClock(sim.t);
    $('clockTime').textContent = `${clock.day} ${clock.hm}`;
    $('phaseChip').textContent = sim.traffic.phaseLabel(sim.t);
  }

  /* Popovers */

  const POPOVERS = {
    emergency: { button: 'emergencyButton', panel: 'emergencyPopover' },
    scenario: { button: 'scenarioButton', panel: 'scenarioPopover' }
  };

  function togglePopover(key) {
    const open = $(POPOVERS[key].panel).hidden;
    closePopovers();
    if (open) openPopover(key);
  }

  function openPopover(key) {
    const { button, panel } = POPOVERS[key];
    $(panel).hidden = false;
    $(button).setAttribute('aria-expanded', 'true');
    const first = $(panel).querySelector('button');
    if (first) first.focus();
  }

  function closePopovers() {
    let closed = false;
    Object.values(POPOVERS).forEach(({ button, panel }) => {
      if (!$(panel).hidden) closed = true;
      $(panel).hidden = true;
      $(button).setAttribute('aria-expanded', 'false');
    });
    return closed;
  }

  function closePopoversOnOutsideClick(event) {
    const inside = Object.values(POPOVERS).some(({ button, panel }) => $(button).contains(event.target) || $(panel).contains(event.target));
    if (!inside) closePopovers();
  }

  function buildCaseGrid() {
    const grid = $('caseGrid');
    (BL.CASES || []).forEach((c) => grid.appendChild(caseButton(c.key, c.emoji, c.label)));
    const random = caseButton('', '🎲', 'Random case');
    random.classList.add('case-random');
    grid.appendChild(random);
    grid.addEventListener('click', (event) => {
      const button = event.target.closest('[data-case]');
      if (!button) return;
      closePopovers();
      startPlacing(button.dataset.case || null, button.dataset.label);
    });
  }

  function caseButton(key, emoji, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'case-btn';
    button.dataset.case = key;
    button.dataset.label = label;
    button.innerHTML = `<span class="case-emoji" aria-hidden="true">${emoji}</span><span>${escapeHtml(label)}</span>`;
    return button;
  }

  function buildScenarioList() {
    const list = $('scenarioList');
    BL.SCENARIOS.forEach((def) => list.appendChild(scenarioCard(def)));
    list.addEventListener('click', (event) => {
      const card = event.target.closest('[data-scenario]');
      if (!card) return;
      closePopovers();
      state.sim.setScenario(card.dataset.scenario);
      syncControls();
    });
  }

  function scenarioCard(def) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'scenario-card';
    card.dataset.scenario = def.id;
    const closed = def.closures.size;
    const facts = [
      `${formatPeople(def.people)} people`,
      `${closed} closed ${closed === 1 ? 'road' : 'roads'}`,
      `Calls ×${def.callRate}`,
      def.startTime ? `Starts ${def.startTime}` : 'Any time'
    ];
    card.innerHTML = `<span class="scenario-card-icon" aria-hidden="true">${def.icon}</span>
      <span class="row-main">
        <span class="scenario-card-name">${escapeHtml(def.name)}</span>
        <span class="scenario-card-tagline">${escapeHtml(def.tagline)}</span>
        <span class="scenario-facts">${facts.map((f) => `<span class="cap-chip">${escapeHtml(f)}</span>`).join('')}</span>
      </span>`;
    return card;
  }

  /* Placing a new emergency */

  function startPlacing(caseKey, label) {
    state.placing = { caseKey };
    state.map.setPlacing(true);
    $('placingText').textContent = `Click the map to place: ${label}`;
    $('placingBanner').hidden = false;
  }

  function stopPlacing() {
    if (!state.placing) return false;
    state.placing = null;
    state.map.setPlacing(false);
    $('placingBanner').hidden = true;
    return true;
  }

  function bindModelBadge(badge) {
    BL.llm.onChange((llm) => {
      badge.classList.toggle('is-live', llm.enabled);
      badge.classList.toggle('is-thinking', llm.pending > 0);
      badge.textContent = llm.enabled ? `🧠 ${llm.label}` : '⚙️ Rules';
      badge.title = llm.enabled
        ? `Triage and coordinator agents ask Claude ${llm.label} (${llm.model}), with the rules as fallback`
        : 'Agents run on rules. Put ANTHROPIC_API_KEY in .env and start server.py to use Claude';
    });
  }

  function placeCall(point) {
    const { caseKey } = state.placing;
    stopPlacing();
    state.sim.spawnCall(caseKey ? { caseKey, ...point } : { ...point });
  }

  function handleMapClick(a, b) {
    if (!state.placing) return;
    const point = typeof a === 'object' && a !== null ? { x: a.x, y: a.y } : { x: a, y: b };
    placeCall(point);
  }

  function handleEntityClick(kind, id) {
    const tab = { patient: 'calls', amb: 'fleet', ambulance: 'fleet', unit: 'fleet', hospital: 'hospitals' }[kind];
    if (!tab) return;
    if (kind === 'patient') state.map.highlightPatient(id);
    selectTab(tab);
    renderActivePanel();
    const row = document.querySelector(`#panel-${tab} [data-key="${CSS.escape(id)}"]`);
    if (row) flashRow(row);
  }

  function flashRow(row) {
    row.classList.remove('is-flashing');
    void row.offsetWidth;
    row.classList.add('is-flashing');
    row.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  /* Map overlays */

  function bindMapOverlays() {
    const { map } = state;
    document.querySelectorAll('[data-traffic]').forEach((button) => {
      button.addEventListener('click', () => {
        map.setTrafficMode(button.dataset.traffic);
        document.querySelectorAll('[data-traffic]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      });
    });
    $('placeRandomButton').addEventListener('click', () => placeCall({}));
    $('placeCancelButton').addEventListener('click', stopPlacing);
    map.onMapClick(handleMapClick);
    map.onEntityClick(handleEntityClick);
  }

  function showToast({ text, kind }) {
    const box = $('toasts');
    const toast = document.createElement('div');
    toast.className = `toast toast-${kind || 'info'}`;
    toast.textContent = text;
    box.appendChild(toast);
    while (box.children.length > TOAST_LIMIT) box.firstElementChild.remove();
    setTimeout(() => {
      toast.classList.add('is-leaving');
      setTimeout(() => toast.remove(), 320);
    }, TOAST_MS);
  }

  function updateKpis() {
    const m = state.sim.metrics();
    $('kpiOpen').textContent = m.openCalls;
    $('kpiFree').textContent = `${m.freeUnits}/${m.totalUnits}`;
    setKpi('kpiResponse', m.avgResponse == null ? null : `${minutes(m.avgResponse)} min`);
    setKpi('kpiTarget', m.onTargetPct == null ? null : `${Math.round(m.onTargetPct)}%`);
    $('kpiTraffic').textContent = `×${Number(m.cityIndex).toFixed(1)}`;
    const trend = $('kpiTrend');
    trend.textContent = m.trend;
    trend.className = `kpi-trend is-${m.trend}`;
    drawSparkline(m.forecast || [], m.trend);
  }

  function setKpi(id, text) {
    const el = $(id);
    el.textContent = text == null ? 'No data' : text;
    el.classList.toggle('is-empty', text == null);
  }

  function drawSparkline(points, trend) {
    const svg = $('kpiSparkline');
    if (points.length < 2) return;
    const values = points.map((p) => p.v);
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 56).toFixed(1)} ${(18 - ((v - min) / span) * 16).toFixed(1)}`).join(' ');
    svg.firstElementChild.setAttribute('d', d);
    const color = { rising: '#E07013', easing: 'var(--p-green)' }[trend] || 'var(--muted)';
    svg.style.setProperty('--spark', color);
  }

  /* Agent network */

  function buildNetwork() {
    const svg = $('network');
    const links = svgEl('g', {}, svg);
    state.netDots = svgEl('g', {}, svg);
    const nodes = svgEl('g', {}, svg);
    NETWORK_LINKS.forEach(([a, b]) => {
      const pa = NETWORK_LAYOUT[a];
      const pb = NETWORK_LAYOUT[b];
      state.netLinks[linkKey(a, b)] = svgEl('line', { class: 'net-link', x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y }, links);
    });
    const c = NETWORK_LAYOUT.coord;
    svgEl('line', { class: 'net-link is-ghost', x1: c.x, y1: c.y, x2: NETWORK_GHOST.x, y2: NETWORK_GHOST.y }, links);
    Object.entries(NETWORK_LAYOUT).forEach(([id, pos]) => {
      state.netNodes[id] = buildNetworkNode(nodes, pos, agentOf(id).short, agentOf(id).color, ICON_PATHS[id], false);
    });
    buildNetworkNode(nodes, NETWORK_GHOST, 'Next agent', 'var(--muted)', ICON_PATHS.plus, true).status.textContent = 'Plug in here';
  }

  function buildNetworkNode(parent, pos, name, color, iconPath, ghost) {
    const g = svgEl('g', { class: ghost ? 'net-node net-ghost' : 'net-node', transform: `translate(${pos.x - NODE_W / 2} ${pos.y - NODE_H / 2})` }, parent);
    g.style.setProperty('--c', color);
    svgEl('rect', { class: 'net-ring', width: NODE_W, height: NODE_H, rx: 13 }, g);
    svgEl('rect', { class: 'net-node-card', width: NODE_W, height: NODE_H, rx: 13 }, g);
    const icon = svgEl('svg', { x: NODE_W / 2 - 10, y: 5, width: 20, height: 20, viewBox: '0 0 20 20' }, g);
    const badge = svgEl('rect', { width: 20, height: 20, rx: 6 }, icon);
    badge.style.fill = ghost ? '#C5D0DE' : color;
    const glyph = svgEl('svg', { x: 3, y: 3, width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: '#fff', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, icon);
    glyph.innerHTML = iconPath;
    const label = svgEl('text', { class: 'net-name', x: NODE_W / 2, y: 38, 'text-anchor': 'middle' }, g);
    label.textContent = name;
    const status = svgEl('text', { class: 'net-status', x: NODE_W / 2, y: 48, 'text-anchor': 'middle' }, g);
    return { g, status };
  }

  function linkKey(a, b) {
    return [a, b].sort().join('|');
  }

  function pingNode(id) {
    const node = state.netNodes[id];
    if (!node) return;
    node.g.classList.remove('is-pinged');
    void node.g.getBoundingClientRect();
    node.g.classList.add('is-pinged');
  }

  function signalNetwork(from, to) {
    pingNode(from);
    const link = state.netLinks[linkKey(from, to)];
    if (link) {
      link.style.setProperty('--c', agentOf(from).color);
      link.classList.add('is-active');
      setTimeout(() => link.classList.remove('is-active'), DOT_TRAVEL_MS + 200);
    }
    const a = NETWORK_LAYOUT[from];
    const b = NETWORK_LAYOUT[to];
    if (!a || !b || reducedMotion.matches) {
      pingNode(to);
      return;
    }
    const g = svgEl('g', {}, state.netDots);
    const halo = svgEl('circle', { class: 'net-dot-halo', r: 9 }, g);
    const core = svgEl('circle', { r: 4.5, stroke: '#fff', 'stroke-width': 1.5 }, g);
    halo.style.fill = agentOf(from).color;
    core.style.fill = agentOf(from).color;
    state.dots.push({ g, a, b, to, start: performance.now() });
  }

  function animateNetwork(now) {
    state.dots = state.dots.filter((dot) => {
      const p = Math.min(1, Math.max(0, (now - dot.start) / DOT_TRAVEL_MS));
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      dot.g.setAttribute('transform', `translate(${dot.a.x + (dot.b.x - dot.a.x) * e} ${dot.a.y + (dot.b.y - dot.a.y) * e})`);
      if (p < 1) return true;
      dot.g.remove();
      pingNode(dot.to);
      return false;
    });
  }

  function trimStatus(text) {
    const s = String(text || '');
    return s.length > 17 ? `${s.slice(0, 16)}…` : s;
  }

  function updateNetworkStatus() {
    const { sim, netNodes } = state;
    const calls = Math.max(0, ...sim.patients.map((p) => p.n), ...sim.history.map((p) => p.n));
    const review = sim.coordinator.recs.filter((r) => r.revealed).length;
    netNodes.intake.status.textContent = calls ? `${calls} ${calls === 1 ? 'call' : 'calls'}` : 'Line open';
    netNodes.triage.status.textContent = trimStatus(sim.triage.status());
    netNodes.traffic.status.textContent = trimStatus(sim.traffic.status());
    netNodes.coord.status.textContent = trimStatus(sim.coordinator.status());
    netNodes.you.status.textContent = review ? `${review} to review` : (sim.autoApprove ? 'Auto-approve' : 'Standing by');
    $('liveBadge').textContent = sim.paused ? 'Paused' : 'Live';
  }

  /* Recommendation card */

  function bindRecommendation() {
    const card = $('recCard');
    card.addEventListener('pointerenter', () => { state.recHover = true; });
    card.addEventListener('pointerleave', () => { state.recHover = false; });
    card.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      const rec = currentRec();
      if (!button || !rec) return;
      if (button.dataset.action === 'dispatch') approveRec(rec);
      else holdRec(rec);
    });
    buildRecCard(null);
  }

  function revealedRecs() {
    return state.sim.coordinator.recs.filter((r) => r.revealed);
  }

  function currentRec() {
    return revealedRecs()[0] || null;
  }

  function approveRec(rec) {
    showStamp(`${CHECK_SVG}${escapeHtml(rec.amb.name)} dispatched`, false);
    state.sim.coordinator.approve(rec);
  }

  function holdRec(rec) {
    showStamp(`${escapeHtml(rec.p.id)} on hold for 3 min`, true);
    state.sim.coordinator.hold(rec);
  }

  function showStamp(html, held) {
    const stamp = $('recStamp');
    stamp.innerHTML = `<span>${html}</span>`;
    stamp.className = held ? 'rec-stamp is-held' : 'rec-stamp';
    void stamp.offsetWidth;
    stamp.classList.add('is-showing');
  }

  function updateRecommendation(dtMs) {
    const { sim } = state;
    const recs = revealedRecs();
    const rec = recs[0] || null;
    if ((rec ? rec.id : null) !== state.recId) {
      state.recId = rec ? rec.id : null;
      buildRecCard(rec);
    }
    const more = $('recMore');
    more.hidden = recs.length < 2;
    more.textContent = `+${recs.length - 1} more waiting`;
    $('countdownTrack').classList.toggle('is-idle', !rec || !sim.autoApprove);
    if (!rec) return;
    if (rec.remainingMs == null) rec.remainingMs = BL.AUTO_APPROVE_MS;
    const holding = sim.paused || state.recHover;
    if (sim.autoApprove && !holding) rec.remainingMs = Math.max(0, rec.remainingMs - dtMs);
    $('countdownFill').style.transform = `scaleX(${rec.remainingMs / BL.AUTO_APPROVE_MS})`;
    updateCountdownLabel(rec, holding);
    if (sim.autoApprove && rec.remainingMs <= 0) approveRec(rec);
  }

  function updateCountdownLabel(rec, holding) {
    const label = document.querySelector('#recBody .countdown-label');
    if (!label) return;
    let text = `Auto in ${(rec.remainingMs / 1000).toFixed(1)} s`;
    if (!state.sim.autoApprove) text = 'Your call';
    else if (state.sim.paused) text = 'Paused';
    else if (holding) text = 'Paused while you read';
    label.textContent = text;
    label.classList.toggle('is-hold', !state.sim.autoApprove || holding);
  }

  function buildRecCard(rec) {
    const body = $('recBody');
    body.innerHTML = rec ? recHtml(rec) : emptyRecHtml();
    body.classList.remove('is-entering');
    void body.offsetWidth;
    body.classList.add('is-entering');
  }

  function emptyRecHtml() {
    return `<div class="rec-empty"><span class="rec-empty-icon">${CHECK_SVG}</span><p>All calls are covered. The next recommendation appears here.</p></div>`;
  }

  function recHtml(rec) {
    const { sim } = state;
    const p = rec.p;
    const prio = BL.PRIORITY[p.cat] || BL.PRIORITY.GREEN;
    const drive = rec.route1.duration;
    const scene = rec.sceneDur != null ? rec.sceneDur : p.sceneDur;
    const ride = rec.route2 ? rec.route2.duration : 0;
    const total = Math.max(1, drive + scene + ride);
    const waited = Math.max(0, sim.t - p.callT);
    const late = waited + drive > prio.target;
    const targetPos = Math.max(0, Math.min(100, ((prio.target - waited) / total) * 100));
    const erPct = Math.round((rec.hosp.load / rec.hosp.capacity) * 100);
    const reasons = (rec.reasons || []).slice(0, 3).map((r) => {
      const agent = agentOf(r.agent);
      return `<li class="reason" style="--c: ${agent.color}"><span class="reason-tag">${escapeHtml(agent.short)}</span><span>${escapeHtml(r.text)}</span></li>`;
    }).join('');
    const alt = rec.alt ? `Next best: ${escapeHtml(rec.alt.amb.name)}, ${minutes(rec.alt.route.duration)} min` : 'No other unit free';
    const divert = rec.divertFrom
      ? `<p class="rec-divert">Diverts ${escapeHtml(rec.amb.name)} from ${escapeHtml(rec.divertFrom.id)} (${escapeHtml(rec.divertFrom.cat)}). ${escapeHtml(rec.divertFrom.id)} goes back to the queue.</p>`
      : '';
    const style = `--pc: ${PRIORITY_COLOR[p.cat] || 'var(--p-green)'}; --pc-soft: ${PRIORITY_SOFT[p.cat] || '#E2F3EA'}`;
    return `
      <div class="rec-patient" style="${style}">
        <span class="rec-emoji" aria-hidden="true">${p.emoji}</span>
        <div class="rec-patient-text">
          <p class="rec-title"><span class="rec-title-text">${escapeHtml(p.label)}</span><span class="pill pill-${escapeHtml(p.cat)}">${escapeHtml(p.cat)}</span></p>
          <p class="rec-place"><span class="mono">${escapeHtml(p.id)}</span> ${escapeHtml(p.street)}, ${escapeHtml(p.area)}</p>
        </div>
        <div class="rec-score"><span class="rec-score-value">${Math.round(p.score)}</span><span class="rec-score-label">Score</span></div>
      </div>
      <ol class="journey" style="${style}" aria-label="Journey">
        <li class="stop"><span class="stop-icon" aria-hidden="true">🚑</span><span class="stop-name">${escapeHtml(rec.amb.name)}</span><span class="stop-sub">${escapeHtml(stationShort(rec.amb.station.name))}</span></li>
        <li class="leg" style="--c: var(--s-scene)"><span class="leg-time">${minutes(drive)} min</span></li>
        <li class="stop stop-patient"><span class="stop-icon" aria-hidden="true">${p.emoji}</span><span class="stop-name">${escapeHtml(p.id)}</span><span class="stop-sub">⏱️ ${minutes(scene)} min</span></li>
        <li class="leg" style="--c: var(--s-hosp)"><span class="leg-time">${minutes(ride)} min</span></li>
        <li class="stop"><span class="stop-icon" aria-hidden="true">🏥</span><span class="stop-name">${escapeHtml(rec.hosp.short)}</span><span class="stop-sub">ER ${erPct}%</span></li>
      </ol>
      <div class="timeline">
        <div class="timeline-bar" role="img" aria-label="Drive ${minutes(drive)} min, on scene ${minutes(scene)} min, transport ${minutes(ride)} min, target ${prio.target / 60} min">
          <span class="seg" style="flex: ${drive}; --c: var(--s-scene)"></span>
          <span class="seg" style="flex: ${scene}; --c: var(--s-onscene)"></span>
          <span class="seg" style="flex: ${ride}; --c: var(--s-hosp)"></span>
          <span class="target-mark${late ? ' is-late' : ''}" style="left: ${targetPos}%"></span>
        </div>
        <div class="timeline-legend">
          <span class="key key-target" style="--c: ${late ? 'var(--p-red)' : 'var(--ink)'}" title="Target response time">🎯 ${prio.target / 60} min</span>
          <span class="total">${Math.round(total / 60)} min total</span>
        </div>
      </div>
      <ul class="reasons">${reasons}</ul>
      ${divert}
      <div class="rec-foot"><span class="rec-alt">${alt}</span><span class="countdown-label"></span></div>
      <div class="rec-actions">
        <button type="button" class="btn btn-primary" data-action="dispatch">Dispatch ${escapeHtml(rec.amb.name)}</button>
        <button type="button" class="btn btn-secondary" data-action="hold">Hold</button>
      </div>`;
  }

  /* Tabs */

  const TABS = ['chat', 'calls', 'fleet', 'hospitals'];

  function bindTabs() {
    TABS.forEach((tab, index) => {
      const button = $(`tab-${tab}`);
      button.addEventListener('click', () => {
        selectTab(tab);
        renderActivePanel();
      });
      button.addEventListener('keydown', (event) => {
        const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        const next = TABS[(index + step + TABS.length) % TABS.length];
        selectTab(next);
        renderActivePanel();
        $(`tab-${next}`).focus();
      });
    });
  }

  function selectTab(tab) {
    state.activeTab = tab;
    TABS.forEach((t) => {
      const selected = t === tab;
      $(`tab-${t}`).setAttribute('aria-selected', String(selected));
      $(`tab-${t}`).tabIndex = selected ? 0 : -1;
      $(`panel-${t}`).hidden = !selected;
    });
    if (tab === 'chat' && state.chatPinned) scrollChatToEnd();
  }

  function renderActivePanel() {
    const render = { calls: renderCalls, fleet: renderFleet, hospitals: renderHospitals }[state.activeTab];
    if (render) render();
  }

  function openCalls() {
    return state.sim.patients.filter((p) => p.status !== 'delivered').sort((a, b) => b.score - a.score);
  }

  function updateCallsCount() {
    const count = openCalls().length;
    const badge = $('callsCount');
    badge.textContent = count;
    if (count > state.lastCallCount) {
      badge.classList.remove('is-bumped');
      void badge.offsetWidth;
      badge.classList.add('is-bumped');
    }
    state.lastCallCount = count;
  }

  /* Keyed list rendering */

  function syncRows(container, items, keyOf, buildRow, fillRow) {
    const rows = new Map([...container.children].map((child) => [child.dataset.key, child]));
    const wanted = new Set();
    items.forEach((item, index) => {
      const key = keyOf(item);
      wanted.add(key);
      let row = rows.get(key);
      if (!row) {
        row = buildRow(item);
        row.dataset.key = key;
      }
      fillRow(row, item);
      if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
    });
    rows.forEach((row, key) => {
      if (!wanted.has(key)) row.remove();
    });
  }

  function makeRow(tag, className, html, refNames) {
    const row = document.createElement(tag);
    if (tag === 'button') row.type = 'button';
    row.className = className;
    row.innerHTML = html;
    const refs = {};
    refNames.forEach((name) => { refs[name] = row.querySelector(`[data-ref="${name}"]`); });
    state.rowRefs.set(row, refs);
    return row;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  const CALL_ROW_HTML = `<span class="row-emoji" data-ref="emoji" aria-hidden="true"></span>
    <span class="row-main"><span class="row-title"><span data-ref="label"></span><span class="mono" data-ref="id"></span></span><span class="row-sub" data-ref="sub"></span></span>
    <span class="row-side"><span class="chip" data-ref="chip"></span><span class="row-eta" data-ref="eta"></span></span>`;
  const CALL_REFS = ['emoji', 'label', 'id', 'sub', 'chip', 'eta'];

  function buildCallRow(p) {
    const row = makeRow('button', 'row call-row', CALL_ROW_HTML, CALL_REFS);
    row.addEventListener('click', () => {
      state.map.focus(p.x, p.y, FOCUS_WIDTH_M);
      state.map.highlightPatient(p.id);
    });
    row.addEventListener('pointerenter', () => state.map.highlightPatient(p.id));
    row.addEventListener('pointerleave', () => state.map.highlightPatient(null));
    return row;
  }

  function buildDoneRow() {
    return makeRow('div', 'row call-row is-done', CALL_ROW_HTML, CALL_REFS);
  }

  function callSummary(p) {
    const { sim } = state;
    if (p.status === 'assigned' && p.amb) {
      const remaining = sim.etaOf(p.amb);
      return { sub: `${p.area}, ${p.amb.name} on the way`, eta: remaining == null ? '' : `ETA ${minutes(remaining)} min` };
    }
    if (p.status === 'onScene' && p.amb) return { sub: `${p.area}, ${p.amb.name} treating`, eta: '' };
    if (p.status === 'transport' && p.hosp) return { sub: `To ${p.hosp.short}`, eta: '' };
    if (p.status === 'delivered') {
      return { sub: p.hosp ? `Delivered to ${p.hosp.short}` : 'Delivered', eta: p.responseT != null ? `${minutes(p.responseT)} min` : '' };
    }
    return { sub: `${p.area}, waited ${Math.floor((sim.t - p.callT) / 60)} min`, eta: '' };
  }

  function fillCallRow(row, p) {
    const refs = state.rowRefs.get(row);
    const status = CALL_STATES[p.status] || CALL_STATES.waiting;
    const summary = callSummary(p);
    row.style.setProperty('--pc', PRIORITY_COLOR[p.cat] || 'var(--muted)');
    setText(refs.emoji, p.emoji);
    setText(refs.label, p.label);
    setText(refs.id, p.id);
    refs.chip.style.setProperty('--c', status.color);
    setText(refs.chip, status.label);
    setText(refs.sub, summary.sub);
    setText(refs.eta, summary.eta);
  }

  function renderCalls() {
    const { sim } = state;
    const open = openCalls();
    syncRows($('callsOpen'), open, (p) => p.id, buildCallRow, fillCallRow);
    $('callsEmpty').hidden = open.length > 0;
    const done = [...new Set([...sim.patients.filter((p) => p.status === 'delivered'), ...sim.history])]
      .sort((a, b) => (b.doneT || 0) - (a.doneT || 0))
      .slice(0, 6);
    syncRows($('callsDone'), done, (p) => p.id, buildDoneRow, fillCallRow);
    $('callsDoneHeading').hidden = done.length === 0;
  }

  function buildFleetRow(amb) {
    const row = makeRow('button', 'row', `<span class="unit-badge" data-ref="badge"></span>
      <span class="row-main"><span class="row-title" data-ref="name"></span><span class="row-sub" data-ref="task"></span></span>
      <span class="row-side"><span class="chip" data-ref="chip"></span><span class="row-eta" data-ref="eta"></span></span>`, ['badge', 'name', 'task', 'chip', 'eta']);
    row.addEventListener('click', () => state.map.focus(amb.x, amb.y, FOCUS_WIDTH_M));
    return row;
  }

  function unitTask(amb) {
    const p = amb.patient;
    const home = stationShort(amb.station.name);
    switch (amb.state) {
      case 'toScene': return p ? `To ${p.id} in ${p.area}` : 'To scene';
      case 'onScene': return p ? `Treating ${p.id}, ${p.label}` : 'On scene';
      case 'toHospital': return p && amb.hosp ? `${p.id} to ${amb.hosp.short}` : 'To hospital';
      case 'handover': return amb.hosp ? `Handover at ${amb.hosp.short}` : 'Handover';
      case 'returning': return amb.reservedBy ? 'Proposed for a new call' : `Back to ${home}`;
      default: return amb.reservedBy ? 'Proposed for a new call' : `Ready at ${home}`;
    }
  }

  function unitEta(amb) {
    const { sim } = state;
    if (['toScene', 'toHospital', 'returning'].includes(amb.state)) {
      const remaining = sim.etaOf(amb);
      return remaining == null ? '' : `ETA ${minutes(remaining)} min`;
    }
    if (['onScene', 'handover'].includes(amb.state) && amb.timerEnd) return `${minutes(amb.timerEnd - sim.t)} min left`;
    return '';
  }

  function fillFleetRow(row, amb) {
    const refs = state.rowRefs.get(row);
    const info = UNIT_STATES[amb.state] || UNIT_STATES.idle;
    refs.badge.style.setProperty('--c', info.color);
    setText(refs.badge, String(amb.n));
    setText(refs.name, amb.name);
    setText(refs.task, unitTask(amb));
    refs.chip.style.setProperty('--c', amb.reservedBy ? 'var(--signal)' : info.color);
    setText(refs.chip, amb.reservedBy ? 'Reserved' : info.label);
    setText(refs.eta, unitEta(amb));
  }

  function renderFleet() {
    syncRows($('fleetList'), state.sim.ambs, (a) => a.id, buildFleetRow, fillFleetRow);
  }

  function buildHospitalRow(h) {
    const chips = h.caps.map((c) => `<span class="cap-chip">${escapeHtml(BL.CAP_LABEL[c] || c)}</span>`).join('');
    return makeRow('div', 'row hospital-row', `<div class="hospital-head"><span class="hospital-name">${escapeHtml(h.name)}</span><span class="hospital-pct" data-ref="pct"></span></div>
      <div class="cap-chips">${chips}</div>
      <div class="load-bar"><span class="load-fill" data-ref="fill"></span></div>`, ['pct', 'fill']);
  }

  function fillHospitalRow(row, h) {
    const refs = state.rowRefs.get(row);
    const ratio = h.load / h.capacity;
    const color = ratio < 0.6 ? 'var(--p-green)' : ratio < 0.85 ? 'var(--p-yellow)' : 'var(--p-red)';
    setText(refs.pct, `ER ${Math.round(ratio * 100)}%`);
    refs.fill.style.width = `${Math.min(100, ratio * 100)}%`;
    refs.fill.style.setProperty('--c', color);
  }

  function renderHospitals() {
    syncRows($('hospitalList'), state.sim.hospitals, (h) => h.id, buildHospitalRow, fillHospitalRow);
  }

  /* Chat */

  function bindChat() {
    const log = $('chatLog');
    log.addEventListener('scroll', () => {
      state.chatPinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      if (state.chatPinned) $('newMessages').hidden = true;
    });
    $('newMessages').addEventListener('click', () => {
      state.chatPinned = true;
      scrollChatToEnd();
    });
  }

  function scrollChatToEnd() {
    const log = $('chatLog');
    log.scrollTop = log.scrollHeight;
    $('newMessages').hidden = true;
  }

  function pumpChat(now) {
    if (!state.chatQueue.length) return;
    const gap = state.chatQueue.length > CHAT_BACKLOG ? CHAT_GAP_FAST_MS : CHAT_GAP_MS;
    if (now - state.lastChatShown < gap) return;
    state.lastChatShown = now;
    showMessage(state.chatQueue.shift());
  }

  function showMessage(msg) {
    const log = $('chatLog');
    log.appendChild(buildBubble(msg));
    while (log.children.length > CHAT_LIMIT) log.firstElementChild.remove();
    if (state.chatPinned) scrollChatToEnd();
    else $('newMessages').hidden = false;
    if (typeof msg.onShow === 'function') msg.onShow();
    signalNetwork(msg.from, msg.to);
  }

  function buildBubble(msg) {
    const from = agentOf(msg.from);
    const li = document.createElement('li');
    li.className = msg.from === 'coord' && msg.to === 'you' ? 'msg to-you' : 'msg';
    li.style.setProperty('--c', from.color);
    const route = msg.to ? `<b>${escapeHtml(from.name)}</b> → ${escapeHtml(agentOf(msg.to).name)}` : `<b>${escapeHtml(from.name)}</b>`;
    const time = msg.t != null ? BL.fmtClock(msg.t).hm : '';
    li.innerHTML = `<span class="avatar">${iconSvg(AGENTS[msg.from] ? msg.from : 'plus')}</span>
      <div class="msg-body"><div class="msg-head"><span class="msg-route">${route}</span><time class="msg-time">${time}</time></div><p class="msg-text"></p></div>`;
    li.querySelector('.msg-text').textContent = msg.text;
    return li;
  }

  /* Keyboard and sim events */

  function isSpaceForPause(event) {
    const target = event.target;
    return event.key === ' ' && !(target instanceof HTMLButtonElement) && !(target instanceof HTMLElement && target.closest('summary'));
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      if (event.key === 'Escape') {
        if (!closePopovers()) stopPlacing();
      } else if (isSpaceForPause(event)) {
        event.preventDefault();
        setSpeed('pause');
      } else if (event.key === 'n' || event.key === 'N') {
        event.preventDefault();
        closePopovers();
        openPopover('emergency');
      }
    });
  }

  function bindSimEvents() {
    const { sim, map } = state;
    sim.on('toast', showToast);
    sim.on('scenario', () => {
      map.refreshScenario();
      syncControls();
    });
  }

  boot();
})(window.BL);
