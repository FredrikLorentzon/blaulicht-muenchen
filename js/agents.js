'use strict';

/*
 * Agents for Blaulicht München.
 * The message bus, time dependent routing and the three agents: traffic,
 * triage and the dispatch coordinator. Agents never touch each other's state
 * directly. They talk through sim.bus and call each other only through the
 * methods named in CONTRACT.md.
 */
(function (BL) {
  const MINUTE = 60;
  const DAY = 86400;
  const MIN_LEG_METRES = 0.5;
  const NO_SIREN_SPEED = 0.8;

  const SNOW_FACTOR = 1.35;
  const WOBBLE = 0.08;
  const SCENARIO_CAUSE_LOAD = 0.3;
  const ACCIDENT = { dur: 25 * MINUTE, sev: 2.8, meanGapS: 70 * MINUTE, neighborShare: 0.3, fullShare: 0.6 };
  const ACCIDENT_TYPES = ['ring', 'art'];
  const BULLETIN_EVERY_S = 20 * MINUTE;
  const BULLETIN_HORIZON_S = 20 * MINUTE;
  const FIRST_BULLETIN_S = MINUTE;
  const TREND_HORIZON_S = 20 * MINUTE;
  const TREND_THRESHOLD = 0.04;
  const BUSY_FACTOR = 1.15;

  const RESCORE_EVERY_S = 30;
  const WAIT_POINT_EVERY_S = 2 * MINUTE;
  const WAIT_POINTS_CAP = 20;
  const SCORE_RANGE = [5, 100];

  const HOLD_S = 3 * MINUTE;
  const HANDOVER_S = 6 * MINUTE;
  const REROUTE_MIN_SAVING_S = 20;
  const LOAD_PENALTY = { threshold: 0.6, perShare: 1500, full: 1800 };
  const MISSION_STATES = ['toScene', 'onScene', 'toHospital', 'handover'];
  const FREE_STATES = ['idle', 'returning'];
  const DIVERTIBLE_CATS = ['GREEN', 'YELLOW'];

  const NEED = {
    cardiac: { article: 'a', noun: 'cath lab' },
    stroke: { article: 'a', noun: 'stroke unit' },
    trauma: { article: 'a', noun: 'trauma centre' },
    pediatric: { article: 'a', noun: 'children’s ER' },
    obstetrics: { article: 'a', noun: 'maternity ward' },
    general: { article: 'an', noun: 'emergency room' }
  };

  const PHASE_OPENER = {
    'Morning rush': 'Morning rush is starting.',
    'Evening rush': 'Evening rush is starting.',
    Midday: 'Midday traffic is building.',
    'Off peak': 'Traffic is off peak.',
    Night: 'Night traffic, the roads are quiet.',
    Weekend: 'Weekend traffic pattern.'
  };

  const TREND_VERB = { rising: 'heading to', easing: 'easing to', steady: 'holding at' };

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  function clamp(value, lo, hi) {
    return Math.min(hi, Math.max(lo, value));
  }

  function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function minBy(list, key) {
    return list.reduce((best, item) => (best === null || key(item) < key(best) ? item : best), null);
  }

  function maxBy(list, key) {
    return minBy(list, (item) => -key(item));
  }

  function fmtFactor(f) {
    return `×${f.toFixed(1)}`;
  }

  function fmtPct(share) {
    return `${Math.round(share * 100)} %`;
  }

  function listNames(names) {
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  }

  function capitalize(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function say(sim, from, to, text, onShow) {
    return sim.bus.post(onShow ? { from, to, text, onShow } : { from, to, text });
  }

  const CASES = [
    {
      key: 'cardiac_arrest', label: 'Cardiac arrest', emoji: '❤️', weight: 5, base: 96, need: 'cardiac',
      scene: [18, 26], age: [45, 88],
      vitals: () => ({ hr: 0, spo2: null, gcs: 3 }),
      finding: 'No pulse, bystander CPR in progress.',
      calls: [
        'My husband collapsed in the kitchen and he is not breathing.',
        'A man fell over at the tram stop. There is no pulse and someone is doing CPR.'
      ]
    },
    {
      key: 'stroke', label: 'Suspected stroke', emoji: '🧠', weight: 7, base: 86, need: 'stroke',
      scene: [8, 12], age: [52, 90],
      vitals: () => ({ hr: randInt(70, 110), spo2: randInt(92, 98), gcs: randInt(11, 15) }),
      finding: 'FAST positive, onset about 20 min ago.',
      calls: [
        'My father’s face is drooping and he cannot lift his right arm.',
        'My wife suddenly cannot speak properly and her left side is weak.'
      ]
    },
    {
      key: 'trauma', label: 'Bike or scooter crash', emoji: '🚲', weight: 6, base: 84, need: 'trauma',
      scene: [10, 16], age: [16, 64],
      vitals: () => ({ hr: randInt(105, 140), spo2: randInt(88, 97), gcs: randInt(9, 15) }),
      finding: 'Hit by a car, suspected head and pelvic injury.',
      calls: [
        'A cyclist was hit by a car at the junction and he is barely moving.',
        'A girl on an e-scooter crashed into a van. Her head is bleeding and her leg looks broken.'
      ]
    },
    {
      key: 'breathing', label: 'Severe breathing difficulty', emoji: '🫁', weight: 9, base: 74, need: 'general',
      scene: [10, 15], age: [30, 92],
      vitals: () => ({ hr: randInt(100, 135), spo2: randInt(80, 90), gcs: randInt(13, 15) }),
      finding: 'Cannot finish a sentence, lips turning blue.',
      calls: [
        'My mother cannot breathe. She can barely say a word.',
        'My asthma spray is not working and I cannot get any air.'
      ]
    },
    {
      key: 'chest_pain', label: 'Chest pain', emoji: '💔', weight: 9, base: 74, need: 'cardiac',
      scene: [10, 14], age: [40, 85],
      vitals: () => ({ hr: randInt(85, 125), spo2: randInt(92, 98), gcs: 15 }),
      finding: 'Crushing pain radiating to the left arm, sweating.',
      calls: [
        'I have a crushing pain in my chest and it goes down my left arm.',
        'My colleague is grey and sweating and he is holding his chest.'
      ]
    },
    {
      key: 'unconscious', label: 'Unconscious person', emoji: '😵', weight: 7, base: 78, need: 'general',
      scene: [10, 16], age: [18, 85],
      vitals: () => ({ hr: randInt(50, 120), spo2: randInt(86, 96), gcs: randInt(5, 9) }),
      finding: 'No response to voice or pain, breathing.',
      calls: [
        'There is a man lying on the pavement and he does not respond.',
        'My flatmate will not wake up. She is breathing but not answering.'
      ]
    },
    {
      key: 'allergy', label: 'Severe allergic reaction', emoji: '🐝', weight: 4, base: 72, need: 'general',
      scene: [8, 12], age: [8, 60],
      vitals: () => ({ hr: randInt(115, 145), spo2: randInt(86, 95), gcs: randInt(13, 15) }),
      finding: 'Swollen throat and hives after exposure.',
      calls: [
        'My son was stung by a wasp and his throat is swelling up.',
        'I ate something with nuts and my face and lips are swelling.'
      ]
    },
    {
      key: 'childbirth', label: 'Childbirth', emoji: '👶', weight: 3, base: 62, need: 'obstetrics',
      scene: [12, 20], age: [21, 41],
      vitals: () => ({ hr: randInt(90, 115), spo2: randInt(96, 99), gcs: 15 }),
      finding: 'Waters broken, contractions two minutes apart.',
      calls: [
        'My wife’s waters broke and the contractions are two minutes apart.',
        'The baby is coming. I can already see the head.'
      ]
    },
    {
      key: 'child_seizure', label: 'Child with seizure', emoji: '🧸', weight: 4, base: 70, need: 'pediatric',
      scene: [8, 12], age: [1, 9],
      vitals: () => ({ hr: randInt(120, 160), spo2: randInt(88, 96), gcs: randInt(8, 12) }),
      finding: 'Seizure for more than five minutes, high fever.',
      calls: [
        'My little boy has a high fever and he is shaking all over.',
        'My daughter is having a fit and it has not stopped for five minutes.'
      ]
    },
    {
      key: 'hip_fall', label: 'Fall with hip injury', emoji: '🦴', weight: 10, base: 56, need: 'general',
      scene: [12, 18], age: [72, 96],
      vitals: () => ({ hr: randInt(80, 105), spo2: randInt(93, 98), gcs: randInt(14, 15) }),
      finding: 'Cannot stand, leg shortened and rotated.',
      calls: [
        'My grandmother fell in the bathroom and she cannot get up.',
        'An old lady slipped on the steps and her hip hurts terribly.'
      ]
    },
    {
      key: 'minor_injury', label: 'Minor injury', emoji: '🩹', weight: 12, base: 40, need: 'general',
      scene: [6, 10], age: [8, 70],
      vitals: () => ({ hr: randInt(70, 100), spo2: randInt(96, 99), gcs: 15 }),
      finding: 'Deep cut, bleeding controlled with pressure.',
      calls: [
        'I cut my hand badly on a broken glass.',
        'My friend twisted his ankle on the stairs and it is very swollen.'
      ]
    },
    {
      key: 'intoxication', label: 'Intoxication', emoji: '🍺', weight: 4, base: 46, need: 'general',
      scene: [6, 12], age: [18, 45],
      vitals: () => ({ hr: randInt(90, 125), spo2: randInt(91, 98), gcs: randInt(9, 14) }),
      finding: 'Heavily intoxicated, vomiting, hard to wake.',
      calls: [
        'My friend drank far too much and we cannot wake him properly.',
        'A young man is vomiting outside the bar and he is barely conscious.'
      ]
    }
  ];

  const CASE_BY_KEY = Object.fromEntries(CASES.map((kase) => [kase.key, kase]));
  const PRIORITIES_DESC = Object.values(BL.PRIORITY).sort((a, b) => b.min - a.min);

  function createBus(getTime = () => 0) {
    const subscribers = [];
    let count = 0;
    return {
      post(msg) {
        count += 1;
        const stamped = { ...msg, id: count, t: getTime() };
        subscribers.forEach((fn) => fn(stamped));
        return stamped;
      },
      subscribe(fn) {
        subscribers.push(fn);
      }
    };
  }

  function edgeOf(edgeRef) {
    return typeof edgeRef === 'number' ? BL.EDGES[edgeRef] : edgeRef;
  }

  function travelTime(sim, edgeRef, metres, T, opts = {}) {
    const edge = edgeOf(edgeRef);
    const f = sim.traffic.factor(edge, T, opts.forecast ? 'forecast' : 'actual');
    const effective = opts.siren ? 1 + (f - 1) * BL.SIREN_RELIEF : f;
    const speed = BL.BASE_SPEED[edge.type] * (opts.siren ? 1 : NO_SIREN_SPEED);
    return (metres * effective) / speed;
  }

  function legMetres(leg) {
    return Math.abs(leg.t1 - leg.t0) * BL.EDGES[leg.e].len;
  }

  function legTime(sim, leg, T, opts) {
    return travelTime(sim, BL.EDGES[leg.e], legMetres(leg), T, opts);
  }

  function legEnd(leg) {
    return { e: leg.e, t: leg.t1 };
  }

  function sameSpot(from, to) {
    const [ax, ay] = BL.pointAt(from);
    const [bx, by] = BL.pointAt(to);
    return Math.hypot(bx - ax, by - ay) < MIN_LEG_METRES;
  }

  function makeRoute(legs, depart, arrive) {
    const kept = legs.filter((leg) => legMetres(leg) >= MIN_LEG_METRES);
    const length = kept.reduce((sum, leg) => sum + legMetres(leg), 0);
    return { legs: kept, depart, arrive, duration: arrive - depart, length };
  }

  function closestOpenNode(arrival, settled) {
    let best = -1;
    arrival.forEach((T, node) => {
      if (!settled[node] && T < Infinity && (best < 0 || T < arrival[best])) best = node;
    });
    return best;
  }

  function seedTree(sim, tree, from, depart, opts) {
    const edge = BL.EDGES[from.e];
    [[edge.a, 0], [edge.b, 1]].forEach(([node, t1]) => {
      const leg = { e: from.e, t0: from.t, t1 };
      const T = depart + legTime(sim, leg, depart, opts);
      if (T < tree.arrival[node]) {
        tree.arrival[node] = T;
        tree.via[node] = { prev: -1, leg };
      }
    });
  }

  function relaxNeighbours(sim, tree, settled, node, opts) {
    BL.ADJ[node].forEach(({ e, to }) => {
      if (settled[to]) return;
      const forward = e.a === node;
      const leg = { e: e.i, t0: forward ? 0 : 1, t1: forward ? 1 : 0 };
      const T = tree.arrival[node] + legTime(sim, leg, tree.arrival[node], opts);
      if (T < tree.arrival[to]) {
        tree.arrival[to] = T;
        tree.via[to] = { prev: node, leg };
      }
    });
  }

  function shortestPathTree(sim, from, depart, opts) {
    const count = BL.NODES.length;
    const tree = { arrival: new Array(count).fill(Infinity), via: new Array(count).fill(null) };
    const settled = new Array(count).fill(false);
    seedTree(sim, tree, from, depart, opts);
    for (let node = closestOpenNode(tree.arrival, settled); node >= 0; node = closestOpenNode(tree.arrival, settled)) {
      settled[node] = true;
      relaxNeighbours(sim, tree, settled, node, opts);
    }
    return tree;
  }

  function legsTo(tree, node) {
    const legs = [];
    for (let n = node; n >= 0; n = tree.via[n].prev) legs.unshift(tree.via[n].leg);
    return legs;
  }

  function finishOptions(sim, tree, from, to, depart, opts) {
    const edge = BL.EDGES[to.e];
    const viaEnds = [[edge.a, 0], [edge.b, 1]]
      .filter(([node]) => tree.arrival[node] < Infinity)
      .map(([node, t0]) => {
        const last = { e: to.e, t0, t1: to.t };
        const enter = tree.arrival[node];
        return { legs: [...legsTo(tree, node), last], arrive: enter + legTime(sim, last, enter, opts) };
      });
    if (from.e !== to.e) return viaEnds;
    const direct = { e: from.e, t0: from.t, t1: to.t };
    return [...viaEnds, { legs: [direct], arrive: depart + legTime(sim, direct, depart, opts) }];
  }

  function findRoute(sim, from, to, depart, opts = {}) {
    if (sameSpot(from, to)) return makeRoute([], depart, depart);
    const tree = shortestPathTree(sim, from, depart, opts);
    const best = minBy(finishOptions(sim, tree, from, to, depart, opts), (option) => option.arrive);
    return makeRoute(best.legs, depart, best.arrive);
  }

  function legTimeline(sim, legs, startT, opts, skipMetres = 0) {
    let T = startT;
    return legs.map((leg, k) => {
      const metres = Math.max(0, legMetres(leg) - (k === 0 ? skipMetres : 0));
      const enterT = T;
      T += travelTime(sim, BL.EDGES[leg.e], metres, T, opts);
      return { leg, enterT, exitT: T };
    });
  }

  function routePoints(route, fromLegIdx = 0, startPoint = null) {
    const legs = route.legs.slice(fromLegIdx);
    if (!legs.length) return startPoint ? [startPoint] : [];
    const first = startPoint || BL.pointAt({ e: legs[0].e, t: legs[0].t0 });
    return [first, ...legs.map((leg) => BL.pointAt(legEnd(leg)))];
  }

  function routeVia(route) {
    const metresByRoad = new Map();
    route.legs.forEach((leg) => {
      const name = BL.EDGES[leg.e].name;
      metresByRoad.set(name, (metresByRoad.get(name) || 0) + legMetres(leg));
    });
    const top = [...metresByRoad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
    const inDrivingOrder = [...metresByRoad.keys()].filter((name) => top.includes(name));
    return inDrivingOrder.length ? `via ${inDrivingOrder.join(' and ')}` : '';
  }

  function remainingTime(sim, amb) {
    const path = amb.path;
    if (!path || amb.legIdx >= path.legs.length) return null;
    const opts = { siren: amb.siren, forecast: true };
    const timeline = legTimeline(sim, path.legs.slice(amb.legIdx), sim.t, opts, amb.legPos || 0);
    return timeline[timeline.length - 1].exitT - sim.t;
  }

  function worstStretch(sim, route, opts) {
    const stretches = legTimeline(sim, route.legs, route.depart, opts).map(({ leg, enterT }) => ({
      name: BL.EDGES[leg.e].name,
      f: sim.traffic.factor(BL.EDGES[leg.e], enterT, 'forecast')
    }));
    return maxBy(stretches, (stretch) => stretch.f);
  }

  function destinationOf(path) {
    return legEnd(path.legs[path.legs.length - 1]);
  }


  function bump(hour, centre, amplitude, width) {
    return amplitude * Math.exp(-((hour - centre) ** 2) / (2 * width * width));
  }

  function hourOf(T) {
    return (((T % DAY) + DAY) % DAY) / 3600;
  }

  function isWeekend(T) {
    return Math.floor(T / DAY) % 7 >= 5;
  }

  function accidentShare(acc, T) {
    const age = T - acc.start;
    if (age < 0 || age >= acc.dur) return 0;
    const fullUntil = acc.dur * ACCIDENT.fullShare;
    return age <= fullUntil ? 1 : 1 - (age - fullUntil) / (acc.dur - fullUntil);
  }

  function accidentReach(acc, edge) {
    if (acc.e === edge.i) return 1;
    return BL.EDGES[acc.e].neighbors.includes(edge.i) ? ACCIDENT.neighborShare : 0;
  }

  function phaseCause(phase, trend) {
    if (phase === 'Morning rush' || phase === 'Evening rush') {
      const peak = phase === 'Morning rush' ? 'morning peak' : 'evening peak';
      if (trend === 'rising') return `as the ${peak} builds`;
      if (trend === 'easing') return `as the ${peak} fades`;
      return `at the ${peak}`;
    }
    if (phase === 'Midday') return 'with lunchtime traffic';
    if (phase === 'Night') return 'on quiet night roads';
    if (phase === 'Weekend') return 'in weekend traffic';
    return 'in off peak traffic';
  }

  class TrafficAgent {
    constructor(sim) {
      this.sim = sim;
      this.accidents = [];
      this.accidentCount = 0;
      this.phase = null;
      this.nextBulletinT = null;
    }

    rush(T) {
      const hour = hourOf(T);
      const curve = isWeekend(T)
        ? bump(hour, 13.5, 0.5, 3.0) + bump(hour, 19, 0.2, 1.5)
        : bump(hour, 8, 1.15, 0.9) + bump(hour, 17.4, 1.35, 1.1) + bump(hour, 12.5, 0.35, 2.2);
      return Math.max(0.04, curve);
    }

    factor(edgeRef, T, mode = 'forecast') {
      const edge = edgeOf(edgeRef);
      const event = this.scenarioEffect(edge);
      const load = 1 + this.rush(T) * edge.commute + event.load + this.accidentLoad(edge, T);
      const weather = this.sim.scenario.snow ? load * SNOW_FACTOR : load;
      const live = mode === 'actual' ? weather * (1 + WOBBLE * Math.sin(edge.i * 1.93 + T / 420)) : weather;
      const f = Math.max(1, live);
      return event.closed ? Math.max(f, BL.CLOSURE_FACTOR) : f;
    }

    scenarioDef() {
      const { sim } = this;
      return (typeof sim.activeScenario === 'function' && sim.activeScenario()) || BL.SCENARIO.normal;
    }

    scenarioEffect(edge) {
      return BL.scenarioEdgeEffect(this.scenarioDef(), edge);
    }

    closedRoads() {
      const names = [...this.scenarioDef().closures].map((i) => BL.EDGES[i].name);
      return [...new Set(names)];
    }

    closedRoadsOn(route) {
      const closures = this.scenarioDef().closures;
      const names = route.legs.filter((leg) => closures.has(leg.e)).map((leg) => BL.EDGES[leg.e].name);
      return [...new Set(names)];
    }

    accidentLoad(edge, T) {
      return this.accidents.reduce((sum, acc) => sum + acc.sev * accidentReach(acc, edge) * accidentShare(acc, T), 0);
    }

    randomAccidentEdge() {
      const blocked = new Set(this.accidents.map((acc) => acc.e));
      const major = BL.EDGES.filter((edge) => ACCIDENT_TYPES.includes(edge.type));
      const open = major.filter((edge) => !blocked.has(edge.i));
      return pick(open.length ? open : major).i;
    }

    addAccident(edgeIdx) {
      const { sim } = this;
      const e = Number.isInteger(edgeIdx) ? edgeIdx : this.randomAccidentEdge();
      this.accidentCount += 1;
      const acc = { id: `A-${this.accidentCount}`, e, start: sim.t, dur: ACCIDENT.dur, sev: ACCIDENT.sev };
      this.accidents.push(acc);
      const edge = BL.EDGES[e];
      const expected = fmtFactor(this.factor(edge, sim.t, 'forecast'));
      say(sim, 'traffic', 'coord', `Crash reported on ${edge.name}. Expect ${expected} there for about ${Math.round(acc.dur / MINUTE)} min.`);
      sim.coordinator.onAccident(acc);
      return acc;
    }

    cityIndex(T, mode = 'forecast') {
      const def = this.scenarioDef();
      const open = BL.EDGES.filter((edge) => !def.closures.has(edge.i));
      const metres = open.reduce((sum, edge) => sum + edge.len, 0);
      const weighted = open.reduce((sum, edge) => sum + this.factor(edge, T, mode) * edge.len, 0);
      return weighted / metres;
    }

    forecastSeries(now = this.sim.t) {
      return Array.from({ length: 7 }, (_, k) => {
        const t = now + k * 10 * MINUTE;
        return { t, v: this.cityIndex(t, 'forecast') };
      });
    }

    trend(now = this.sim.t) {
      const change = this.cityIndex(now + TREND_HORIZON_S, 'forecast') - this.cityIndex(now, 'forecast');
      if (change > TREND_THRESHOLD) return 'rising';
      if (change < -TREND_THRESHOLD) return 'easing';
      return 'steady';
    }

    confidence(horizonS) {
      const penalty = 0.6 * (horizonS / MINUTE) + 4 * this.accidents.length + (this.sim.scenario.snow ? 6 : 0);
      return clamp(Math.round(95 - penalty), 60, 97);
    }

    worstRoad(T, mode = 'forecast') {
      const roads = new Map();
      const closures = this.scenarioDef().closures;
      BL.EDGES.filter((edge) => !closures.has(edge.i)).forEach((edge) => {
        const road = roads.get(edge.name) || { name: edge.name, weighted: 0, len: 0 };
        road.weighted += this.factor(edge, T, mode) * edge.len;
        road.len += edge.len;
        roads.set(edge.name, road);
      });
      const worst = maxBy([...roads.values()], (road) => road.weighted / road.len);
      return { name: worst.name, f: worst.weighted / worst.len };
    }

    phaseLabel(T) {
      if (isWeekend(T)) return 'Weekend';
      const hour = hourOf(T);
      if (hour < 6 || hour >= 22) return 'Night';
      if (hour >= 6.5 && hour < 9.5) return 'Morning rush';
      if (hour >= 11.5 && hour < 14) return 'Midday';
      if (hour >= 15.75 && hour < 19) return 'Evening rush';
      return 'Off peak';
    }

    tick(dt) {
      this.maybeSpawnAccident(dt);
      this.clearExpiredAccidents();
      this.maybePostBulletin();
    }

    maybeSpawnAccident(dt) {
      if (Math.random() < dt / ACCIDENT.meanGapS) this.addAccident();
    }

    clearExpiredAccidents() {
      const { sim } = this;
      const expired = this.accidents.filter((acc) => sim.t >= acc.start + acc.dur);
      if (!expired.length) return;
      this.accidents = this.accidents.filter((acc) => !expired.includes(acc));
      expired.forEach((acc) => {
        const edge = BL.EDGES[acc.e];
        say(sim, 'traffic', 'coord', `Crash on ${edge.name} cleared. Traffic there back to ${fmtFactor(this.factor(edge, sim.t, 'forecast'))}.`);
      });
    }

    maybePostBulletin() {
      const { sim } = this;
      const phase = this.phaseLabel(sim.t);
      if (this.phase === null) {
        this.phase = phase;
        this.nextBulletinT = sim.t + FIRST_BULLETIN_S;
        return;
      }
      const phaseChanged = phase !== this.phase;
      if (!phaseChanged && sim.t < this.nextBulletinT) return;
      this.phase = phase;
      this.nextBulletinT = sim.t + BULLETIN_EVERY_S;
      const opener = phaseChanged ? `${PHASE_OPENER[phase]} ` : '';
      say(sim, 'traffic', 'coord', opener + this.bulletin(sim.t));
    }

    bulletin(now) {
      const at = now + BULLETIN_HORIZON_S;
      const road = this.worstRoad(at);
      const trend = this.trend(now);
      const snow = this.sim.scenario.snow ? ' with snow' : '';
      const city = fmtFactor(this.cityIndex(at, 'forecast'));
      const cause = this.causeOf(road.name, at, trend);
      return `Forecast for ${BL.fmtClock(at).hm}: ${road.name} ${TREND_VERB[trend]} ${fmtFactor(road.f)} ${cause}. City index ${city}${snow}, ${trend}.`;
    }

    causeOf(roadName, T, trend) {
      const edges = BL.EDGES.filter((edge) => edge.name === roadName);
      if (edges.some((edge) => this.accidentLoad(edge, T) > 0)) return 'because of the crash';
      if (edges.some((edge) => this.scenarioEffect(edge).closed)) return 'because of the closure';
      if (edges.some((edge) => this.scenarioEffect(edge).load > SCENARIO_CAUSE_LOAD)) return `with ${this.scenarioDef().name} traffic`;
      return phaseCause(this.phaseLabel(T), trend);
    }

    status() {
      const { sim } = this;
      return `×${this.cityIndex(sim.t, 'actual').toFixed(2)} ${this.trend(sim.t)}`;
    }
  }

  function caseOf(p) {
    return CASE_BY_KEY[p.caseKey];
  }

  function categoryOf(score) {
    return PRIORITIES_DESC.find((priority) => score >= priority.min).key;
  }

  function riskFactors(p) {
    const { hr, spo2, gcs } = p.vitals;
    return [
      p.age >= 75 && { label: `age ${p.age}`, points: 5 },
      p.age <= 5 && { label: `age ${p.age}`, points: 5 },
      spo2 !== null && spo2 < 90 && { label: `SpO₂ ${spo2} %`, points: 7 },
      gcs <= 8 && { label: `GCS ${gcs}`, points: 8 },
      hr >= 130 && { label: `HR ${hr}`, points: 4 }
    ].filter(Boolean);
  }

  function isQueued(p) {
    return p.status === 'waiting' || p.status === 'pending';
  }

  function needPhrase(need) {
    const { article, noun } = NEED[need] || NEED.general;
    return `${article} ${noun}`;
  }

  class TriageAgent {
    constructor(sim) {
      this.sim = sim;
      this.sinceRescore = 0;
    }

    assess(p) {
      const kase = caseOf(p);
      p.need = kase.need;
      this.applyScore(p);
      say(this.sim, 'intake', 'triage', `112 call from ${p.street}, ${p.area}: “${p.call}”`);
      say(this.sim, 'triage', 'coord', this.verdict(p, kase));
      if (BL.llm && BL.llm.enabled) this.reviewWithModel(p, kase);
    }

    reviewWithModel(p, kase) {
      const brief = {
        caller: p.call, case: kase.label, finding: kase.finding, age: p.age, vitals: p.vitals,
        crowd: p.crowd || null, ruleScore: p.score, ruleCategory: p.cat
      };
      BL.llm.triage(brief)
        .then((answer) => this.applyModelReview(p, answer))
        .catch(() => {});
    }

    applyModelReview(p, answer) {
      if (!BL.PRIORITY[answer.category] || p.status === 'delivered') return;
      const before = p.cat;
      const score = clamp(Math.round(Number(answer.score) || p.score), SCORE_RANGE[0], SCORE_RANGE[1]);
      p.modelAdjust = score - (p.score - (p.modelAdjust || 0));
      this.applyScore(p);
      if (categoryOf(p.score) !== answer.category) p.cat = answer.category;
      const verdict = p.cat === before ? `agrees ${p.cat}` : `moves ${p.id} from ${before} to ${p.cat}`;
      say(this.sim, 'triage', 'coord', `${BL.llm.label} review ${verdict}, score ${p.score}. ${answer.reason}`);
      if (p.cat !== before && p.status === 'waiting') this.sim.coordinator.plan();
    }

    verdict(p, kase) {
      const factors = riskFactors(p);
      const risk = factors.length ? `Risk factors: ${factors.map((f) => f.label).join(', ')}. ` : '';
      const priority = BL.PRIORITY[p.cat];
      return `${p.id} ${kase.label}, ${p.age} y. ${kase.finding} ${risk}Score ${p.score}, ${p.cat} ${priority.label}. `
        + `Needs ${needPhrase(p.need)}. Target response ${priority.target / MINUTE} min.`;
    }

    waitPoints(p) {
      return Math.min(WAIT_POINTS_CAP, Math.floor((this.sim.t - p.callT) / WAIT_POINT_EVERY_S));
    }

    applyScore(p) {
      const kase = caseOf(p);
      const factors = riskFactors(p);
      const waited = this.waitPoints(p);
      const raw = kase.base + factors.reduce((sum, f) => sum + f.points, 0) + waited + (p.modelAdjust || 0);
      p.score = clamp(raw, SCORE_RANGE[0], SCORE_RANGE[1]);
      p.cat = categoryOf(p.score);
      p.reasons = [
        `${kase.label}, base ${kase.base}`,
        ...factors.map((f) => `${capitalize(f.label)}, +${f.points}`),
        ...(waited > 0 ? [`Waited ${Math.floor((this.sim.t - p.callT) / MINUTE)} min, +${waited}`] : [])
      ];
    }

    rescore(p) {
      if (!isQueued(p)) return false;
      const before = p.cat;
      this.applyScore(p);
      if (p.cat === before) return false;
      const waitedMin = Math.floor((this.sim.t - p.callT) / MINUTE);
      const priority = BL.PRIORITY[p.cat];
      say(this.sim, 'triage', 'coord', `${p.id} has waited ${waitedMin} min. Score ${p.score}, upgraded to ${p.cat} ${priority.label}.`);
      return true;
    }

    releaseHold(p) {
      if (p.status !== 'waiting' || !p.holdUntil || this.sim.t < p.holdUntil) return false;
      p.holdUntil = 0;
      say(this.sim, 'triage', 'coord', `Hold on ${p.id} is over. Back in the queue at score ${p.score}.`);
      return true;
    }

    tick(dt) {
      this.sinceRescore += dt;
      if (this.sinceRescore < RESCORE_EVERY_S) return;
      this.sinceRescore = 0;
      const queued = this.queue();
      const upgraded = queued.filter((p) => this.rescore(p)).length > 0;
      const released = queued.filter((p) => this.releaseHold(p)).length > 0;
      if (upgraded || released) this.sim.coordinator.plan();
    }

    queue() {
      return this.sim.patients.filter(isQueued).sort((a, b) => b.score - a.score || a.callT - b.callT);
    }

    status() {
      const count = this.queue().length;
      return count ? `${count} ranked` : 'Queue empty';
    }
  }

  function isFree(amb) {
    return FREE_STATES.includes(amb.state) && !amb.reservedBy;
  }

  function isDivertible(amb) {
    return amb.state === 'toScene' && !amb.reservedBy && amb.patient && DIVERTIBLE_CATS.includes(amb.patient.cat);
  }

  function loadShare(hosp) {
    return hosp.load / hosp.capacity;
  }

  function loadPenalty(hosp) {
    if (hosp.load >= hosp.capacity) return LOAD_PENALTY.full;
    return Math.max(0, loadShare(hosp) - LOAD_PENALTY.threshold) * LOAD_PENALTY.perShare;
  }

  function crossesEdge(amb, edgeIdx) {
    if (!amb.path || amb.legIdx >= amb.path.legs.length) return false;
    return amb.path.legs.slice(amb.legIdx).some((leg) => leg.e === edgeIdx);
  }

  function hospitalTags(hosp, need) {
    const er = `ER ${fmtPct(loadShare(hosp))}`;
    return need === 'general' || !hosp.caps.includes(need) ? er : `${NEED[need].noun}, ${er}`;
  }

  function responseOf(rec) {
    return rec.route1.arrive - rec.p.callT;
  }

  class Coordinator {
    constructor(sim) {
      this.sim = sim;
      this.recs = [];
      this.recCount = 0;
    }

    available() {
      return this.sim.ambs.filter(isFree);
    }

    plan() {
      const { sim } = this;
      sim.triage.queue()
        .filter((p) => p.status === 'waiting' && sim.t >= (p.holdUntil || 0))
        .forEach((p) => this.planFor(p));
    }

    planFor(p) {
      if (this.available().length) {
        this.recommend(p);
        return;
      }
      if (p.cat === 'RED' && !p.divertTried && this.tryDiversion(p)) return;
      this.noteQueued(p);
    }

    tryDiversion(p) {
      p.divertTried = true;
      const donors = this.sim.ambs.filter(isDivertible);
      const fastest = minBy(donors, (amb) => this.routeToScene(amb, p).arrive);
      if (!fastest) return false;
      this.recommend(p, fastest.patient);
      return true;
    }

    noteQueued(p) {
      if (p.queueNoted) return;
      p.queueNoted = true;
      const position = this.sim.triage.queue().filter((q) => q.status === 'waiting').indexOf(p) + 1;
      const next = this.nextFreeUnit();
      const outlook = next ? ` ${next.amb.name} should be free in about ${BL.fmtMin(next.inS)}.` : '';
      say(this.sim, 'coord', 'triage', `No free unit for ${p.id}. Holding it at queue position ${position}.${outlook}`);
    }

    nextFreeUnit() {
      const estimates = this.sim.ambs
        .map((amb) => ({ amb, inS: this.freeInS(amb) }))
        .filter((estimate) => estimate.inS !== null);
      return minBy(estimates, (estimate) => estimate.inS);
    }

    freeInS(amb) {
      const { sim } = this;
      if (amb.state === 'handover' && Number.isFinite(amb.timerEnd)) return Math.max(0, amb.timerEnd - sim.t);
      if (amb.state !== 'toHospital') return null;
      const eta = BL.remainingTime(sim, amb);
      return eta === null ? null : eta + HANDOVER_S;
    }

    routeToScene(amb, p) {
      return BL.findRoute(this.sim, amb.loc, p.loc, this.sim.t, { siren: true, forecast: true });
    }

    rankUnits(p, divertFrom) {
      const units = divertFrom ? [divertFrom.amb] : this.available();
      return units
        .map((amb) => ({ amb, route: this.routeToScene(amb, p) }))
        .sort((a, b) => a.route.arrive - b.route.arrive);
    }

    capableHospitals(p) {
      const capable = this.sim.hospitals.filter((hosp) => hosp.caps.includes(p.need));
      return capable.length ? capable : this.sim.hospitals;
    }

    rankHospitals(p, depart) {
      const opts = { siren: p.cat !== 'GREEN', forecast: true };
      return this.capableHospitals(p)
        .map((hosp) => {
          const route = BL.findRoute(this.sim, p.loc, hosp.loc, depart, opts);
          return { hosp, route, cost: route.duration + loadPenalty(hosp) };
        })
        .sort((a, b) => a.cost - b.cost);
    }

    recommend(p, divertFrom = null) {
      const { sim } = this;
      const units = this.rankUnits(p, divertFrom);
      const hospitals = this.rankHospitals(p, units[0].route.arrive + p.sceneDur);
      this.recCount += 1;
      const rec = {
        id: `R-${this.recCount}`,
        createdT: sim.t,
        p,
        amb: units[0].amb,
        route1: units[0].route,
        alt: units[1] || null,
        hosp: hospitals[0].hosp,
        route2: hospitals[0].route,
        altHosp: hospitals[1] ? { hosp: hospitals[1].hosp, route: hospitals[1].route } : null,
        sceneDur: p.sceneDur,
        divertFrom,
        reasons: [],
        revealed: false,
        remainingMs: BL.AUTO_APPROVE_MS
      };
      const forecast = {
        worst: worstStretch(sim, rec.route1, { siren: true, forecast: true }),
        confidence: sim.traffic.confidence(rec.route1.arrive - sim.t)
      };
      rec.reasons = this.reasonsFor(rec, forecast);
      rec.amb.reservedBy = rec.id;
      p.status = 'pending';
      p.rec = rec;
      this.recs.push(rec);
      say(sim, 'coord', 'traffic', this.requestText(rec, units.length));
      say(sim, 'traffic', 'coord', this.forecastText(rec, forecast));
      if (BL.llm && BL.llm.enabled && !divertFrom && units.length > 1) this.decideWithModel(rec, units, hospitals);
      else this.announce(rec);
      return rec;
    }

    announce(rec) {
      say(this.sim, 'coord', 'you', this.recommendationText(rec), () => { rec.revealed = true; });
    }

    dispatchBrief(rec, units, hospitals) {
      const { p } = rec;
      return {
        patient: {
          id: p.id, case: p.label, category: p.cat, score: p.score, age: p.age,
          needs: BL.CAP_LABEL[p.need], area: p.area, crowd: p.crowd || null
        },
        targetResponseMin: BL.PRIORITY[p.cat].target / MINUTE,
        scenario: this.sim.activeScenario ? this.sim.activeScenario().name : 'Normal day',
        units: units.slice(0, 4).map(({ amb, route }) => ({
          id: amb.id, name: amb.name, station: amb.station.name, etaMin: Number((route.duration / MINUTE).toFixed(1))
        })),
        hospitals: hospitals.slice(0, 4).map(({ hosp, route }) => ({
          id: hosp.id, name: hosp.name, capabilities: hosp.caps.map((c) => BL.CAP_LABEL[c]),
          erLoadPct: Math.round(loadShare(hosp) * 100), transportMin: Number((route.duration / MINUTE).toFixed(1))
        }))
      };
    }

    decideWithModel(rec, units, hospitals) {
      const brief = this.dispatchBrief(rec, units, hospitals);
      say(this.sim, 'coord', 'you', `Asking ${BL.llm.label} to weigh ${brief.units.length} units and ${brief.hospitals.length} hospitals for ${rec.p.id}.`);
      BL.llm.dispatch(brief)
        .then((answer) => this.applyModelChoice(rec, units, hospitals, answer))
        .catch(() => {})
        .finally(() => { if (this.recs.includes(rec)) this.announce(rec); });
    }

    applyModelChoice(rec, units, hospitals, answer) {
      if (!this.recs.includes(rec)) return;
      const unit = units.find(({ amb }) => amb.id === answer.unit);
      if (unit && unit.amb !== rec.amb && !unit.amb.reservedBy && FREE_STATES.includes(unit.amb.state)) {
        rec.amb.reservedBy = null;
        rec.amb = unit.amb;
        rec.route1 = unit.route;
        rec.alt = units.find((u) => u.amb !== unit.amb) || null;
        rec.amb.reservedBy = rec.id;
      }
      const hospital = hospitals.find(({ hosp }) => hosp.id === answer.hospital);
      if (hospital) {
        rec.hosp = hospital.hosp;
        rec.route2 = hospital.route;
        rec.altHosp = hospitals.find((h) => h.hosp !== hospital.hosp) || null;
      }
      const forecast = {
        worst: worstStretch(this.sim, rec.route1, { siren: true, forecast: true }),
        confidence: this.sim.traffic.confidence(rec.route1.arrive - this.sim.t)
      };
      rec.reasons = [{ agent: 'coord', text: `${BL.llm.label}: ${answer.reason}` }, ...this.reasonsFor(rec, forecast)];
      rec.byModel = true;
    }

    requestText(rec, unitCount) {
      const { p } = rec;
      const capable = this.sim.hospitals.filter((hosp) => hosp.caps.includes(p.need)).length;
      const hospitals = capable
        ? `${capable} ${capable === 1 ? 'hospital' : 'hospitals'} with ${needPhrase(p.need)}`
        : `all ${this.sim.hospitals.length} hospitals`;
      const units = rec.divertFrom
        ? `${rec.amb.name} diverted from ${rec.divertFrom.id}`
        : `${unitCount} free ${unitCount === 1 ? 'unit' : 'units'} to the scene`;
      return `Need travel forecasts for ${p.id}: ${units}, then ${hospitals}.`;
    }

    forecastText(rec, { worst, confidence }) {
      const { amb, route1, p } = rec;
      const via = routeVia(route1);
      const stretch = worst && worst.f >= BUSY_FACTOR
        ? `, worst stretch ${worst.name} at ${fmtFactor(worst.f)}`
        : ', roads flowing freely';
      const minutes = BL.fmtMin(route1.duration);
      const lead = !route1.legs.length
        ? `${amb.name} is right at the scene.`
        : rec.divertFrom
          ? `${amb.name} can turn around and reach ${p.id} in ${minutes} ${via}${stretch}.`
          : `${amb.name} is fastest at ${minutes} ${via}${stretch}.`;
      const alt = rec.alt ? ` Next best ${rec.alt.amb.name} at ${BL.fmtMin(rec.alt.route.duration)}.` : '';
      const transport = ` ${rec.hosp.short} is ${BL.fmtMin(rec.route2.duration)} from the scene.`;
      return `${lead}${alt}${transport}${this.closureNote(rec)} Confidence ${confidence} %.`;
    }

    closureNote(rec) {
      const { traffic } = this.sim;
      const crossed = traffic.closedRoadsOn(rec.route1).concat(traffic.closedRoadsOn(rec.route2));
      if (crossed.length) return ` Route crosses the closed ${listNames([...new Set(crossed)])}, expect delays.`;
      const closed = traffic.closedRoads();
      return closed.length ? ` Routed around the closed ${listNames(closed.slice(0, 2))}.` : '';
    }

    recommendationText(rec) {
      const { amb, p, hosp, divertFrom } = rec;
      const target = BL.PRIORITY[p.cat].target;
      const opener = divertFrom
        ? `Recommend diverting ${amb.name} from ${divertFrom.id} to ${p.id}`
        : `Recommend ${amb.name} to ${p.id}`;
      const backToQueue = divertFrom ? ` ${divertFrom.id} goes back to the queue.` : '';
      return `${opener}, then ${hosp.name} (${hospitalTags(hosp, p.need)}). `
        + `${BL.fmtMin(rec.route2.arrive - rec.createdT)} door to door. `
        + `Response ${BL.fmtMin(responseOf(rec))}, target ${target / MINUTE} min.${backToQueue}`;
    }

    reasonsFor(rec, forecast) {
      return [
        { agent: 'triage', text: this.triageReason(rec) },
        { agent: 'traffic', text: this.unitReason(rec) },
        { agent: 'traffic', text: this.roadReason(forecast) },
        { agent: 'coord', text: this.hospitalReason(rec) },
        { agent: 'coord', text: this.outcomeReason(rec) }
      ];
    }

    triageReason({ p }) {
      return `${p.cat} ${BL.PRIORITY[p.cat].label}, score ${p.score}. Needs ${needPhrase(p.need)}.`;
    }

    unitReason({ amb, route1, alt, divertFrom }) {
      const minutes = BL.fmtMin(route1.duration);
      if (divertFrom) return `${amb.name} is the fastest unit on a lower priority run, ${minutes} away.`;
      if (!alt) return `${amb.name} is the only free unit, ${minutes} away.`;
      return `${amb.name} arrives in ${minutes}, ${BL.fmtMin(alt.route.duration - route1.duration)} ahead of ${alt.amb.name}.`;
    }

    roadReason({ worst, confidence }) {
      if (!worst || worst.f < BUSY_FACTOR) return `Roads flowing freely on the way, confidence ${confidence} %.`;
      return `${worst.name} forecast at ${fmtFactor(worst.f)} on the way, confidence ${confidence} %.`;
    }

    hospitalReason({ p, hosp, route2, altHosp }) {
      if (altHosp && altHosp.route.duration < route2.duration) {
        return `${hosp.short} over ${altHosp.hosp.short}, which is closer but at ER ${fmtPct(loadShare(altHosp.hosp))}.`;
      }
      return `${hosp.short}: ${hospitalTags(hosp, p.need)}, ${BL.fmtMin(route2.duration)} from the scene.`;
    }

    outcomeReason(rec) {
      const { p, divertFrom, amb } = rec;
      if (divertFrom) return `Diverts ${amb.name} from ${divertFrom.id} (${divertFrom.cat}), who goes back to the queue.`;
      const response = responseOf(rec);
      const target = BL.PRIORITY[p.cat].target;
      if (response <= target) return `Response ${BL.fmtMin(response)}, inside the ${target / MINUTE} min target.`;
      return `Response ${BL.fmtMin(response)}, ${BL.fmtMin(response - target)} over the ${target / MINUTE} min target.`;
    }

    removeRec(rec) {
      const index = this.recs.indexOf(rec);
      if (index < 0) return false;
      this.recs.splice(index, 1);
      return true;
    }

    release(rec) {
      const { amb, p } = rec;
      if (amb.reservedBy === rec.id) amb.reservedBy = null;
      if (p.rec === rec) p.rec = null;
      if (p.status === 'pending') p.status = 'waiting';
    }

    stillValid(rec) {
      const { amb, p, divertFrom } = rec;
      if (amb.reservedBy !== rec.id || p.status !== 'pending') return false;
      if (divertFrom) return amb.state === 'toScene' && amb.patient === divertFrom;
      return FREE_STATES.includes(amb.state);
    }

    approve(rec) {
      if (!this.removeRec(rec)) return;
      const { sim } = this;
      const { amb, p } = rec;
      if (!this.stillValid(rec)) {
        this.release(rec);
        say(sim, 'coord', 'you', `${amb.name} is no longer available. Replanning ${p.id}.`);
        this.plan();
        return;
      }
      sim.dispatch(rec);
      const eta = BL.remainingTime(sim, amb);
      const etaText = eta === null ? '' : ` ETA ${BL.fmtMin(eta)}.`;
      say(sim, 'coord', 'you', `${amb.name} dispatched to ${p.id}.${etaText}`);
      this.plan();
    }

    hold(rec) {
      if (!this.removeRec(rec)) return;
      const { sim } = this;
      this.release(rec);
      rec.p.holdUntil = sim.t + HOLD_S;
      say(sim, 'coord', 'you', `${rec.p.id} on hold for ${HOLD_S / MINUTE} min. ${rec.amb.name} is free for other calls.`);
      this.plan();
    }

    onAccident(acc) {
      this.sim.ambs.filter((amb) => crossesEdge(amb, acc.e)).forEach((amb) => this.tryReroute(amb, acc));
    }

    tryReroute(amb, acc) {
      const { sim } = this;
      const current = BL.remainingTime(sim, amb);
      const route = BL.findRoute(sim, amb.loc, destinationOf(amb.path), sim.t, { siren: amb.siren, forecast: true });
      const saving = current - route.duration;
      if (saving <= REROUTE_MIN_SAVING_S) return;
      sim.reroute(amb, route);
      say(sim, 'coord', 'you', `Rerouting ${amb.name} around ${BL.EDGES[acc.e].name}. Saves ${BL.fmtMin(saving)}.`);
    }

    onUnitFree() {
      this.plan();
    }

    status() {
      const onMission = this.sim.ambs.filter((amb) => MISSION_STATES.includes(amb.state)).length;
      const pending = this.recs.length ? `, ${this.recs.length} pending` : '';
      return `${onMission} on mission${pending}`;
    }
  }

  Object.assign(BL, {
    CASES,
    AUTO_APPROVE_MS: 4000,
    createBus,
    travelTime,
    findRoute,
    routePoints,
    routeVia,
    remainingTime,
    TrafficAgent,
    TriageAgent,
    Coordinator
  });
})(window.BL);
