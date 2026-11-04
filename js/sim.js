'use strict';

/*
 * Simulation core for Blaulicht München.
 * Holds the world state, spawns 112 calls, drives ambulances along their
 * routes and runs the mission lifecycle from dispatch to the return home.
 * Agents are constructed here and reached only through their public API.
 */
window.BL = window.BL || {};

(function (BL) {
  const SUB_STEP_S = 5;
  const FIRST_CALL_DELAY_S = 30;
  const HANDOVER_S = 240;
  const LOAD_TIME_CONSTANT_S = 3 * 3600;
  const DELIVERED_KEEP_S = 30 * 60;
  const HISTORY_SIZE = 30;
  const METRIC_WINDOW = 20;
  const SAFETY_PLAN_INTERVAL_S = 30;
  const PATIENT_OFFSET_M = 25;
  const CENTRE_DECAY_M = 4500;
  const CENTRE_FLOOR = 0.25;
  const SPEED_PROBE_M = 100;
  const SAME_SPOT_M = 1;
  const DAY_S = 86400;
  const MARIENPLATZ = BL.project(48.1374, 11.5755);

  const SNOW_MESSAGES = {
    on: 'Snowfall across the city. Expect every road to be about 35 % slower.',
    off: 'Snowfall has stopped. Roads are back to normal speed.'
  };

  const CENTRE_WEIGHT = BL.EDGES.map((edge) => {
    const distance = Math.hypot(edge.mx - MARIENPLATZ[0], edge.my - MARIENPLATZ[1]);
    return edge.len * (Math.exp(-distance / CENTRE_DECAY_M) + CENTRE_FLOOR);
  });

  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }

  function randomInt(min, max) {
    return Math.floor(randomBetween(min, max + 1));
  }

  function pickOne(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function pickWeighted(items, weightOf) {
    const total = items.reduce((sum, item) => sum + weightOf(item), 0);
    let remaining = Math.random() * total;
    for (const item of items) {
      remaining -= weightOf(item);
      if (remaining <= 0) return item;
    }
    return items[items.length - 1];
  }

  function exponentialDelay(ratePerHour) {
    return (-Math.log(1 - Math.random()) / ratePerHour) * 3600;
  }

  function clamp01(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  function copyLoc(loc) {
    return { e: loc.e, t: clamp01(loc.t) };
  }

  function emptyRoute(t) {
    return { legs: [], depart: t, arrive: t, duration: 0, length: 0 };
  }

  function legLength(leg) {
    return Math.abs(leg.t1 - leg.t0) * BL.EDGES[leg.e].len;
  }

  function legHeading(leg) {
    return BL.EDGES[leg.e].ang + (leg.t1 < leg.t0 ? Math.PI : 0);
  }

  function routeStartPoint(route, fallbackLoc) {
    const first = route.legs[0];
    return BL.pointAt(first ? { e: first.e, t: first.t0 } : fallbackLoc);
  }

  function sideOffsetPoint(loc, side) {
    const [x, y] = BL.pointAt(loc);
    const angle = BL.EDGES[loc.e].ang;
    return [x - Math.sin(angle) * side * PATIENT_OFFSET_M, y + Math.cos(angle) * side * PATIENT_OFFSET_M];
  }

  function sideOfRoad(loc, x, y) {
    const [roadX, roadY] = BL.pointAt(loc);
    const angle = BL.EDGES[loc.e].ang;
    const across = -(x - roadX) * Math.sin(angle) + (y - roadY) * Math.cos(angle);
    return across >= 0 ? 1 : -1;
  }

  function isAvailable(amb) {
    return (amb.state === 'idle' || amb.state === 'returning') && amb.reservedBy === null;
  }

  function priorityOf(patient) {
    return BL.PRIORITY[patient.cat] || BL.PRIORITY.GREEN;
  }

  function patientId(n) {
    return `P-${String(n).padStart(3, '0')}`;
  }

  function runtimeAtNode(entry) {
    const node = BL.NODE[entry.node];
    return { ...entry, nodeIdx: node.i, loc: BL.nodeLoc(node.i), x: node.x, y: node.y };
  }

  function createHospital(entry) {
    const baseline = randomBetween(0.45, 0.75);
    return { ...runtimeAtNode(entry), baseline, load: baseline * entry.capacity };
  }

  function createAmbulance(station, index) {
    const n = index + 1;
    return {
      id: `RTW${n}`,
      n,
      name: `RTW ${n}`,
      station,
      loc: copyLoc(station.loc),
      x: station.x,
      y: station.y,
      heading: BL.EDGES[station.loc.e].ang,
      state: 'idle',
      siren: false,
      path: null,
      legIdx: 0,
      legPos: 0,
      patient: null,
      hosp: null,
      timerEnd: null,
      reservedBy: null
    };
  }

  function createSim() {
    const listeners = {};
    let patientCount = 0;

    const sim = {
      t: BL.START_T,
      speed: 1,
      paused: false,
      scenario: { id: 'normal', snow: false },
      autoApprove: true,
      ambs: [],
      patients: [],
      history: [],
      hospitals: [],
      stations: [],
      bus: null,
      traffic: null,
      triage: null,
      coordinator: null,
      kpi: { responses: [] },
      nextCallT: BL.START_T + FIRST_CALL_DELAY_S,
      nextSafetyPlanT: BL.START_T + SAFETY_PLAN_INTERVAL_S,
      on,
      emit,
      step,
      spawnCall,
      dispatch,
      reroute,
      jumpTo,
      setScenario,
      setSnow,
      activeScenario,
      metrics,
      etaOf
    };

    function on(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
      return function unsubscribe() {
        listeners[type] = listeners[type].filter((listener) => listener !== fn);
      };
    }

    function emit(type, payload) {
      (listeners[type] || []).slice().forEach((listener) => listener(payload));
    }

    function toast(text, kind) {
      emit('toast', { text, kind });
    }

    function post(from, to, text) {
      sim.bus.post({ from, to, text });
    }

    function findRouteOrEmpty(from, to, opts) {
      const route = BL.findRoute(sim, from, to, sim.t, opts);
      return route && Array.isArray(route.legs) ? route : emptyRoute(sim.t);
    }

    function setPath(amb, route) {
      amb.path = route;
      amb.legIdx = 0;
      amb.legPos = 0;
    }

    function placeAt(amb, loc) {
      amb.loc = copyLoc(loc);
      [amb.x, amb.y] = BL.pointAt(amb.loc);
    }

    function step(simSeconds) {
      if (sim.paused || !Number.isFinite(simSeconds) || simSeconds <= 0) return;
      const count = Math.ceil(simSeconds / SUB_STEP_S);
      const dt = simSeconds / count;
      for (let i = 0; i < count; i += 1) subStep(dt);
      pruneDelivered();
    }

    function subStep(dt) {
      sim.t += dt;
      spawnDueCall();
      sim.ambs.forEach((amb) => moveAmbulance(amb, dt));
      runTimers();
      sim.traffic.tick(dt);
      sim.triage.tick(dt);
      relaxHospitalLoads(dt);
      planWhenCapacityIsIdle();
    }

    function activeScenario() {
      return BL.SCENARIO[sim.scenario.id] || BL.SCENARIO.normal;
    }

    function callRatePerHour() {
      const snowBoost = sim.scenario.snow ? 1.25 : 1;
      return (4 + 3 * sim.traffic.rush(sim.t)) * activeScenario().callRate * snowBoost;
    }

    function spawnDueCall() {
      if (sim.t < sim.nextCallT) return;
      spawnCall();
      sim.nextCallT = sim.t + exponentialDelay(callRatePerHour());
    }

    function caseWeight(caseType) {
      return caseType.weight * (activeScenario().caseBoost[caseType.key] || 1);
    }

    function pickCase(caseKey) {
      return BL.CASES.find((caseType) => caseType.key === caseKey) || pickWeighted(BL.CASES, caseWeight);
    }

    function snappedPlacement(x, y) {
      const snapped = BL.nearestLoc(x, y);
      const loc = { e: snapped.e, t: clamp01(snapped.t) };
      return { loc, side: sideOfRoad(loc, x, y) };
    }

    function randomPointInCrowd(crowd) {
      const angle = Math.random() * 2 * Math.PI;
      const distance = crowd.radius * Math.sqrt(Math.random());
      return [crowd.x + Math.cos(angle) * distance, crowd.y + Math.sin(angle) * distance];
    }

    function randomPlacement() {
      const scenario = activeScenario();
      const crowd = Math.random() < scenario.crowdCallShare ? BL.pickCrowd(scenario, Math.random) : null;
      if (crowd) return snappedPlacement(...randomPointInCrowd(crowd));
      const edge = pickWeighted(BL.EDGES, (candidate) => CENTRE_WEIGHT[candidate.i]);
      return { loc: { e: edge.i, t: randomBetween(0.1, 0.9) }, side: Math.random() < 0.5 ? -1 : 1 };
    }

    function callPlacement(x, y) {
      return Number.isFinite(x) && Number.isFinite(y) ? snappedPlacement(x, y) : randomPlacement();
    }

    function crowdNameAt(x, y) {
      const crowd = BL.crowdAt(activeScenario(), x, y);
      return crowd ? crowd.name : null;
    }

    function createPatient(caseType, loc, side) {
      patientCount += 1;
      const [x, y] = sideOffsetPoint(loc, side);
      return {
        id: patientId(patientCount),
        n: patientCount,
        caseKey: caseType.key,
        label: caseType.label,
        emoji: caseType.emoji,
        age: randomInt(caseType.age[0], caseType.age[1]),
        vitals: caseType.vitals(),
        call: pickOne(caseType.calls),
        finding: caseType.finding,
        loc,
        x,
        y,
        street: BL.EDGES[loc.e].name,
        area: BL.nearestNeighborhood(x, y),
        crowd: crowdNameAt(x, y),
        callT: sim.t,
        sceneDur: Math.round(randomBetween(caseType.scene[0], caseType.scene[1]) * 60),
        score: null,
        cat: null,
        need: null,
        reasons: [],
        status: 'waiting',
        amb: null,
        hosp: null,
        rec: null,
        holdUntil: 0,
        queueNoted: false,
        divertTried: false,
        arriveT: null,
        responseT: null,
        doneT: null
      };
    }

    function spawnCall({ caseKey, x, y } = {}) {
      const caseType = pickCase(caseKey);
      const { loc, side } = callPlacement(x, y);
      const patient = createPatient(caseType, loc, side);
      sim.patients.push(patient);
      sim.triage.assess(patient);
      emit('patient', patient);
      sim.coordinator.plan();
      return patient;
    }

    function driveSpeed(edge, siren) {
      const seconds = BL.travelTime(sim, edge, SPEED_PROBE_M, sim.t, { siren, forecast: false });
      return seconds > 0 && Number.isFinite(seconds) ? SPEED_PROBE_M / seconds : BL.BASE_SPEED[edge.type];
    }

    function advanceOnLeg(amb, leg, budget) {
      const remaining = Math.max(0, legLength(leg) - amb.legPos);
      const speed = driveSpeed(BL.EDGES[leg.e], amb.siren);
      const needed = remaining / speed;
      if (needed <= budget) {
        amb.legIdx += 1;
        amb.legPos = 0;
        return budget - needed;
      }
      amb.legPos += speed * budget;
      return 0;
    }

    function placeOnLeg(amb, leg) {
      const length = legLength(leg);
      const fraction = length > 0 ? clamp01(amb.legPos / length) : 0;
      placeAt(amb, { e: leg.e, t: leg.t0 + (leg.t1 - leg.t0) * fraction });
      amb.heading = legHeading(leg);
    }

    function moveAmbulance(amb, dt) {
      if (!amb.path) return;
      const legs = amb.path.legs;
      let budget = dt;
      while (amb.legIdx < legs.length && budget > 0) {
        budget = advanceOnLeg(amb, legs[amb.legIdx], budget);
      }
      if (amb.legIdx < legs.length) {
        placeOnLeg(amb, legs[amb.legIdx]);
        return;
      }
      if (legs.length) amb.heading = legHeading(legs[legs.length - 1]);
      handleArrival(amb);
    }

    const arrivalHandlers = {
      toScene: arriveAtScene,
      toHospital: arriveAtHospital,
      returning: arriveAtStation
    };

    const timerHandlers = {
      onScene: startTransport,
      handover: startReturn
    };

    function handleArrival(amb) {
      const handler = arrivalHandlers[amb.state];
      if (handler) handler(amb);
      else amb.path = null;
    }

    function runTimers() {
      sim.ambs.forEach((amb) => {
        if (amb.timerEnd === null || sim.t < amb.timerEnd) return;
        const handler = timerHandlers[amb.state];
        amb.timerEnd = null;
        if (handler) handler(amb);
      });
    }

    function returnToQueue(patient, takenBy, newPatient) {
      Object.assign(patient, { status: 'waiting', amb: null, hosp: null, rec: null, queueNoted: false });
      toast(`${takenBy.name} diverted to ${newPatient.id}. ${patient.id} is back in the queue.`, 'warn');
    }

    function releaseDivertedPatients(rec) {
      new Set([rec.divertFrom, rec.amb.patient]).forEach((patient) => {
        if (!patient || patient === rec.p || patient.amb !== rec.amb || patient.status !== 'assigned') return;
        returnToQueue(patient, rec.amb, rec.p);
      });
    }

    function routeToScene(amb, rec) {
      const plannedStart = rec.route1 && routeStartPoint(rec.route1, rec.p.loc);
      if (plannedStart && Math.hypot(amb.x - plannedStart[0], amb.y - plannedStart[1]) <= SAME_SPOT_M) {
        return rec.route1;
      }
      return findRouteOrEmpty(amb.loc, rec.p.loc, { siren: true, forecast: true });
    }

    function dispatch(rec) {
      const { amb, p } = rec;
      releaseDivertedPatients(rec);
      setPath(amb, routeToScene(amb, rec));
      Object.assign(amb, { state: 'toScene', siren: true, patient: p, hosp: rec.hosp, timerEnd: null, reservedBy: null });
      Object.assign(p, { status: 'assigned', amb, hosp: rec.hosp });
      emit('dispatch', rec);
    }

    function arriveAtScene(amb) {
      const patient = amb.patient;
      const priority = priorityOf(patient);
      placeAt(amb, patient.loc);
      Object.assign(amb, { state: 'onScene', siren: false, path: null, timerEnd: sim.t + patient.sceneDur });
      Object.assign(patient, { status: 'onScene', arriveT: sim.t, responseT: sim.t - patient.callT });
      sim.kpi.responses.push({ resp: patient.responseT, target: priority.target, cat: priority.key });
      post('coord', 'you', `${amb.name} on scene at ${patient.id} after ${BL.fmtMin(patient.responseT)} (target ${priority.target / 60} min).`);
      emit('arrived', patient);
    }

    function startTransport(amb) {
      const patient = amb.patient;
      const siren = patient.cat !== 'GREEN';
      setPath(amb, findRouteOrEmpty(amb.loc, amb.hosp.loc, { siren, forecast: true }));
      Object.assign(amb, { state: 'toHospital', siren });
      patient.status = 'transport';
    }

    function arriveAtHospital(amb) {
      const { patient, hosp } = amb;
      placeAt(amb, hosp.loc);
      Object.assign(amb, { state: 'handover', siren: false, path: null, timerEnd: sim.t + HANDOVER_S });
      Object.assign(patient, { status: 'delivered', doneT: sim.t, hosp });
      hosp.load += 1;
      recordHistory(patient);
      post('coord', 'you', `${amb.name} handed over ${patient.id} at ${hosp.short}. Back in service in ${HANDOVER_S / 60} min.`);
      emit('delivered', patient);
    }

    function startReturn(amb) {
      setPath(amb, findRouteOrEmpty(amb.loc, amb.station.loc, { siren: false, forecast: true }));
      Object.assign(amb, { state: 'returning', siren: false, patient: null, hosp: null, timerEnd: null });
      sim.coordinator.onUnitFree(amb);
    }

    function arriveAtStation(amb) {
      placeAt(amb, amb.station.loc);
      setPath(amb, null);
      amb.state = 'idle';
    }

    function reroute(amb, route) {
      if (route && Array.isArray(route.legs)) setPath(amb, route);
    }

    function recordHistory(patient) {
      sim.history.push(patient);
      if (sim.history.length > HISTORY_SIZE) sim.history.splice(0, sim.history.length - HISTORY_SIZE);
    }

    function pruneDelivered() {
      const cutoff = sim.t - DELIVERED_KEEP_S;
      for (let i = sim.patients.length - 1; i >= 0; i -= 1) {
        const patient = sim.patients[i];
        if (patient.status === 'delivered' && patient.doneT < cutoff) sim.patients.splice(i, 1);
      }
    }

    function relaxHospitalLoads(dt) {
      const blend = 1 - Math.exp(-dt / LOAD_TIME_CONSTANT_S);
      sim.hospitals.forEach((hosp) => {
        hosp.load += (hosp.baseline * hosp.capacity - hosp.load) * blend;
      });
    }

    function hasUnplannedWork() {
      const waiting = sim.patients.some((p) => p.status === 'waiting' && sim.t >= (p.holdUntil || 0));
      return waiting && sim.ambs.some(isAvailable);
    }

    function planWhenCapacityIsIdle() {
      if (sim.t < sim.nextSafetyPlanT) return;
      sim.nextSafetyPlanT = sim.t + SAFETY_PLAN_INTERVAL_S;
      if (hasUnplannedWork()) sim.coordinator.plan();
    }

    function shiftFields(target, keys, delta) {
      keys.forEach((key) => {
        if (Number.isFinite(target[key])) target[key] += delta;
      });
    }

    function routesOfRec(rec) {
      return [rec.route1, rec.route2, rec.alt && rec.alt.route, rec.altHosp && rec.altHosp.route];
    }

    function shiftTimestamps(delta) {
      const patients = new Set([...sim.patients, ...sim.history]);
      const recs = new Set([...sim.coordinator.recs, ...[...patients].map((p) => p.rec)].filter(Boolean));
      const routes = new Set([...sim.ambs.map((amb) => amb.path), ...[...recs].flatMap(routesOfRec)].filter(Boolean));
      patients.forEach((p) => shiftFields(p, ['callT', 'arriveT', 'doneT', 'holdUntil'], delta));
      recs.forEach((rec) => shiftFields(rec, ['createdT'], delta));
      routes.forEach((route) => shiftFields(route, ['depart', 'arrive'], delta));
      sim.ambs.forEach((amb) => shiftFields(amb, ['timerEnd'], delta));
      sim.traffic.accidents.forEach((accident) => shiftFields(accident, ['start'], delta));
      shiftFields(sim, ['nextCallT', 'nextSafetyPlanT'], delta);
    }

    function parseClock(hhmm) {
      const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
      if (!match) return null;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      return hours < 24 && minutes < 60 ? hours * 3600 + minutes * 60 : null;
    }

    function moveClock(clock) {
      let target = Math.floor(sim.t / DAY_S) * DAY_S + clock;
      if (target < sim.t) target += DAY_S;
      const delta = target - sim.t;
      shiftTimestamps(delta);
      sim.t = target;
      return delta;
    }

    function clockText() {
      const { day, hm } = BL.fmtClock(sim.t);
      return `${day} ${hm}`;
    }

    function jumpTo(hhmm) {
      const clock = parseClock(hhmm);
      if (clock === null) return 0;
      const delta = moveClock(clock);
      toast(`Clock set to ${clockText()}.`, 'info');
      return delta;
    }

    function setScenario(id) {
      const scenario = BL.SCENARIO[id];
      if (!scenario) return;
      sim.scenario.id = id;
      const clock = scenario.startTime ? parseClock(scenario.startTime) : null;
      if (clock !== null) moveClock(clock);
      post('traffic', 'coord', scenario.briefing.traffic);
      post('triage', 'coord', scenario.briefing.triage);
      emit('scenario', { id, snow: sim.scenario.snow });
      const clockNote = clock !== null ? ` Clock set to ${clockText()}.` : '';
      toast(`${scenario.icon} ${scenario.name} is active.${clockNote}`, 'info');
    }

    function setSnow(on) {
      const value = Boolean(on);
      if (sim.scenario.snow === value) return;
      sim.scenario.snow = value;
      post('traffic', 'coord', SNOW_MESSAGES[value ? 'on' : 'off']);
      emit('scenario', { id: sim.scenario.id, snow: value });
    }

    function metrics() {
      const recent = sim.kpi.responses.slice(-METRIC_WINDOW);
      const onTarget = recent.filter((r) => r.resp <= r.target).length;
      return {
        openCalls: sim.patients.filter((p) => p.status !== 'delivered').length,
        freeUnits: sim.ambs.filter(isAvailable).length,
        totalUnits: sim.ambs.length,
        avgResponse: recent.length ? recent.reduce((sum, r) => sum + r.resp, 0) / recent.length : null,
        onTargetPct: recent.length ? Math.round((100 * onTarget) / recent.length) : null,
        cityIndex: sim.traffic.cityIndex(sim.t, 'actual'),
        trend: sim.traffic.trend(sim.t),
        forecast: sim.traffic.forecastSeries(sim.t)
      };
    }

    function etaOf(amb) {
      return BL.remainingTime(sim, amb);
    }

    sim.bus = BL.createBus(() => sim.t);
    sim.hospitals = BL.HOSPITALS.map(createHospital);
    sim.stations = BL.STATIONS.map(runtimeAtNode);
    sim.ambs = sim.stations.map(createAmbulance);
    sim.traffic = new BL.TrafficAgent(sim);
    sim.triage = new BL.TriageAgent(sim);
    sim.coordinator = new BL.Coordinator(sim);
    sim.announce = () => post('coord', 'you', `Coordinator online. ${sim.ambs.length} units at their stations. Triage and traffic agents connected.`);

    return sim;
  }

  BL.createSim = createSim;
})(window.BL);
