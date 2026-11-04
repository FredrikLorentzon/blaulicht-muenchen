'use strict';

/*
 * Shared foundation for Blaulicht München.
 * Geography of Munich in a local metre grid, the road graph, hospitals,
 * ambulance stations, map decoration geometry and small helpers.
 * Every other module reads from window.BL and never redefines what lives here.
 */
window.BL = window.BL || {};

(function (BL) {
  const GEO = { north: 48.225, south: 48.085, west: 11.445, east: 11.665, kx: 74270, ky: 111200 };
  const MAP_W = (GEO.east - GEO.west) * GEO.kx;
  const MAP_H = (GEO.north - GEO.south) * GEO.ky;

  function project(lat, lon) {
    return [(lon - GEO.west) * GEO.kx, (GEO.north - lat) * GEO.ky];
  }

  const NODE_DEFS = {
    A1: [48.1391, 11.5660], A2: [48.1340, 11.5672], A3: [48.1352, 11.5822],
    A4: [48.1393, 11.5835], A5: [48.1428, 11.5772], A6: [48.1408, 11.5690],
    HBF: [48.1403, 11.5600], HB: [48.1420, 11.5490], KP: [48.1455, 11.5655],
    SP: [48.1480, 11.5580], LP: [48.1585, 11.5355], MO: [48.1800, 11.5110],
    U: [48.1505, 11.5810], MF: [48.1622, 11.5865], R1: [48.1770, 11.5905],
    FR: [48.1885, 11.5935], FRM: [48.2010, 11.6070], AA: [48.2170, 11.6230],
    KS: [48.1738, 11.5795], R2: [48.1775, 11.5655], HZ: [48.1610, 11.5700],
    OLY: [48.1700, 11.5610], R3: [48.1790, 11.5450], R4: [48.1690, 11.5330],
    R5: [48.1532, 11.5340], R6: [48.1425, 11.5335], R7: [48.1275, 11.5235],
    R8: [48.1190, 11.5175], R9: [48.1170, 11.5365], R10: [48.1105, 11.5480],
    R11: [48.1100, 11.5670], R12: [48.1110, 11.5800], R13: [48.1150, 11.6120],
    R14: [48.1270, 11.6200], R15: [48.1355, 11.6195], R16: [48.1460, 11.6190],
    R17: [48.1555, 11.6170], R18: [48.1620, 11.6130], R19: [48.1660, 11.6000],
    RP: [48.1575, 11.5150], PA: [48.1495, 11.4615], LA: [48.1430, 11.5030],
    TW: [48.1365, 11.5480], EP: [48.1335, 11.5560], GP: [48.1290, 11.5575],
    IP: [48.1225, 11.5450], WF: [48.1150, 11.4950], GH: [48.1100, 11.4700],
    FH: [48.1305, 11.5730], KO: [48.1210, 11.5770], RSP: [48.1290, 11.5930],
    OB: [48.1275, 11.6045], NP: [48.0990, 11.6495], HAR: [48.0935, 11.5720],
    MW: [48.1355, 11.5985], HDK: [48.1440, 11.5860], FE: [48.1410, 11.5975],
    PP: [48.1385, 11.6065], BH: [48.1495, 11.6075],
    H_IN: [48.1305, 11.5600], H_RDI: [48.1372, 11.6005], H_BOG: [48.1565, 11.6290],
    H_DO: [48.1600, 11.5195]
  };

  const EDGE_DEFS = [
    ['A1', 'A2', 'art', 'Altstadtring'], ['A2', 'A3', 'art', 'Altstadtring'],
    ['A3', 'A4', 'art', 'Altstadtring'], ['A4', 'A5', 'art', 'Altstadtring'],
    ['A5', 'A6', 'art', 'Altstadtring'], ['A6', 'A1', 'art', 'Altstadtring'],
    ['A1', 'HBF', 'art', 'Prielmayerstraße'], ['HBF', 'HB', 'art', 'Arnulfstraße'],
    ['HB', 'R6', 'art', 'Arnulfstraße'], ['R6', 'LA', 'art', 'Landsberger Straße'],
    ['LA', 'PA', 'art', 'Landsberger Straße'], ['HBF', 'SP', 'art', 'Dachauer Straße'],
    ['SP', 'LP', 'art', 'Dachauer Straße'], ['LP', 'MO', 'art', 'Dachauer Straße'],
    ['A6', 'KP', 'local', 'Brienner Straße'], ['KP', 'SP', 'local', 'Brienner Straße'],
    ['A5', 'U', 'art', 'Ludwigstraße'], ['U', 'MF', 'art', 'Leopoldstraße'],
    ['MF', 'R1', 'art', 'Leopoldstraße'], ['R1', 'FR', 'art', 'Ungererstraße'],
    ['FR', 'FRM', 'hwy', 'A9'], ['FRM', 'AA', 'hwy', 'A9'],
    ['MF', 'KS', 'local', 'Parzivalstraße'], ['KS', 'R2', 'local', 'Belgradstraße'],
    ['KS', 'R1', 'local', 'Parzivalplatz'], ['R2', 'HZ', 'art', 'Schleißheimer Straße'],
    ['HZ', 'SP', 'art', 'Schleißheimer Straße'], ['HZ', 'MF', 'local', 'Hohenzollernstraße'],
    ['HZ', 'OLY', 'local', 'Ackermannstraße'], ['OLY', 'R2', 'local', 'Lerchenauer Straße'],
    ['R1', 'R2', 'ring', 'Petuelring'], ['R2', 'R3', 'ring', 'Georg-Brauchle-Ring'],
    ['R3', 'R4', 'ring', 'Landshuter Allee'], ['R4', 'LP', 'ring', 'Landshuter Allee'],
    ['LP', 'R5', 'ring', 'Landshuter Allee'], ['R5', 'R6', 'ring', 'Landshuter Allee'],
    ['R6', 'R7', 'ring', 'Trappentreustraße'], ['R7', 'R8', 'ring', 'Garmischer Straße'],
    ['R8', 'R9', 'ring', 'Heckenstallerstraße'], ['R9', 'R10', 'ring', 'Brudermühlstraße'],
    ['R10', 'R11', 'ring', 'Brudermühlbrücke', true], ['R11', 'R12', 'ring', 'Mittlerer Ring Süd'],
    ['R12', 'R13', 'ring', 'Mittlerer Ring Süd'], ['R13', 'R14', 'ring', 'Innsbrucker Ring'],
    ['R14', 'R15', 'ring', 'Innsbrucker Ring'], ['R15', 'R16', 'ring', 'Richard-Strauss-Straße'],
    ['R16', 'R17', 'ring', 'Richard-Strauss-Straße'], ['R17', 'R18', 'ring', 'Isarring'],
    ['R18', 'R19', 'ring', 'Kennedybrücke', true], ['R19', 'R1', 'ring', 'Isarring'],
    ['MO', 'R3', 'art', 'Hanauer Straße'], ['MO', 'R4', 'local', 'Baldurstraße'],
    ['RP', 'R5', 'art', 'Romanstraße'], ['RP', 'LA', 'local', 'Wotanstraße'],
    ['RP', 'PA', 'art', 'Verdistraße'], ['RP', 'H_DO', 'local', 'Menzinger Straße'],
    ['HB', 'TW', 'local', 'Theresienhöhe'], ['TW', 'EP', 'local', 'Bavariaring'],
    ['EP', 'GP', 'local', 'Bavariaring'], ['TW', 'R7', 'local', 'Westendstraße'],
    ['A2', 'GP', 'art', 'Lindwurmstraße'], ['GP', 'IP', 'art', 'Lindwurmstraße'],
    ['IP', 'R9', 'art', 'Plinganserstraße'], ['GP', 'H_IN', 'local', 'Ziemssenstraße'],
    ['R8', 'WF', 'art', 'Fürstenrieder Straße'], ['WF', 'GH', 'art', 'Würmtalstraße'],
    ['LA', 'WF', 'art', 'Fürstenrieder Straße'], ['A2', 'FH', 'local', 'Müllerstraße'],
    ['FH', 'KO', 'art', 'Reichenbachbrücke', true], ['KO', 'R12', 'art', 'Tegernseer Landstraße'],
    ['KO', 'RSP', 'local', 'Hochstraße'], ['R11', 'KO', 'local', 'Candidstraße'],
    ['A3', 'RSP', 'art', 'Ludwigsbrücke', true], ['RSP', 'OB', 'art', 'Rosenheimer Straße'],
    ['OB', 'R14', 'art', 'Rosenheimer Straße'], ['R13', 'NP', 'art', 'Ständlerstraße'],
    ['R12', 'HAR', 'art', 'Tegernseer Landstraße'], ['A4', 'MW', 'art', 'Maximiliansbrücke', true],
    ['MW', 'RSP', 'local', 'Wiener Platz'], ['MW', 'H_RDI', 'local', 'Ismaninger Straße'],
    ['MW', 'FE', 'local', 'Ismaninger Straße'], ['A5', 'HDK', 'art', 'Von-der-Tann-Straße'],
    ['HDK', 'FE', 'art', 'Prinzregentenbrücke', true], ['FE', 'PP', 'art', 'Prinzregentenstraße'],
    ['PP', 'R16', 'art', 'Prinzregentenstraße'], ['FE', 'BH', 'art', 'Ismaninger Straße'],
    ['BH', 'R17', 'art', 'Ismaninger Straße'], ['R17', 'H_BOG', 'local', 'Englschalkinger Straße'],
    ['MW', 'R15', 'art', 'Einsteinstraße'], ['U', 'HDK', 'local', 'Königinstraße']
  ];

  const BASE_SPEED = { hwy: 22, ring: 16.5, art: 13.5, local: 9.5 };
  const COMMUTE = { hwy: 0.9, ring: 1.0, art: 0.8, local: 0.5 };

  const NODES = Object.entries(NODE_DEFS).map(([id, [lat, lon]], i) => {
    const [x, y] = project(lat, lon);
    return { id, i, x, y };
  });
  const NODE = Object.fromEntries(NODES.map((n) => [n.id, n]));

  const EDGES = EDGE_DEFS.map(([a, b, type, name, bridge], i) => {
    const A = NODE[a];
    const B = NODE[b];
    return {
      i,
      a: A.i,
      b: B.i,
      type,
      name,
      bridge: Boolean(bridge),
      len: Math.hypot(B.x - A.x, B.y - A.y),
      mx: (A.x + B.x) / 2,
      my: (A.y + B.y) / 2,
      ang: Math.atan2(B.y - A.y, B.x - A.x),
      commute: COMMUTE[type] * (bridge ? 1.15 : 1),
      neighbors: []
    };
  });

  const ADJ = NODES.map(() => []);
  EDGES.forEach((e) => {
    ADJ[e.a].push({ e, to: e.b });
    ADJ[e.b].push({ e, to: e.a });
  });
  EDGES.forEach((e) => {
    const ids = new Set([...ADJ[e.a], ...ADJ[e.b]].map((x) => x.e.i));
    ids.delete(e.i);
    e.neighbors = [...ids];
  });

  const HOSPITALS = [
    { id: 'GH', node: 'GH', name: 'LMU Klinikum Großhadern', short: 'Großhadern', caps: ['trauma', 'stroke', 'cardiac', 'general'], capacity: 26 },
    { id: 'IN', node: 'H_IN', name: 'LMU Klinikum Innenstadt', short: 'Innenstadt', caps: ['cardiac', 'pediatric', 'obstetrics', 'general'], capacity: 18 },
    { id: 'RDI', node: 'H_RDI', name: 'TUM Klinikum rechts der Isar', short: 'Rechts der Isar', caps: ['trauma', 'stroke', 'cardiac', 'general'], capacity: 22 },
    { id: 'SCH', node: 'KS', name: 'München Klinik Schwabing', short: 'Schwabing', caps: ['pediatric', 'obstetrics', 'stroke', 'general'], capacity: 18 },
    { id: 'BOG', node: 'H_BOG', name: 'München Klinik Bogenhausen', short: 'Bogenhausen', caps: ['trauma', 'stroke', 'cardiac', 'general'], capacity: 20 },
    { id: 'HAR', node: 'HAR', name: 'München Klinik Harlaching', short: 'Harlaching', caps: ['cardiac', 'stroke', 'obstetrics', 'general'], capacity: 16 },
    { id: 'NP', node: 'NP', name: 'München Klinik Neuperlach', short: 'Neuperlach', caps: ['cardiac', 'obstetrics', 'general'], capacity: 14 },
    { id: 'DO', node: 'H_DO', name: 'Klinikum Dritter Orden', short: 'Dritter Orden', caps: ['pediatric', 'obstetrics', 'cardiac', 'general'], capacity: 14 }
  ];

  const CAP_LABEL = {
    cardiac: 'Cath lab',
    stroke: 'Stroke unit',
    trauma: 'Trauma centre',
    pediatric: 'Children’s ER',
    obstetrics: 'Maternity',
    general: 'Emergency room'
  };

  const STATIONS = [
    { id: 'S1', node: 'A2', name: 'Feuerwache 1 Altstadt' },
    { id: 'S2', node: 'PA', name: 'Rettungswache Pasing' },
    { id: 'S3', node: 'MO', name: 'Rettungswache Moosach' },
    { id: 'S4', node: 'FR', name: 'Rettungswache Freimann' },
    { id: 'S5', node: 'R14', name: 'Rettungswache Berg am Laim' },
    { id: 'S6', node: 'R12', name: 'Rettungswache Giesing' },
    { id: 'S7', node: 'IP', name: 'Rettungswache Sendling' },
    { id: 'S8', node: 'BH', name: 'Rettungswache Bogenhausen' }
  ];

  const PRIORITY = {
    RED: { key: 'RED', label: 'Immediate', target: 8 * 60, min: 88, rank: 0 },
    ORANGE: { key: 'ORANGE', label: 'Very urgent', target: 12 * 60, min: 72, rank: 1 },
    YELLOW: { key: 'YELLOW', label: 'Urgent', target: 20 * 60, min: 55, rank: 2 },
    GREEN: { key: 'GREEN', label: 'Standard', target: 30 * 60, min: 0, rank: 3 }
  };

  const ISAR = [
    [48.0850, 11.5470], [48.0950, 11.5450], [48.1010, 11.5470], [48.1080, 11.5510],
    [48.1140, 11.5570], [48.1200, 11.5640], [48.1250, 11.5710], [48.1290, 11.5775],
    [48.1310, 11.5830], [48.1335, 11.5862], [48.1370, 11.5898], [48.1420, 11.5935],
    [48.1495, 11.5995], [48.1580, 11.6050], [48.1650, 11.6105], [48.1720, 11.6160],
    [48.1800, 11.6200], [48.1900, 11.6230], [48.2000, 11.6280], [48.2100, 11.6310],
    [48.2250, 11.6350]
  ].map(([lat, lon]) => project(lat, lon));

  const PARKS = [
    {
      name: 'Englischer Garten',
      label: [48.1600, 11.5960],
      poly: [[48.1435, 11.5830], [48.1440, 11.5880], [48.1500, 11.5930], [48.1560, 11.5960], [48.1640, 11.6010],
        [48.1720, 11.6080], [48.1800, 11.6110], [48.1830, 11.6050], [48.1760, 11.5990], [48.1680, 11.5940],
        [48.1600, 11.5905], [48.1530, 11.5880], [48.1470, 11.5850]]
    },
    { name: 'Olympiapark', label: [48.1735, 11.5500], poly: [[48.1680, 11.5420], [48.1690, 11.5590], [48.1770, 11.5595], [48.1780, 11.5460], [48.1735, 11.5410]] },
    { name: 'Nymphenburger Park', label: [48.1590, 11.4930], poly: [[48.1540, 11.4880], [48.1540, 11.5000], [48.1620, 11.5040], [48.1640, 11.4920], [48.1600, 11.4830]] },
    { name: 'Westpark', label: [48.1205, 11.5110], poly: [[48.1210, 11.5050], [48.1230, 11.5230], [48.1185, 11.5240], [48.1170, 11.5060]] },
    { name: 'Hirschgarten', label: [48.1460, 11.5165], poly: [[48.1470, 11.5100], [48.1480, 11.5220], [48.1445, 11.5230], [48.1440, 11.5110]] },
    { name: 'Luitpoldpark', label: [48.1668, 11.5700], poly: [[48.1680, 11.5650], [48.1690, 11.5740], [48.1650, 11.5745], [48.1645, 11.5660]] },
    { name: 'Ostpark', label: [48.1110, 11.6410], poly: [[48.1130, 11.6350], [48.1135, 11.6460], [48.1095, 11.6470], [48.1085, 11.6360]] },
    { name: 'Perlacher Forst', label: [48.0900, 11.6020], poly: [[48.0850, 11.5850], [48.0850, 11.6200], [48.0950, 11.6150], [48.0960, 11.5900]] }
  ].map((p) => ({ name: p.name, label: project(p.label[0], p.label[1]), poly: p.poly.map(([lat, lon]) => project(lat, lon)) }));

  const WIESN = { center: project(48.1310, 11.5490), rx: 380, ry: 330 };
  const ARENA = project(48.2188, 11.6247);

  const NEIGHBORHOODS = [
    ['Altstadt', 48.1370, 11.5760], ['Maxvorstadt', 48.1500, 11.5700], ['Schwabing', 48.1650, 11.5800],
    ['Neuhausen', 48.1530, 11.5450], ['Nymphenburg', 48.1650, 11.5100], ['Laim', 48.1380, 11.5030],
    ['Pasing', 48.1450, 11.4650], ['Sendling', 48.1190, 11.5450], ['Westend', 48.1350, 11.5350],
    ['Haidhausen', 48.1300, 11.5980], ['Giesing', 48.1100, 11.5900], ['Bogenhausen', 48.1500, 11.6220],
    ['Berg am Laim', 48.1260, 11.6330], ['Ramersdorf', 48.1120, 11.6250], ['Neuperlach', 48.1030, 11.6560],
    ['Moosach', 48.1830, 11.5150], ['Milbertshofen', 48.1850, 11.5700], ['Freimann', 48.2020, 11.6000],
    ['Harlaching', 48.0920, 11.5800], ['Thalkirchen', 48.1000, 11.5400], ['Großhadern', 48.1050, 11.4800]
  ].map(([name, lat, lon]) => {
    const [x, y] = project(lat, lon);
    return { name, x, y };
  });

  const LANDMARKS = [
    { id: 'frauenkirche', name: 'Frauenkirche', pos: project(48.1386, 11.5736) },
    { id: 'olympiaturm', name: 'Olympiaturm', pos: project(48.1743, 11.5537) },
    { id: 'arena', name: 'Allianz Arena', pos: ARENA },
    { id: 'friedensengel', name: 'Friedensengel', pos: project(48.1415, 11.5946) },
    { id: 'chinaturm', name: 'Chinesischer Turm', pos: project(48.1527, 11.5925) },
    { id: 'nymphenburg', name: 'Schloss Nymphenburg', pos: project(48.1583, 11.5033) },
    { id: 'museum', name: 'Deutsches Museum', pos: project(48.1299, 11.5834) },
    { id: 'riesenrad', name: 'Oktoberfest', pos: WIESN.center }
  ];

  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return { d: Math.hypot(px - qx, py - qy), t };
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function nodeLoc(nodeIdx) {
    const { e } = ADJ[nodeIdx][0];
    return { e: e.i, t: e.a === nodeIdx ? 0 : 1 };
  }

  function pointAt(loc) {
    const e = EDGES[loc.e];
    const A = NODES[e.a];
    const B = NODES[e.b];
    return [A.x + (B.x - A.x) * loc.t, A.y + (B.y - A.y) * loc.t];
  }

  function nearestLoc(x, y) {
    let best = null;
    for (const e of EDGES) {
      const A = NODES[e.a];
      const B = NODES[e.b];
      const r = segDist(x, y, A.x, A.y, B.x, B.y);
      if (!best || r.d < best.d) best = { d: r.d, e: e.i, t: r.t };
    }
    return { e: best.e, t: best.t, d: best.d };
  }

  function nearestNeighborhood(x, y) {
    let best = NEIGHBORHOODS[0];
    let bd = Infinity;
    for (const n of NEIGHBORHOODS) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best.name;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function fmtClock(t) {
    const day = DAY_NAMES[Math.floor(t / 86400) % 7];
    const s = ((t % 86400) + 86400) % 86400;
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    return { day, hm: `${h}:${m}` };
  }

  function fmtMin(seconds) {
    return `${(seconds / 60).toFixed(1)} min`;
  }

  const CLOSURE_FACTOR = 30;
  const CLOSURE_SPILL = 0.9;

  function edgeBetween(a, b) {
    const ia = NODE[a].i;
    const ib = NODE[b].i;
    const edge = EDGES.find((e) => (e.a === ia && e.b === ib) || (e.a === ib && e.b === ia));
    if (!edge) throw new Error(`No road between ${a} and ${b}`);
    return edge.i;
  }

  function place(name, lat, lon, people, radius) {
    const [x, y] = project(lat, lon);
    return { name, x, y, people, radius };
  }

  function hotspot(lat, lon, radius, load) {
    const [x, y] = project(lat, lon);
    return { x, y, radius, load };
  }

  const SCENARIO_DEFS = [
    {
      id: 'normal',
      name: 'Normal day',
      icon: '🏙️',
      tagline: 'A regular Tuesday with commuter peaks',
      startTime: null,
      callRate: 1,
      crowdCallShare: 0,
      caseBoost: {},
      typeLoad: {},
      hotspots: [],
      closurePairs: [],
      crowds: [],
      briefing: {
        traffic: 'Back to a normal day. Only commuter peaks and incidents shape the forecast.',
        triage: 'Call mix back to the usual city average.'
      }
    },
    {
      id: 'marathon',
      name: 'München Marathon',
      icon: '🏃',
      tagline: 'Course closed from Olympiapark through the Altstadt to Bogenhausen',
      startTime: '10:00',
      callRate: 1.3,
      crowdCallShare: 0.45,
      caseBoost: { breathing: 2.5, unconscious: 2.5, cardiac_arrest: 1.8, minor_injury: 1.5 },
      typeLoad: {},
      hotspots: [hotspot(48.1731, 11.5466, 1400, 0.8), hotspot(48.1400, 11.5800, 1600, 0.6)],
      closurePairs: [
        ['OLY', 'HZ'], ['HZ', 'MF'], ['MF', 'U'], ['U', 'A5'], ['U', 'HDK'], ['A5', 'HDK'],
        ['A5', 'A4'], ['A4', 'A3'], ['A3', 'A2'], ['A4', 'MW'], ['MW', 'FE'], ['HDK', 'FE'],
        ['FE', 'BH'], ['OLY', 'R2']
      ],
      crowds: [
        place('Finish at the Olympiastadion', 48.1731, 11.5466, 18000, 450),
        place('Spectators at Odeonsplatz', 48.1427, 11.5774, 7000, 300),
        place('Spectators at Marienplatz', 48.1374, 11.5755, 6000, 280),
        place('Spectators at Münchner Freiheit', 48.1621, 11.5866, 4000, 260),
        place('Runners in the Englischer Garten', 48.1560, 11.5930, 9000, 420)
      ],
      briefing: {
        traffic: 'Marathon course closed: Leopoldstraße, Ludwigstraße, Altstadtring East and the Isar bridges to Haidhausen. Diversions push ×1.9 onto the side roads. I route every unit around the course.',
        triage: 'Expect collapsed runners, breathing problems and heat exhaustion along the course. Cardiac arrests near the finish are the biggest risk.'
      }
    },
    {
      id: 'christmas',
      name: 'Christmas markets',
      icon: '🎄',
      tagline: 'Christkindlmarkt, Tollwood and crowded Altstadt evenings',
      startTime: '18:00',
      callRate: 1.25,
      crowdCallShare: 0.4,
      caseBoost: { hip_fall: 2.2, intoxication: 3, minor_injury: 1.6, allergy: 1.3 },
      typeLoad: {},
      hotspots: [hotspot(48.1374, 11.5755, 1500, 1.2), hotspot(48.1310, 11.5490, 1200, 0.8), hotspot(48.1527, 11.5925, 900, 0.5)],
      closurePairs: [],
      crowds: [
        place('Christkindlmarkt at Marienplatz', 48.1374, 11.5755, 25000, 380),
        place('Tollwood on the Theresienwiese', 48.1310, 11.5490, 15000, 420),
        place('Kaiserhof market at the Residenz', 48.1410, 11.5790, 6000, 260),
        place('Market at the Chinesischer Turm', 48.1527, 11.5925, 5000, 280),
        place('Schwabinger Weihnachtsmarkt', 48.1621, 11.5866, 4000, 240),
        place('Haidhausen market at Weißenburger Platz', 48.1290, 11.5980, 3000, 220)
      ],
      briefing: {
        traffic: 'Christmas markets are open. Altstadtring up to ×2.2, slow traffic around the Theresienwiese and the Englischer Garten. Pedestrians spill onto the roads near Marienplatz.',
        triage: 'Expect falls on icy cobblestones, mulled wine intoxication and minor injuries in the crowds. 58,000 people are at the markets right now.'
      }
    },
    {
      id: 'match',
      name: 'FC Bayern home game',
      icon: '⚽',
      tagline: '75,000 fans at the Allianz Arena, A9 jammed around kick-off',
      startTime: '19:30',
      callRate: 1.2,
      crowdCallShare: 0.35,
      caseBoost: { intoxication: 2.5, trauma: 1.6, minor_injury: 1.6, chest_pain: 1.3 },
      typeLoad: { hwy: 0.8 },
      hotspots: [hotspot(48.2188, 11.6247, 4200, 2.0), hotspot(48.1621, 11.5866, 1200, 0.6)],
      closurePairs: [],
      crowds: [
        place('Allianz Arena', 48.2188, 11.6247, 75000, 600),
        place('Fröttmaning station', 48.2140, 11.6160, 12000, 320),
        place('Fans at Münchner Freiheit', 48.1621, 11.5866, 3000, 240)
      ],
      briefing: {
        traffic: 'FC Bayern kicks off at 20:30. A9 and Ungererstraße toward Fröttmaning at ×3 and worse. The north of the city is slow until the fans are inside.',
        triage: 'Expect intoxication, scuffles and minor injuries around the arena, and chest pain in the stands. 75,000 people in one place.'
      }
    },
    {
      id: 'wiesn',
      name: 'Oktoberfest',
      icon: '🎡',
      tagline: 'The Wiesn is full and the Theresienwiese is gridlocked',
      startTime: '21:00',
      callRate: 1.35,
      crowdCallShare: 0.45,
      caseBoost: { intoxication: 4, minor_injury: 1.5, trauma: 1.3 },
      typeLoad: {},
      hotspots: [hotspot(48.1310, 11.5490, 1600, 1.5)],
      closurePairs: [],
      crowds: [
        place('Oktoberfest on the Theresienwiese', 48.1310, 11.5490, 120000, 520),
        place('Hauptbahnhof crowds', 48.1403, 11.5600, 8000, 260)
      ],
      briefing: {
        traffic: 'Oktoberfest is on. Theresienhöhe, Bavariaring and Lindwurmstraße up to ×2.5. Arnulfstraße slow toward the Hauptbahnhof.',
        triage: 'Expect a wave of intoxication calls and falls around the Theresienwiese. 120,000 people on the Wiesn.'
      }
    }
  ];

  const SCENARIOS = SCENARIO_DEFS.map((def) => {
    const closures = new Set(def.closurePairs.map(([a, b]) => edgeBetween(a, b)));
    const spill = new Set();
    closures.forEach((i) => EDGES[i].neighbors.forEach((n) => { if (!closures.has(n)) spill.add(n); }));
    const people = def.crowds.reduce((sum, c) => sum + c.people, 0);
    return { ...def, closures, spill, people };
  });
  const SCENARIO = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

  function scenarioEdgeEffect(def, edge) {
    if (def.closures.has(edge.i)) return { load: 0, closed: true };
    let load = def.typeLoad[edge.type] || 0;
    if (def.spill.has(edge.i)) load += CLOSURE_SPILL;
    for (const h of def.hotspots) {
      const d = Math.hypot(edge.mx - h.x, edge.my - h.y);
      load += h.load * Math.max(0, 1 - d / h.radius);
    }
    return { load, closed: false };
  }

  function pickCrowd(def, random) {
    if (!def.crowds.length) return null;
    let r = random() * def.people;
    for (const c of def.crowds) {
      r -= c.people;
      if (r <= 0) return c;
    }
    return def.crowds[def.crowds.length - 1];
  }

  function crowdAt(def, x, y) {
    return def.crowds.find((c) => Math.hypot(c.x - x, c.y - y) <= c.radius * 2.5) || null;
  }

  Object.assign(BL, {
    SCENARIOS, SCENARIO, CLOSURE_FACTOR, scenarioEdgeEffect, pickCrowd, crowdAt,
    GEO, MAP_W, MAP_H, project,
    NODES, NODE, EDGES, ADJ, BASE_SPEED, COMMUTE,
    HOSPITALS, CAP_LABEL, STATIONS, PRIORITY,
    ISAR, PARKS, WIESN, ARENA, NEIGHBORHOODS, LANDMARKS,
    segDist, pointInPoly, nodeLoc, pointAt, nearestLoc, nearestNeighborhood,
    mulberry32, fmtClock, fmtMin,
    SIM_RATE: 20,
    SIREN_RELIEF: 0.45,
    START_T: 86400 + 7 * 3600 + 35 * 60
  });
})(window.BL);
