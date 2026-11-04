'use strict';

/*
 * Map view for Blaulicht München.
 * Draws the toy city once from the shared geography, then keeps ambulances,
 * patients, routes, accidents, scenario crowds and the traffic overlay in sync
 * with the simulation by updating attributes on nodes created once per entity.
 */
(function (BL) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ROAD_TYPES = ['local', 'art', 'hwy', 'ring'];
  const CASING_PX = { local: 6, art: 8, ring: 10, hwy: 10 };
  const FILL_PX = { local: 3.5, art: 5, ring: 7, hwy: 7 };
  const TRAFFIC_PX = { local: 2, art: 3, ring: 4, hwy: 4 };
  const TRAFFIC_STEPS = [1.3, 1.8, 2.5];
  const TRAFFIC_MODES = ['off', 'live', 'forecast'];
  const FORECAST_AHEAD_S = 900;
  const TRAFFIC_REDRAW_MS = 2000;
  const TOOLTIP_REFRESH_MS = 250;

  const MIN_VIEW_W = 2500;
  const MAX_VIEW_W = 1.15 * BL.MAP_W;
  const FIT_MARGIN = 1.03;
  const FOCUS_MS = 600;
  const BUTTON_ZOOM_MS = 280;
  const BUTTON_ZOOM_STEP = 1.6;
  const DEFAULT_FOCUS_W = 4000;
  const WHEEL_ZOOM_RATE = 0.0015;
  const CLICK_SLOP_PX = 5;
  const CLOSE_ZOOM_MPP = 7;
  const FAR_ZOOM_MPP = 13;

  const CITY_SEED = 112;
  const CITY_CENTRE = BL.project(48.1374, 11.5755);
  const BUILDING_COUNT = 1500;
  const BUILDING_TRIES = 80000;
  const BUILDING_PALETTE_SIZE = 6;
  const BUILDING_GRID_M = 120;
  const ROAD_CLEARANCE_M = 70;
  const RIVER_CLEARANCE_M = 140;
  const BUILDING_SHADOW = [10, 14];
  const TREE_ROAD_CLEARANCE_M = 50;
  const TREE_RIVER_CLEARANCE_M = 110;
  const TREE_AREA_M2 = 7500;
  const FOREST_TREE_AREA_M2 = 4200;
  const FORESTS = new Set(['Perlacher Forst']);
  const RIVER_BANK_M = 190;
  const RIVER_WATER_M = 120;
  const RIVER_RUNOUT_M = 1500;

  const LAKES = [
    { centre: BL.project(48.1722, 11.5478), rx: 300, ry: 85, rotDeg: -6 },
    { centre: BL.project(48.1612, 11.5948), rx: 150, ry: 85, rotDeg: 35 }
  ];

  const STATE_LABEL = {
    idle: 'Idle at station',
    toScene: 'Driving to scene',
    onScene: 'On scene',
    toHospital: 'Transport to hospital',
    handover: 'Handover at hospital',
    returning: 'Returning to station'
  };

  const TOOLTIP_LIFT_PX = { patient: 36, ambulance: 26, hospital: 20, station: 18, accident: 18, landmark: 40, crowd: 22, closure: 14 };
  const HIDDEN_PATIENT_STATUS = new Set(['transport', 'delivered']);
  const ROUTE_STATES = { toScene: 'to-scene', toHospital: 'to-hosp' };
  const PEOPLE_FORMAT = new Intl.NumberFormat('en-US');

  function svgNode(tag, attrs, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function htmlNode(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function drawShapes(parent, shapes) {
    shapes.forEach(([tag, attrs]) => svgNode(tag, attrs, parent));
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function easeInOutCubic(k) {
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function pt(p) {
    return `${p[0].toFixed(0)} ${p[1].toFixed(0)}`;
  }

  function polylineD(points) {
    return points.map((p, i) => `${i ? 'L' : 'M'}${pt(p)}`).join('');
  }

  function smoothD(points, closed) {
    const n = points.length;
    const at = (i) => (closed ? points[(i + n) % n] : points[clamp(i, 0, n - 1)]);
    const segments = closed ? n : n - 1;
    let d = `M${pt(points[0])}`;
    for (let i = 0; i < segments; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${pt(c1)} ${pt(c2)} ${pt(p2)}`;
    }
    return closed ? `${d}Z` : d;
  }

  function roundedRectD(cx, cy, w, h, ang, r) {
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const hw = w / 2;
    const hh = h / 2;
    const P = (x, y) => pt([cx + x * cos - y * sin, cy + x * sin + y * cos]);
    return `M${P(-hw + r, -hh)}L${P(hw - r, -hh)}Q${P(hw, -hh)} ${P(hw, -hh + r)}`
      + `L${P(hw, hh - r)}Q${P(hw, hh)} ${P(hw - r, hh)}`
      + `L${P(-hw + r, hh)}Q${P(-hw, hh)} ${P(-hw, hh - r)}`
      + `L${P(-hw, -hh + r)}Q${P(-hw, -hh)} ${P(-hw + r, -hh)}Z`;
  }

  function circleD(x, y, r) {
    const rr = r.toFixed(0);
    return `M${(x - r).toFixed(0)} ${y.toFixed(0)}a${rr} ${rr} 0 1 0 ${(2 * r).toFixed(0)} 0a${rr} ${rr} 0 1 0 ${(-2 * r).toFixed(0)} 0Z`;
  }

  function edgeEnds(edge) {
    return [BL.NODES[edge.a], BL.NODES[edge.b]];
  }

  function nearestEdge(x, y) {
    let best = { d: Infinity, edge: BL.EDGES[0] };
    for (const edge of BL.EDGES) {
      const [A, B] = edgeEnds(edge);
      const { d } = BL.segDist(x, y, A.x, A.y, B.x, B.y);
      if (d < best.d) best = { d, edge };
    }
    return best;
  }

  function distToPolyline(x, y, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1];
      const [bx, by] = points[i];
      best = Math.min(best, BL.segDist(x, y, ax, ay, bx, by).d);
    }
    return best;
  }

  function isInEllipse(x, y, cx, cy, rx, ry, rotDeg) {
    const a = (-rotDeg * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return (lx / rx) ** 2 + (ly / ry) ** 2 <= 1;
  }

  function isInLake(x, y, pad) {
    return LAKES.some((lake) => isInEllipse(x, y, lake.centre[0], lake.centre[1], lake.rx + pad, lake.ry + pad, lake.rotDeg));
  }

  function isOnWiesn(x, y, pad) {
    const [cx, cy] = BL.WIESN.center;
    return isInEllipse(x, y, cx, cy, BL.WIESN.rx + pad, BL.WIESN.ry + pad, 0);
  }

  function isInAnyPark(x, y, reach) {
    const probes = [[x, y], [x - reach, y], [x + reach, y], [x, y - reach], [x, y + reach]];
    return BL.PARKS.some((park) => probes.some(([px, py]) => BL.pointInPoly(px, py, park.poly)));
  }

  function polygonArea(poly) {
    let sum = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      sum += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    }
    return Math.abs(sum) / 2;
  }

  function polygonBounds(poly) {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  function extendedRiver() {
    const pts = BL.ISAR;
    const runout = (from, to) => {
      const dx = from[0] - to[0];
      const dy = from[1] - to[1];
      const len = Math.hypot(dx, dy);
      return [from[0] + (dx / len) * RIVER_RUNOUT_M, from[1] + (dy / len) * RIVER_RUNOUT_M];
    };
    return [runout(pts[0], pts[1]), ...pts, runout(pts[pts.length - 1], pts[pts.length - 2])];
  }

  function createBuildingGrid() {
    const cells = new Map();
    const cellKey = (b) => `${Math.floor(b.cx / BUILDING_GRID_M)},${Math.floor(b.cy / BUILDING_GRID_M)}`;
    return {
      fits(b) {
        const gx = Math.floor(b.cx / BUILDING_GRID_M);
        const gy = Math.floor(b.cy / BUILDING_GRID_M);
        for (let ix = gx - 1; ix <= gx + 1; ix++) {
          for (let iy = gy - 1; iy <= gy + 1; iy++) {
            for (const other of cells.get(`${ix},${iy}`) || []) {
              if (Math.hypot(other.cx - b.cx, other.cy - b.cy) < (other.reach + b.reach) * 0.95) return false;
            }
          }
        }
        return true;
      },
      add(b) {
        const k = cellKey(b);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(b);
      }
    };
  }

  function isBuildingSpotFree(x, y, reach) {
    return nearestEdge(x, y).d >= ROAD_CLEARANCE_M + reach
      && distToPolyline(x, y, BL.ISAR) >= RIVER_CLEARANCE_M + reach
      && !isOnWiesn(x, y, reach + 40)
      && !isInAnyPark(x, y, reach);
  }

  function generateBuildings(rand) {
    const buildings = [];
    const grid = createBuildingGrid();
    for (let tries = 0; buildings.length < BUILDING_COUNT && tries < BUILDING_TRIES; tries++) {
      const cx = rand() * BL.MAP_W;
      const cy = rand() * BL.MAP_H;
      const dist = Math.hypot(cx - CITY_CENTRE[0], cy - CITY_CENTRE[1]);
      if (rand() > 0.08 + 0.92 * Math.exp(-dist / 3600)) continue;
      const w = 50 + rand() * 60;
      const h = 40 + rand() * 50;
      const b = { cx, cy, w, h, reach: Math.max(w, h) / 2, color: Math.floor(rand() * BUILDING_PALETTE_SIZE) };
      if (!grid.fits(b) || !isBuildingSpotFree(cx, cy, b.reach)) continue;
      b.ang = nearestEdge(cx, cy).edge.ang;
      grid.add(b);
      buildings.push(b);
    }
    return buildings;
  }

  function isTreeSpotFree(x, y, poly) {
    return BL.pointInPoly(x, y, poly)
      && nearestEdge(x, y).d >= TREE_ROAD_CLEARANCE_M
      && distToPolyline(x, y, BL.ISAR) >= TREE_RIVER_CLEARANCE_M
      && !isInLake(x, y, 40);
  }

  function generateTrees(rand) {
    const trees = [];
    BL.PARKS.forEach((park) => {
      const box = polygonBounds(park.poly);
      const perTree = FORESTS.has(park.name) ? FOREST_TREE_AREA_M2 : TREE_AREA_M2;
      const target = Math.round(polygonArea(park.poly) / perTree);
      for (let placed = 0, tries = 0; placed < target && tries < target * 10; tries++) {
        const x = box.x0 + rand() * (box.x1 - box.x0);
        const y = box.y0 + rand() * (box.y1 - box.y0);
        if (!isTreeSpotFree(x, y, park.poly)) continue;
        trees.push({ x, y, r: 24 + rand() * 22 });
        placed++;
      }
    });
    return trees.sort((a, b) => a.y - b.y);
  }

  function drawLand(layer) {
    svgNode('rect', { class: 'land', x: -BL.MAP_W, y: -BL.MAP_H, width: 3 * BL.MAP_W, height: 3 * BL.MAP_H }, layer);
  }

  function drawWiesnGround(layer) {
    const [cx, cy] = BL.WIESN.center;
    svgNode('ellipse', { class: 'wiesn-ground', cx, cy, rx: BL.WIESN.rx, ry: BL.WIESN.ry }, layer);
    svgNode('ellipse', { class: 'wiesn-inner', cx, cy, rx: BL.WIESN.rx * 0.72, ry: BL.WIESN.ry * 0.68 }, layer);
  }

  function drawParks(layer, trees) {
    BL.PARKS.forEach((park) => svgNode('path', { class: 'park', d: smoothD(park.poly, true) }, layer));
    LAKES.forEach((lake) => {
      const transform = `rotate(${lake.rotDeg} ${lake.centre[0].toFixed(0)} ${lake.centre[1].toFixed(0)})`;
      svgNode('ellipse', { class: 'lake', cx: lake.centre[0], cy: lake.centre[1], rx: lake.rx, ry: lake.ry, transform }, layer);
    });
    const shadow = trees.map((t) => circleD(t.x + t.r * 0.3, t.y + t.r * 0.45, t.r)).join('');
    const dark = trees.map((t) => circleD(t.x, t.y, t.r)).join('');
    const light = trees.map((t) => circleD(t.x - t.r * 0.2, t.y - t.r * 0.22, t.r * 0.72)).join('');
    svgNode('path', { class: 'tree-shadow', d: shadow }, layer);
    svgNode('path', { class: 'tree-dark', d: dark }, layer);
    svgNode('path', { class: 'tree-light', d: light }, layer);
  }

  function drawRiver(layer) {
    const d = smoothD(extendedRiver(), false);
    svgNode('path', { class: 'river-bank', d, 'stroke-width': RIVER_BANK_M }, layer);
    svgNode('path', { class: 'river-water', d, 'stroke-width': RIVER_WATER_M }, layer);
    svgNode('path', { class: 'river-shimmer', d, 'vector-effect': 'non-scaling-stroke' }, layer);
  }

  function drawBuildings(layer, buildings) {
    const shadow = buildings.map((b) => roundedRectD(b.cx + BUILDING_SHADOW[0], b.cy + BUILDING_SHADOW[1], b.w, b.h, b.ang, 12)).join('');
    svgNode('path', { class: 'bld-shadow', d: shadow }, layer);
    for (let color = 0; color < BUILDING_PALETTE_SIZE; color++) {
      const d = buildings.filter((b) => b.color === color).map((b) => roundedRectD(b.cx, b.cy, b.w, b.h, b.ang, 12)).join('');
      svgNode('path', { class: `bld bld-${color}`, d, 'vector-effect': 'non-scaling-stroke' }, layer);
    }
  }

  function edgeD(edge) {
    const [A, B] = edgeEnds(edge);
    return `M${pt([A.x, A.y])}L${pt([B.x, B.y])}`;
  }

  function roadPath(layer, edges, className, widthPx) {
    if (!edges.length) return null;
    return svgNode('path', {
      class: className,
      d: edges.map(edgeD).join(''),
      'stroke-width': widthPx,
      'vector-effect': 'non-scaling-stroke'
    }, layer);
  }

  function drawRoads(casingLayer, fillLayer) {
    ROAD_TYPES.forEach((type) => {
      const edges = BL.EDGES.filter((e) => e.type === type);
      roadPath(casingLayer, edges.filter((e) => !e.bridge), `road-case road-case-${type}`, CASING_PX[type]);
      roadPath(casingLayer, edges.filter((e) => e.bridge), `road-case road-case-${type} road-case-bridge`, CASING_PX[type]);
      roadPath(fillLayer, edges, `road-fill road-fill-${type}`, FILL_PX[type]);
    });
    roadPath(fillLayer, BL.EDGES.filter((e) => e.type === 'hwy'), 'road-centre', 1);
  }

  function drawTrafficLines(layer) {
    return BL.EDGES.map((edge) => {
      const [A, B] = edgeEnds(edge);
      const line = svgNode('line', {
        class: 'tf',
        x1: A.x.toFixed(0), y1: A.y.toFixed(0), x2: B.x.toFixed(0), y2: B.y.toFixed(0),
        'stroke-width': TRAFFIC_PX[edge.type],
        'vector-effect': 'non-scaling-stroke'
      }, layer);
      return { edge, line, level: -1 };
    });
  }

  function trafficLevel(factor) {
    const idx = TRAFFIC_STEPS.findIndex((step) => factor < step);
    return idx === -1 ? TRAFFIC_STEPS.length : idx;
  }

  function iconGroup(parent, className, kind, id) {
    const g = svgNode('g', { class: className }, parent);
    if (kind) {
      g.setAttribute('data-kind', kind);
      g.setAttribute('data-id', id);
    }
    return g;
  }

  function drawLabel(parent, text, className, dy) {
    const node = svgNode('text', { class: className, y: dy || 0 }, parent);
    node.textContent = text;
    return node;
  }

  function drawFrauenkirche(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 1, cy: 8, rx: 16, ry: 3.5 }],
      ['rect', { x: -13, y: -6, width: 26, height: 14, rx: 2, fill: '#E9A17F' }],
      ['path', { d: 'M-13 -6 L-9 -11 H9 L13 -6 Z', fill: '#B9664B' }],
      ['rect', { x: -9.5, y: -24, width: 7, height: 32, rx: 1.5, fill: '#DB8A65' }],
      ['rect', { x: 2.5, y: -24, width: 7, height: 32, rx: 1.5, fill: '#DB8A65' }],
      ['path', { d: 'M-10 -24 Q-10.5 -30 -6 -33.5 Q-1.5 -30 -2 -24 Z', fill: '#5CC29B' }],
      ['path', { d: 'M2 -24 Q1.5 -30 6 -33.5 Q10.5 -30 10 -24 Z', fill: '#5CC29B' }],
      ['circle', { cx: -6, cy: -34.5, r: 1.1, fill: '#F2B935' }],
      ['circle', { cx: 6, cy: -34.5, r: 1.1, fill: '#F2B935' }],
      ['rect', { x: -7, y: -19, width: 2, height: 4.5, rx: 1, fill: '#7A3E2C' }],
      ['rect', { x: 5, y: -19, width: 2, height: 4.5, rx: 1, fill: '#7A3E2C' }],
      ['path', { d: 'M-2 8 V3.5 A2 2 0 0 1 2 3.5 V8 Z', fill: '#7A3E2C' }]
    ]);
  }

  function drawOlympiaturm(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 1, cy: 8, rx: 9, ry: 2.6 }],
      ['path', { d: 'M-6 8 L-2.2 0 H2.2 L6 8 Z', fill: '#C9D3E0' }],
      ['rect', { x: -1.8, y: -30, width: 3.6, height: 31, fill: '#E9EEF5' }],
      ['ellipse', { cx: 0, cy: -27, rx: 7.5, ry: 3.3, fill: '#BFCBDC' }],
      ['rect', { x: -7.3, y: -28, width: 14.6, height: 1.8, rx: 0.9, fill: '#5B86E0' }],
      ['ellipse', { cx: 0, cy: -31.2, rx: 4.2, ry: 1.9, fill: '#E9EEF5' }],
      ['rect', { x: -0.6, y: -43, width: 1.2, height: 11, fill: '#9AA6BC' }],
      ['circle', { cx: 0, cy: -43.5, r: 1.4, fill: '#E23D3D' }]
    ]);
  }

  function drawArena(g) {
    drawShapes(g, [
      ['ellipse', { class: 'arena-glow', cx: 0, cy: 0, rx: 26, ry: 18 }],
      ['ellipse', { class: 'lm-shadow', cx: 1.5, cy: 3.5, rx: 19, ry: 12 }],
      ['ellipse', { class: 'arena-shell', cx: 0, cy: 0, rx: 18, ry: 11.5 }],
      ['ellipse', { class: 'arena-quilt', cx: 0, cy: 0, rx: 14.6, ry: 8.8 }],
      ['ellipse', { cx: 0, cy: 0, rx: 9, ry: 5.2, fill: '#7FCB6E' }],
      ['rect', { x: -0.4, y: -5, width: 0.8, height: 10, fill: '#FFFFFF', opacity: 0.85 }],
      ['circle', { cx: 0, cy: 0, r: 1.6, fill: 'none', stroke: '#FFFFFF', 'stroke-width': 0.7, opacity: 0.85 }]
    ]);
  }

  function drawFriedensengel(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 1, cy: 8, rx: 8, ry: 2.4 }],
      ['rect', { x: -6, y: 4, width: 12, height: 4, rx: 1, fill: '#E8DCC2' }],
      ['rect', { x: -4, y: 1, width: 8, height: 3.5, rx: 0.8, fill: '#F1E7D1' }],
      ['rect', { x: -1.7, y: -20, width: 3.4, height: 21, fill: '#F6EFDF' }],
      ['rect', { x: -2.8, y: -21.6, width: 5.6, height: 2, rx: 0.6, fill: '#E8DCC2' }],
      ['path', { d: 'M0 -25.5 Q-6.5 -30 -7.5 -23.5 Q-3.5 -24.8 0 -22.8 Q3.5 -24.8 7.5 -23.5 Q6.5 -30 0 -25.5 Z', fill: '#F5C242' }],
      ['path', { d: 'M-1.7 -21.7 L0 -28 L1.7 -21.7 Z', fill: '#E5A51C' }],
      ['circle', { cx: 0, cy: -29.3, r: 1.5, fill: '#F5C242' }]
    ]);
  }

  function drawChinaturm(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 1, cy: 8, rx: 11, ry: 2.8 }],
      ['rect', { x: -6, y: -2, width: 12, height: 10, rx: 1, fill: '#DDA66D' }],
      ['rect', { x: -4.2, y: -11, width: 8.4, height: 8, rx: 1, fill: '#DDA66D' }],
      ['rect', { x: -2.6, y: -19, width: 5.2, height: 7, rx: 1, fill: '#DDA66D' }],
      ['path', { d: 'M-11.5 -0.5 L-6.5 -5 H6.5 L11.5 -0.5 Z', fill: '#52A86E' }],
      ['path', { d: 'M-9 -9.5 L-4.8 -13.5 H4.8 L9 -9.5 Z', fill: '#52A86E' }],
      ['path', { d: 'M-6.5 -17.5 L-2.8 -21.5 H2.8 L6.5 -17.5 Z', fill: '#52A86E' }],
      ['path', { d: 'M-3.6 -21.3 L0 -27 L3.6 -21.3 Z', fill: '#52A86E' }],
      ['circle', { cx: 0, cy: -27.6, r: 1.1, fill: '#F2B935' }],
      ['rect', { x: -1.6, y: 2.5, width: 3.2, height: 5.5, rx: 0.8, fill: '#8C5A30' }]
    ]);
  }

  function drawNymphenburg(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 1, cy: 6.5, rx: 25, ry: 3.4 }],
      ['rect', { x: -22, y: -6, width: 15, height: 12, rx: 1, fill: '#F8EACB' }],
      ['rect', { x: 7, y: -6, width: 15, height: 12, rx: 1, fill: '#F8EACB' }],
      ['rect', { x: -7, y: -12, width: 14, height: 18, rx: 1, fill: '#FCF2DA' }],
      ['path', { d: 'M-23 -6 L-20 -9.5 H-7 V-6 Z', fill: '#8FA4C2' }],
      ['path', { d: 'M23 -6 L20 -9.5 H7 V-6 Z', fill: '#8FA4C2' }],
      ['path', { d: 'M-8 -12 L-5 -16.5 H5 L8 -12 Z', fill: '#8FA4C2' }],
      ['rect', { x: -1.6, y: 0.5, width: 3.2, height: 5.5, rx: 1.4, fill: '#8FB0DA' }]
    ]);
    [-19.5, -15.5, -11.5, 9.5, 13.5, 17.5].forEach((x) => {
      svgNode('rect', { x, y: -3, width: 2, height: 3, rx: 0.6, fill: '#8FB0DA' }, g);
    });
    [-4.5, 2.5].forEach((x) => {
      svgNode('rect', { x, y: -8.5, width: 2, height: 3, rx: 0.6, fill: '#8FB0DA' }, g);
    });
  }

  function drawMuseum(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 0, cy: 8, rx: 18, ry: 3 }],
      ['rect', { x: -15, y: -6, width: 22, height: 14, rx: 1, fill: '#EFE6D6' }],
      ['path', { d: 'M-16 -6 L-12 -10 H6 L8 -6 Z', fill: '#9AA9C2' }],
      ['path', { d: 'M-9.5 -10 A4 4 0 0 1 -1.5 -10 Z', fill: '#7CC6B8' }],
      ['rect', { x: 7, y: -26, width: 7, height: 34, rx: 1, fill: '#E6DBC6' }],
      ['path', { d: 'M6.3 -26 L10.5 -31.5 L14.7 -26 Z', fill: '#9AA9C2' }],
      ['circle', { cx: 10.5, cy: -20.5, r: 2.3, fill: '#FFFFFF' }],
      ['path', { d: 'M10.5 -20.5 V-22 M10.5 -20.5 H11.7', stroke: '#15213A', 'stroke-width': 0.6, fill: 'none' }],
      ['rect', { x: 9.4, y: -14, width: 2.2, height: 3.5, rx: 0.8, fill: '#8FB0DA' }],
      ['rect', { x: 9.4, y: -7, width: 2.2, height: 3.5, rx: 0.8, fill: '#8FB0DA' }]
    ]);
    [-12, -7.5, -3, 1.5].forEach((x) => {
      svgNode('rect', { x, y: -2, width: 2.2, height: 4.5, rx: 0.8, fill: '#8FB0DA' }, g);
    });
  }

  function drawTent(g, x, y, roofColor) {
    drawShapes(g, [
      ['rect', { x, y, width: 15, height: 10, rx: 1, fill: '#FFFFFF' }],
      ['rect', { x: x + 2.5, y, width: 2.5, height: 10, fill: roofColor, opacity: 0.55 }],
      ['rect', { x: x + 7.5, y, width: 2.5, height: 10, fill: roofColor, opacity: 0.55 }],
      ['rect', { x: x + 12.5, y, width: 2.5, height: 10, fill: roofColor, opacity: 0.55 }],
      ['path', { d: `M${x - 1.5} ${y} L${x + 7.5} ${y - 7} L${x + 16.5} ${y} Z`, fill: roofColor }],
      ['path', { d: `M${x + 7.5} ${y - 7} V${y - 11} L${x + 10.5} ${y - 9.8} L${x + 7.5} ${y - 8.6}`, fill: '#F2B935', stroke: '#15213A', 'stroke-width': 0.5 }]
    ]);
  }

  function drawFerrisWheel(g, cx, cy, r) {
    svgNode('path', { d: `M${cx - 7} ${cy + r + 9} L${cx} ${cy} L${cx + 7} ${cy + r + 9}`, fill: 'none', stroke: '#7E8AA3', 'stroke-width': 1.6, 'stroke-linecap': 'round' }, g);
    const wheel = svgNode('g', { class: 'wheel' }, g);
    svgNode('circle', { cx, cy, r, fill: 'none', stroke: '#E23D3D', 'stroke-width': 1.6 }, wheel);
    const colors = ['#4C86F0', '#F07A1B', '#2E9E68', '#D9467C'];
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const x = (cx + Math.cos(a) * r).toFixed(2);
      const y = (cy + Math.sin(a) * r).toFixed(2);
      svgNode('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: '#E9A0A0', 'stroke-width': 0.7 }, wheel);
      svgNode('circle', { cx: x, cy: y, r: 1.9, fill: colors[i % colors.length] }, wheel);
    }
    svgNode('circle', { cx, cy, r: 1.8, fill: '#15213A' }, g);
  }

  function drawOktoberfest(g) {
    svgNode('ellipse', { class: 'lm-shadow', cx: 0, cy: 10, rx: 28, ry: 4 }, g);
    drawFerrisWheel(g, 12, -12, 12.5);
    drawTent(g, -27, -2, '#4C86F0');
    drawTent(g, -12, 1, '#E23D3D');
  }

  const LANDMARK_ART = {
    frauenkirche: drawFrauenkirche,
    olympiaturm: drawOlympiaturm,
    arena: drawArena,
    friedensengel: drawFriedensengel,
    chinaturm: drawChinaturm,
    nymphenburg: drawNymphenburg,
    museum: drawMuseum,
    riesenrad: drawOktoberfest
  };

  function drawChristmasTree(g, x, y, s) {
    drawShapes(g, [
      ['rect', { x: x - 1 * s, y: y - 1 * s, width: 2 * s, height: 3 * s, fill: '#8C5A30' }],
      ['path', { d: `M${x} ${y - 14 * s} L${x + 7 * s} ${y - 1 * s} H${x - 7 * s} Z`, fill: '#3E9A5C' }],
      ['path', { d: `M${x} ${y - 17 * s} L${x + 5 * s} ${y - 7 * s} H${x - 5 * s} Z`, fill: '#52B26E' }],
      ['circle', { cx: x, cy: y - 17.5 * s, r: 1.5 * s, fill: '#F5C242' }],
      ['circle', { cx: x - 2.5 * s, cy: y - 5 * s, r: 1 * s, fill: '#E23D3D' }],
      ['circle', { cx: x + 3 * s, cy: y - 9 * s, r: 1 * s, fill: '#F5C242' }]
    ]);
  }

  function drawStall(g, x, y, roofColor) {
    drawShapes(g, [
      ['rect', { x, y: y - 6, width: 11, height: 7, rx: 1, fill: '#F6E3C6' }],
      ['path', { d: `M${x - 1.5} ${y - 6} L${x + 5.5} ${y - 11} L${x + 12.5} ${y - 6} Z`, fill: roofColor }],
      ['rect', { x: x + 2, y: y - 4.5, width: 7, height: 2, rx: 0.6, fill: '#F5C242' }]
    ]);
  }

  function drawMarket(g) {
    svgNode('ellipse', { class: 'lm-shadow', cx: 0, cy: 2, rx: 22, ry: 3.5 }, g);
    drawStall(g, -20, 2, '#E23D3D');
    drawStall(g, 8, 2, '#2E9E68');
    drawChristmasTree(g, 0, 2, 1);
  }

  function drawFinishArch(g) {
    drawShapes(g, [
      ['ellipse', { class: 'lm-shadow', cx: 0, cy: 3, rx: 22, ry: 3 }],
      ['rect', { x: -19, y: -20, width: 4, height: 23, rx: 1.5, fill: '#2160E8' }],
      ['rect', { x: 15, y: -20, width: 4, height: 23, rx: 1.5, fill: '#2160E8' }],
      ['rect', { x: -21, y: -27, width: 42, height: 10, rx: 4, fill: '#2160E8' }],
      ['path', { d: 'M-15 3 H15', stroke: '#FFFFFF', 'stroke-width': 2, 'stroke-dasharray': '2 2' }]
    ]);
  }

  function drawBarrier(g) {
    drawShapes(g, [
      ['rect', { class: 'icon-shadow', x: -9, y: -2.5, width: 20, height: 7, rx: 2 }],
      ['rect', { x: -7.5, y: 0, width: 2, height: 6, fill: '#475673' }],
      ['rect', { x: 5.5, y: 0, width: 2, height: 6, fill: '#475673' }],
      ['rect', { x: -10, y: -4, width: 20, height: 6, rx: 1.5, fill: '#FFFFFF', stroke: '#E23D3D', 'stroke-width': 1 }],
      ['path', { d: 'M-7 -4 L-10 -1 M-2 -4 L-6 2 M3 -4 L-1 2 M8 -4 L4 2 M10 -1 L9 2', stroke: '#E23D3D', 'stroke-width': 2.2, 'stroke-linecap': 'round' }]
    ]);
  }

  function drawAmbulance(g) {
    const shadow = svgNode('g', { class: 'amb-shadow' }, g);
    svgNode('rect', { x: -14, y: -7, width: 28, height: 14, rx: 4 }, shadow);
    const body = svgNode('g', { class: 'amb-body' }, g);
    drawShapes(body, [
      ['circle', { class: 'amb-glow amb-glow-blue', r: 21 }],
      ['circle', { class: 'amb-glow amb-glow-red', r: 21 }],
      ['rect', { class: 'amb-hull', x: -14, y: -7, width: 28, height: 14, rx: 3.6 }],
      ['rect', { class: 'amb-stripe', x: -12.5, y: -6.6, width: 18, height: 2 }],
      ['rect', { class: 'amb-stripe', x: -12.5, y: 4.6, width: 18, height: 2 }],
      ['path', { class: 'amb-cab', d: 'M6.5 -6.6 H10.5 Q13.6 -6.6 13.6 -3.5 V3.5 Q13.6 6.6 10.5 6.6 H6.5 Z' }],
      ['rect', { class: 'amb-glass', x: 9.6, y: -5.2, width: 2.8, height: 10.4, rx: 1.3 }],
      ['rect', { class: 'amb-cross', x: -8.6, y: -1.1, width: 6.2, height: 2.2, rx: 0.5 }],
      ['rect', { class: 'amb-cross', x: -6.6, y: -3.1, width: 2.2, height: 6.2, rx: 0.5 }],
      ['rect', { class: 'amb-light amb-light-blue', x: 2.4, y: -5.4, width: 2.8, height: 5.2, rx: 1 }],
      ['rect', { class: 'amb-light amb-light-red', x: 2.4, y: 0.2, width: 2.8, height: 5.2, rx: 1 }]
    ]);
    const tag = svgNode('g', { class: 'amb-tag', transform: 'translate(0 -22)' }, g);
    svgNode('rect', { class: 'amb-tag-bg', x: -8.5, y: -6.5, width: 17, height: 13, rx: 6.5 }, tag);
    const label = svgNode('text', { class: 'amb-tag-text', y: 0.5 }, tag);
    return { shadow, body, label };
  }

  function drawPatient(g, emoji) {
    const art = svgNode('g', { class: 'pin-art' }, g);
    drawShapes(art, [
      ['ellipse', { class: 'pin-ground', cx: 0, cy: 0, rx: 5.5, ry: 2.2 }],
      ['circle', { class: 'pin-halo', cx: 0, cy: -17, r: 11 }],
      ['circle', { class: 'pin-ripple', cx: 0, cy: -17, r: 11 }],
      ['circle', { class: 'pin-ripple pin-ripple-late', cx: 0, cy: -17, r: 11 }],
      ['path', { class: 'pin-body', d: 'M0 -1 C-3 -6 -11 -9.5 -11 -17 A11 11 0 1 1 11 -17 C11 -9.5 3 -6 0 -1 Z' }]
    ]);
    drawLabel(art, emoji || '', 'pin-emoji', -16.2);
  }

  function drawHospital(g) {
    drawShapes(g, [
      ['rect', { class: 'icon-shadow', x: -11.5, y: -10.5, width: 26, height: 26, rx: 7 }],
      ['rect', { class: 'hosp-box', x: -13, y: -13, width: 26, height: 26, rx: 7 }],
      ['rect', { class: 'hosp-cross', x: -3.3, y: -8.5, width: 6.6, height: 17, rx: 1.5 }],
      ['rect', { class: 'hosp-cross', x: -8.5, y: -3.3, width: 17, height: 6.6, rx: 1.5 }],
      ['rect', { class: 'hosp-bar-bg', x: -13, y: 16, width: 26, height: 4.5, rx: 2.25 }]
    ]);
    const bar = svgNode('rect', { class: 'hosp-bar', x: -13, y: 16, width: 0, height: 4.5, rx: 2.25 }, g);
    return bar;
  }

  function drawStation(g) {
    const art = svgNode('g', { class: 'station-art', transform: 'translate(-17 -13)' }, g);
    drawShapes(art, [
      ['rect', { class: 'icon-shadow', x: -6, y: -2, width: 14, height: 11, rx: 2 }],
      ['rect', { class: 'station-wall', x: -7, y: -3, width: 14, height: 11, rx: 2 }],
      ['path', { class: 'station-roof', d: 'M-8.6 -2.2 L0 -8.8 L8.6 -2.2 Z' }],
      ['rect', { class: 'station-door', x: -4, y: 1.5, width: 8, height: 6.5, rx: 1 }],
      ['path', { class: 'station-door-lines', d: 'M-4 3.7 H4 M-4 5.9 H4' }]
    ]);
  }

  function drawAccident(g) {
    const art = svgNode('g', { class: 'acc-art' }, g);
    drawShapes(art, [
      ['circle', { class: 'acc-halo', cx: 0, cy: -2, r: 14 }],
      ['path', { class: 'acc-sign', d: 'M0 -12 L11.5 8 H-11.5 Z' }],
      ['rect', { class: 'acc-mark', x: -1.3, y: -5.5, width: 2.6, height: 7.5, rx: 1.3 }],
      ['circle', { class: 'acc-mark', cx: 0, cy: 4.8, r: 1.5 }]
    ]);
  }

  function drawZoomControls(host, handlers) {
    const box = htmlNode('div', 'map-zoom', host);
    const buttons = [
      { label: 'Zoom in', text: '+', onClick: handlers.zoomIn },
      { label: 'Zoom out', text: '−', onClick: handlers.zoomOut },
      { label: 'Fit map', text: '', onClick: handlers.fit, fit: true }
    ];
    buttons.forEach((spec) => {
      const button = htmlNode('button', spec.fit ? 'map-zoom-btn map-zoom-fit' : 'map-zoom-btn', box);
      button.type = 'button';
      button.title = spec.label;
      button.setAttribute('aria-label', spec.label);
      button.textContent = spec.text;
      if (spec.fit) {
        const icon = svgNode('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' }, button);
        svgNode('path', { d: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, icon);
      }
      button.addEventListener('click', spec.onClick);
      button.addEventListener('pointerdown', (event) => event.stopPropagation());
    });
    return box;
  }

  function shortCount(people) {
    return people >= 1000 ? `${Math.round(people / 1000)}k` : String(people);
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function routeD(route, fromLegIdx, startPoint) {
    if (!route || !asArray(route.legs).length || typeof BL.routePoints !== 'function') return '';
    const points = BL.routePoints(route, fromLegIdx, startPoint);
    return points && points.length > 1 ? polylineD(points) : '';
  }

  const STATIC_HOSPITALS = BL.HOSPITALS.map((h) => ({ ...h, x: BL.NODE[h.node].x, y: BL.NODE[h.node].y, load: 0 }));
  const STATIC_STATIONS = BL.STATIONS.map((s) => ({ ...s, x: BL.NODE[s.node].x, y: BL.NODE[s.node].y }));

  function createMap(svgEl, sim) {
    const host = svgEl.parentElement;
    const view = { cx: BL.MAP_W / 2, cy: BL.MAP_H / 2, w: BL.MAP_W };
    const size = { w: 1, h: 1, left: 0, top: 0 };
    const mapClickHandlers = [];
    const entityClickHandlers = [];
    const stores = { amb: new Map(), patient: new Map(), hospital: new Map(), station: new Map(), accident: new Map() };
    const staticIcons = [];
    const scenarioIcons = [];
    const landmarkGroups = {};
    const scenarioSeen = { id: undefined, snow: undefined };
    let mpp = 1;
    let mppKey = '';
    let trafficMode = 'live';
    let lastTrafficDraw = -Infinity;
    let lastTooltipFill = -Infinity;
    let placing = false;
    let highlightedId = null;
    let hover = null;
    let drag = null;
    let animation = null;
    let frameStamp = 0;

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    svgEl.classList.add('bl-map');
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const layers = createLayers();
    const rand = BL.mulberry32(CITY_SEED);
    const trees = generateTrees(rand);
    const buildings = generateBuildings(rand);
    drawLand(layers.land);
    drawWiesnGround(layers.wiesn);
    drawParks(layers.parks, trees);
    drawRiver(layers.river);
    drawBuildings(layers.buildings, buildings);
    drawRoads(layers.casings, layers.fills);
    const trafficLines = drawTrafficLines(layers.traffic);
    drawStaticLabels();
    drawLandmarks();
    const preview = createPreview();
    const tooltip = createTooltip();
    const snow = htmlNode('div', 'map-snow', host);
    snow.setAttribute('aria-hidden', 'true');
    drawZoomControls(host, {
      zoomIn: () => zoomBy(1 / BUTTON_ZOOM_STEP),
      zoomOut: () => zoomBy(BUTTON_ZOOM_STEP),
      fit: () => animateTo(fitTarget(), BUTTON_ZOOM_MS)
    });

    measure();
    Object.assign(view, fitTarget());
    applyView();
    bindPointerEvents();
    observeResize();
    render(performance.now());

    function createLayers() {
      const names = ['land', 'wiesn', 'parks', 'river', 'buildings', 'crowds', 'casings', 'fills', 'traffic', 'closures',
        'routes', 'labels', 'landmarks', 'decor', 'stations', 'hospitals', 'barriers', 'accidents', 'patients', 'ambulances'];
      return Object.fromEntries(names.map((name) => [name, svgNode('g', { class: `layer layer-${name}` }, svgEl)]));
    }

    function addStaticIcon(list, g, x, y) {
      const icon = { g, x, y, transform: '' };
      list.push(icon);
      if (mppKey) placeIcon(icon, x, y);
      return icon;
    }

    function drawStaticLabels() {
      BL.NEIGHBORHOODS.forEach((n) => {
        const g = iconGroup(layers.labels, 'label-group');
        drawLabel(g, n.name, 'map-label hood-label');
        addStaticIcon(staticIcons, g, n.x, n.y);
      });
    }

    function drawLandmarks() {
      BL.LANDMARKS.forEach((lm) => {
        const g = iconGroup(layers.landmarks, `landmark landmark-${lm.id}`, 'landmark', lm.id);
        const art = svgNode('g', { class: 'lm-art' }, g);
        (LANDMARK_ART[lm.id] || drawFrauenkirche)(art);
        landmarkGroups[lm.id] = g;
        addStaticIcon(staticIcons, g, lm.pos[0], lm.pos[1]);
      });
    }

    function createPreview() {
      const make = (className) => svgNode('path', { class: className, 'vector-effect': 'non-scaling-stroke', d: '' }, layers.routes);
      const ringG = iconGroup(layers.hospitals, 'preview-ring');
      svgNode('circle', { class: 'preview-ring-pulse', r: 24 }, ringG);
      svgNode('circle', { class: 'preview-ring-line', r: 24 }, ringG);
      return {
        id: undefined,
        ambId: null,
        glow1: make('preview-glow preview-scene'),
        glow2: make('preview-glow preview-hosp'),
        line1: make('preview-line preview-scene'),
        line2: make('preview-line preview-hosp'),
        ring: { g: ringG, transform: '' }
      };
    }

    function createTooltip() {
      const box = htmlNode('div', 'map-tooltip', host);
      box.setAttribute('role', 'tooltip');
      return { box, title: htmlNode('div', 'map-tooltip-title', box), body: htmlNode('div', 'map-tooltip-body', box) };
    }

    function measure() {
      const svgRect = svgEl.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      size.w = Math.max(1, svgRect.width);
      size.h = Math.max(1, svgRect.height);
      size.left = svgRect.left - hostRect.left;
      size.top = svgRect.top - hostRect.top;
    }

    function fitTarget() {
      const aspect = size.h / size.w;
      const w = Math.max(BL.MAP_W, BL.MAP_H / aspect) * FIT_MARGIN;
      return { cx: BL.MAP_W / 2, cy: BL.MAP_H / 2, w: clamp(w, MIN_VIEW_W, MAX_VIEW_W) };
    }

    function viewHeight() {
      return view.w * (size.h / size.w);
    }

    function applyView() {
      view.w = clamp(view.w, MIN_VIEW_W, MAX_VIEW_W);
      view.cx = clamp(view.cx, 0, BL.MAP_W);
      view.cy = clamp(view.cy, 0, BL.MAP_H);
      const h = viewHeight();
      svgEl.setAttribute('viewBox', `${(view.cx - view.w / 2).toFixed(1)} ${(view.cy - h / 2).toFixed(1)} ${view.w.toFixed(1)} ${h.toFixed(1)}`);
      mpp = view.w / size.w;
      const key = mpp.toFixed(4);
      if (key !== mppKey) {
        mppKey = key;
        staticIcons.forEach((icon) => placeIcon(icon, icon.x, icon.y));
        scenarioIcons.forEach((icon) => placeIcon(icon, icon.x, icon.y));
        svgEl.classList.toggle('is-close', mpp < CLOSE_ZOOM_MPP);
        svgEl.classList.toggle('is-far', mpp > FAR_ZOOM_MPP);
      }
    }

    function placeIcon(rec, x, y) {
      const transform = `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${mppKey})`;
      if (rec.transform !== transform) {
        rec.g.setAttribute('transform', transform);
        rec.transform = transform;
      }
    }

    function setFlag(rec, name, on) {
      if (!rec.flags) rec.flags = {};
      if (rec.flags[name] !== on) {
        rec.g.classList.toggle(name, on);
        rec.flags[name] = on;
      }
    }

    function setCached(rec, key, node, attr, value) {
      if (rec[key] !== value) {
        node.setAttribute(attr, value);
        rec[key] = value;
      }
    }

    function setVisible(rec, visible) {
      if (rec.visible !== visible) {
        rec.g.style.display = visible ? '' : 'none';
        rec.visible = visible;
      }
    }

    function syncCollection(store, items, create, update) {
      frameStamp++;
      for (const item of items) {
        let rec = store.get(item.id);
        if (!rec) {
          rec = create(item);
          store.set(item.id, rec);
        }
        rec.stamp = frameStamp;
        update(rec, item);
      }
      for (const [id, rec] of store) {
        if (rec.stamp !== frameStamp) {
          rec.g.remove();
          if (rec.remove) rec.remove();
          store.delete(id);
        }
      }
    }

    function hospitalsNow() {
      return asArray(sim.hospitals).length ? sim.hospitals : STATIC_HOSPITALS;
    }

    function stationsNow() {
      return asArray(sim.stations).length ? sim.stations : STATIC_STATIONS;
    }

    function accidentsNow() {
      return sim.traffic ? asArray(sim.traffic.accidents) : [];
    }

    function recsNow() {
      return sim.coordinator ? asArray(sim.coordinator.recs) : [];
    }

    function scenarioState() {
      return sim.scenario || {};
    }

    function activeScenario() {
      const def = typeof sim.activeScenario === 'function' ? sim.activeScenario() : null;
      return def || (BL.SCENARIO && BL.SCENARIO[scenarioState().id]) || null;
    }

    function createHospitalRec(h) {
      const g = iconGroup(layers.hospitals, 'hospital', 'hospital', h.id);
      return { g, bar: drawHospital(g), transform: '' };
    }

    function updateHospitalRec(rec, h) {
      placeIcon(rec, h.x, h.y);
      const ratio = h.capacity ? clamp((h.load || 0) / h.capacity, 0, 1) : 0;
      setCached(rec, 'barW', rec.bar, 'width', (26 * ratio).toFixed(1));
      const level = ratio < 0.7 ? 'ok' : ratio < 0.9 ? 'busy' : 'full';
      setCached(rec, 'level', rec.bar, 'data-level', level);
    }

    function createStationRec(s) {
      const g = iconGroup(layers.stations, 'station', 'station', s.id);
      drawStation(g);
      return { g, transform: '' };
    }

    function updateStationRec(rec, s) {
      placeIcon(rec, s.x, s.y);
    }

    function createAccidentRec(acc) {
      const g = iconGroup(layers.accidents, 'accident', 'accident', acc.id);
      drawAccident(g);
      return { g, transform: '' };
    }

    function updateAccidentRec(rec, acc) {
      const edge = BL.EDGES[acc.e];
      if (edge) placeIcon(rec, edge.mx, edge.my);
    }

    function createPatientRec(p) {
      const g = iconGroup(layers.patients, 'patient', 'patient', p.id);
      drawPatient(g, p.emoji);
      return { g, transform: '' };
    }

    function updatePatientRec(rec, p) {
      const visible = !HIDDEN_PATIENT_STATUS.has(p.status);
      setVisible(rec, visible);
      if (!visible) return;
      placeIcon(rec, p.x, p.y);
      setCached(rec, 'cat', rec.g, 'data-cat', p.cat || 'NONE');
      setFlag(rec, 'is-pending', p.status === 'pending');
      setFlag(rec, 'is-waiting', p.status === 'waiting');
      setFlag(rec, 'is-highlight', p.id === highlightedId);
    }

    function createAmbRec(amb) {
      const g = iconGroup(layers.ambulances, 'amb', 'ambulance', amb.id);
      const parts = drawAmbulance(g);
      parts.label.textContent = String(amb.n || amb.id);
      const track = svgNode('path', { class: 'route-track', 'vector-effect': 'non-scaling-stroke', d: '' }, layers.routes);
      const dash = svgNode('path', { class: 'route-dash', 'vector-effect': 'non-scaling-stroke', d: '' }, layers.routes);
      return {
        g, ...parts, track, dash, transform: '',
        remove() {
          track.remove();
          dash.remove();
        }
      };
    }

    function updateAmbRec(rec, amb) {
      placeIcon(rec, amb.x, amb.y);
      const deg = (((amb.heading || 0) * 180) / Math.PI).toFixed(1);
      setCached(rec, 'rot', rec.body, 'transform', `rotate(${deg})`);
      setCached(rec, 'shadowRot', rec.shadow, 'transform', `translate(1.4 2.4) rotate(${deg})`);
      setCached(rec, 'state', rec.g, 'data-state', amb.state || 'idle');
      setFlag(rec, 'is-siren', Boolean(amb.siren));
      setFlag(rec, 'is-chosen', amb.id === preview.ambId);
      updateAmbRoute(rec, amb);
    }

    function updateAmbRoute(rec, amb) {
      const routeClass = ROUTE_STATES[amb.state];
      const d = amb.siren && routeClass ? routeD(amb.path, amb.legIdx || 0, [amb.x, amb.y]) : '';
      setCached(rec, 'trackD', rec.track, 'd', d);
      setCached(rec, 'dashD', rec.dash, 'd', d);
      const className = routeClass || 'to-scene';
      setCached(rec, 'trackClass', rec.track, 'class', `route-track ${className}`);
      setCached(rec, 'dashClass', rec.dash, 'class', `route-dash ${className}`);
    }

    function renderPreview() {
      const rec = recsNow().find((r) => r.revealed) || null;
      const id = rec ? rec.id : null;
      if (id !== preview.id) {
        preview.id = id;
        drawPreviewRoutes(rec);
      }
      preview.ambId = rec && rec.amb ? rec.amb.id : null;
      const showRing = Boolean(rec && rec.hosp);
      preview.ring.g.style.display = showRing ? '' : 'none';
      if (showRing) placeIcon(preview.ring, rec.hosp.x, rec.hosp.y);
    }

    function drawPreviewRoutes(rec) {
      const start = rec && rec.amb ? [rec.amb.x, rec.amb.y] : null;
      const d1 = rec ? routeD(rec.route1, 0, start) : '';
      const d2 = rec ? routeD(rec.route2, 0, null) : '';
      preview.glow1.setAttribute('d', d1);
      preview.line1.setAttribute('d', d1);
      preview.glow2.setAttribute('d', d2);
      preview.line2.setAttribute('d', d2);
    }

    function drawTraffic(now) {
      lastTrafficDraw = now;
      const canDraw = trafficMode !== 'off' && sim.traffic && typeof sim.traffic.factor === 'function';
      layers.traffic.style.display = canDraw ? '' : 'none';
      if (!canDraw) return;
      const forecast = trafficMode === 'forecast';
      const T = (sim.t || 0) + (forecast ? FORECAST_AHEAD_S : 0);
      const mode = forecast ? 'forecast' : 'actual';
      trafficLines.forEach((item) => {
        const level = trafficLevel(sim.traffic.factor(item.edge, T, mode));
        if (item.level !== level) {
          item.line.setAttribute('class', `tf tf-${level}`);
          item.level = level;
        }
      });
    }

    function detectScenarioChange() {
      const sc = scenarioState();
      const changed = scenarioSeen.id !== sc.id || scenarioSeen.snow !== Boolean(sc.snow);
      if (changed) applyScenario();
      return changed;
    }

    function clearScenarioDrawing() {
      ['crowds', 'closures', 'decor', 'barriers'].forEach((name) => layers[name].replaceChildren());
      scenarioIcons.length = 0;
    }

    function drawCrowds(def) {
      def.crowds.forEach((crowd, i) => {
        svgNode('circle', { class: 'crowd-heat crowd-heat-outer', cx: crowd.x.toFixed(0), cy: crowd.y.toFixed(0), r: (crowd.radius * 1.6).toFixed(0) }, layers.crowds);
        svgNode('circle', { class: 'crowd-heat', cx: crowd.x.toFixed(0), cy: crowd.y.toFixed(0), r: crowd.radius.toFixed(0) }, layers.crowds);
        const g = iconGroup(layers.decor, 'crowd-tag', 'crowd', String(i));
        const text = `\u{1F465} ${shortCount(crowd.people)}`;
        const width = text.length * 6.2 + 12;
        svgNode('rect', { class: 'crowd-pill', x: (-width / 2).toFixed(1), y: 10, width: width.toFixed(1), height: 18, rx: 9 }, g);
        drawLabel(g, text, 'crowd-text', 19.5);
        addStaticIcon(scenarioIcons, g, crowd.x, crowd.y);
      });
    }

    function drawClosures(def) {
      const edges = [...def.closures].map((i) => BL.EDGES[i]).filter(Boolean);
      roadPath(layers.closures, edges, 'closure-base', 8);
      roadPath(layers.closures, edges, 'closure-dash', 5);
      edges.forEach((edge) => {
        const g = iconGroup(layers.barriers, 'barrier', 'closure', String(edge.i));
        drawBarrier(g);
        addStaticIcon(scenarioIcons, g, edge.mx, edge.my);
      });
    }

    function drawScenarioDecor(def) {
      if (def.id === 'christmas') {
        def.crowds.forEach((crowd) => {
          const g = iconGroup(layers.decor, 'decor');
          drawMarket(g);
          addStaticIcon(scenarioIcons, g, crowd.x, crowd.y);
          g.setAttribute('data-offset', 'below');
        });
      }
      if (def.id === 'marathon' && def.crowds.length) {
        const g = iconGroup(layers.decor, 'decor');
        drawFinishArch(g);
        addStaticIcon(scenarioIcons, g, def.crowds[0].x, def.crowds[0].y);
      }
    }

    function applyScenario() {
      const sc = scenarioState();
      scenarioSeen.id = sc.id;
      scenarioSeen.snow = Boolean(sc.snow);
      const def = activeScenario();
      const id = def ? def.id : 'normal';
      clearScenarioDrawing();
      if (def) {
        drawCrowds(def);
        drawClosures(def);
        drawScenarioDecor(def);
      }
      svgEl.setAttribute('data-scenario', id);
      landmarkGroups.riesenrad.style.display = id === 'wiesn' ? '' : 'none';
      landmarkGroups.arena.classList.toggle('is-match', id === 'match');
      svgEl.classList.toggle('is-snow', scenarioSeen.snow);
      snow.classList.toggle('is-on', scenarioSeen.snow);
    }

    function render(nowMs) {
      const now = typeof nowMs === 'number' ? nowMs : performance.now();
      const scenarioChanged = detectScenarioChange();
      renderPreview();
      syncCollection(stores.hospital, hospitalsNow(), createHospitalRec, updateHospitalRec);
      syncCollection(stores.station, stationsNow(), createStationRec, updateStationRec);
      syncCollection(stores.accident, accidentsNow(), createAccidentRec, updateAccidentRec);
      syncCollection(stores.patient, asArray(sim.patients), createPatientRec, updatePatientRec);
      syncCollection(stores.amb, asArray(sim.ambs), createAmbRec, updateAmbRec);
      if (scenarioChanged || now - lastTrafficDraw >= TRAFFIC_REDRAW_MS) drawTraffic(now);
      updateTooltip(now);
    }

    function findById(list, id) {
      return asArray(list).find((item) => item.id === id) || null;
    }

    function crowdByIndex(id) {
      const def = activeScenario();
      return def ? def.crowds[Number(id)] || null : null;
    }

    function entityPoint(kind, id) {
      if (kind === 'patient') return findById(sim.patients, id);
      if (kind === 'ambulance') return findById(sim.ambs, id);
      if (kind === 'hospital') return findById(hospitalsNow(), id);
      if (kind === 'station') return findById(stationsNow(), id);
      if (kind === 'crowd') return crowdByIndex(id);
      if (kind === 'closure') {
        const edge = BL.EDGES[Number(id)];
        return edge ? { x: edge.mx, y: edge.my } : null;
      }
      if (kind === 'accident') {
        const acc = findById(accidentsNow(), id);
        const edge = acc && BL.EDGES[acc.e];
        return edge ? { x: edge.mx, y: edge.my } : null;
      }
      if (kind === 'landmark') {
        const lm = BL.LANDMARKS.find((l) => l.id === id);
        return lm ? { x: lm.pos[0], y: lm.pos[1] } : null;
      }
      return null;
    }

    function etaText(amb) {
      if (!amb || typeof BL.remainingTime !== 'function') return null;
      const eta = BL.remainingTime(sim, amb);
      return typeof eta === 'number' && Number.isFinite(eta) ? BL.fmtMin(eta) : null;
    }

    function patientLines(p) {
      const lines = [p.cat ? `${p.cat}, score ${Math.round(p.score)}` : 'Being triaged'];
      if (p.age) lines.push(`${p.age} years`);
      if (p.status === 'waiting') lines.push(`Waiting ${BL.fmtMin(Math.max(0, (sim.t || 0) - (p.callT || 0)))}`);
      if (p.status === 'pending') lines.push('Recommendation ready');
      if (p.status === 'assigned' && p.amb) {
        const eta = etaText(p.amb);
        lines.push(eta ? `${p.amb.name} en route, ${eta}` : `${p.amb.name} en route`);
      }
      if (p.status === 'onScene' && p.amb) lines.push(`${p.amb.name} on scene`);
      if (p.street) lines.push(p.area ? `${p.street}, ${p.area}` : p.street);
      if (p.crowd) lines.push(p.crowd);
      return lines;
    }

    function ambulanceLines(amb) {
      const lines = [STATE_LABEL[amb.state] || 'On duty'];
      if (amb.patient) lines.push(`${amb.patient.id} ${amb.patient.label || ''}`.trim());
      if (amb.hosp && amb.state !== 'idle' && amb.state !== 'returning') lines.push(`Hospital: ${amb.hosp.short || amb.hosp.name}`);
      if (amb.path && amb.state !== 'idle') {
        const eta = etaText(amb);
        if (eta) lines.push(`Arrives in ${eta}`);
      }
      if (amb.station && amb.station.name) lines.push(`Home: ${amb.station.name}`);
      return lines;
    }

    function hospitalLines(h) {
      const lines = [];
      if (h.capacity) lines.push(`ER load ${Math.round(((h.load || 0) / h.capacity) * 100)} %`);
      if (asArray(h.caps).length) lines.push(h.caps.map((c) => BL.CAP_LABEL[c] || c).join(', '));
      return lines;
    }

    function stationLines(s) {
      const units = asArray(sim.ambs).filter((a) => a.station && a.station.id === s.id);
      return units.length ? units.map((a) => `${a.name}: ${STATE_LABEL[a.state] || 'On duty'}`) : ['Ambulance station'];
    }

    function accidentLines(acc) {
      const edge = BL.EDGES[acc.e];
      const lines = [];
      if (sim.traffic && typeof sim.traffic.factor === 'function' && edge) {
        lines.push(`Traffic ×${sim.traffic.factor(edge, sim.t || 0, 'actual').toFixed(1)} here`);
      }
      if (typeof acc.start === 'number' && typeof acc.dur === 'number') {
        const left = acc.start + acc.dur - (sim.t || 0);
        if (left > 0) lines.push(`Clears in about ${Math.max(1, Math.round(left / 60))} min`);
      }
      return lines;
    }

    function tooltipContent(kind, id) {
      if (kind === 'patient') {
        const p = findById(sim.patients, id);
        return p && { title: `${p.id} ${p.label || ''}`.trim(), lines: patientLines(p) };
      }
      if (kind === 'ambulance') {
        const amb = findById(sim.ambs, id);
        return amb && { title: amb.name || amb.id, lines: ambulanceLines(amb) };
      }
      if (kind === 'hospital') {
        const h = findById(hospitalsNow(), id);
        return h && { title: h.name, lines: hospitalLines(h) };
      }
      if (kind === 'station') {
        const s = findById(stationsNow(), id);
        return s && { title: s.name, lines: stationLines(s) };
      }
      if (kind === 'crowd') {
        const crowd = crowdByIndex(id);
        return crowd && { title: crowd.name, lines: [`${PEOPLE_FORMAT.format(crowd.people)} people`] };
      }
      if (kind === 'closure') {
        const edge = BL.EDGES[Number(id)];
        return edge && { title: `${edge.name} closed`, lines: ['Units route around it'] };
      }
      if (kind === 'accident') {
        const acc = findById(accidentsNow(), id);
        const edge = acc && BL.EDGES[acc.e];
        return acc && { title: edge ? `Crash on ${edge.name}` : 'Crash', lines: accidentLines(acc) };
      }
      if (kind === 'landmark') {
        const lm = BL.LANDMARKS.find((l) => l.id === id);
        return lm && { title: lm.name, lines: [BL.nearestNeighborhood(lm.pos[0], lm.pos[1])] };
      }
      return null;
    }

    function fillTooltip(content) {
      tooltip.title.textContent = content.title;
      tooltip.body.replaceChildren(...content.lines.map((line) => {
        const row = htmlNode('div', 'map-tooltip-line');
        row.textContent = line;
        return row;
      }));
    }

    function hideTooltip() {
      tooltip.box.classList.remove('is-on');
    }

    function updateTooltip(now, force) {
      if (!hover || drag || placing) {
        hideTooltip();
        return;
      }
      const point = entityPoint(hover.kind, hover.id);
      if (!point || !Number.isFinite(point.x)) {
        hover = null;
        hideTooltip();
        return;
      }
      if (force || now - lastTooltipFill >= TOOLTIP_REFRESH_MS) {
        const content = tooltipContent(hover.kind, hover.id);
        if (!content) {
          hideTooltip();
          return;
        }
        fillTooltip(content);
        lastTooltipFill = now;
      }
      positionTooltip(point);
      tooltip.box.classList.add('is-on');
    }

    function positionTooltip(point) {
      const top = view.cy - viewHeight() / 2;
      const left = view.cx - view.w / 2;
      const sx = size.left + (point.x - left) / mpp;
      const lift = TOOLTIP_LIFT_PX[hover.kind] || 24;
      const anchorY = size.top + (point.y - top) / mpp;
      const box = tooltip.box;
      const halfW = box.offsetWidth / 2;
      const x = clamp(sx, size.left + halfW + 8, size.left + size.w - halfW - 8);
      const above = anchorY - lift - box.offsetHeight >= size.top + 8;
      const y = above ? anchorY - lift - box.offsetHeight : anchorY + 18;
      box.style.transform = `translate(${(x - halfW).toFixed(0)}px, ${y.toFixed(0)}px)`;
    }

    function entityAt(target) {
      const node = target && target.closest ? target.closest('[data-kind]') : null;
      return node ? { kind: node.getAttribute('data-kind'), id: node.getAttribute('data-id') } : null;
    }

    function toMapPoint(event) {
      const rect = svgEl.getBoundingClientRect();
      const left = view.cx - view.w / 2;
      const top = view.cy - viewHeight() / 2;
      return [left + ((event.clientX - rect.left) / rect.width) * view.w, top + ((event.clientY - rect.top) / rect.height) * viewHeight()];
    }

    function bindPointerEvents() {
      svgEl.addEventListener('pointerdown', onPointerDown);
      svgEl.addEventListener('pointermove', onPointerMove);
      svgEl.addEventListener('pointerup', onPointerUp);
      svgEl.addEventListener('pointercancel', endDrag);
      svgEl.addEventListener('pointerleave', () => setHover(null));
      svgEl.addEventListener('wheel', onWheel, { passive: false });
    }

    function onPointerDown(event) {
      if (event.button !== 0) return;
      animation = null;
      drag = { id: event.pointerId, sx: event.clientX, sy: event.clientY, cx: view.cx, cy: view.cy, moved: false, entity: entityAt(event.target) };
      svgEl.setPointerCapture(event.pointerId);
    }

    function onPointerMove(event) {
      if (!drag) {
        setHover(entityAt(event.target));
        return;
      }
      if (event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.sx;
      const dy = event.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) >= CLICK_SLOP_PX) {
        drag.moved = true;
        svgEl.classList.add('is-dragging');
        hideTooltip();
      }
      if (drag.moved) {
        view.cx = drag.cx - dx * mpp;
        view.cy = drag.cy - dy * mpp;
        applyView();
      }
    }

    function onPointerUp(event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved) handleClick(event, drag.entity);
      endDrag();
    }

    function endDrag() {
      if (drag && svgEl.hasPointerCapture(drag.id)) svgEl.releasePointerCapture(drag.id);
      drag = null;
      svgEl.classList.remove('is-dragging');
    }

    function handleClick(event, entity) {
      if (entity && !placing) {
        entityClickHandlers.forEach((fn) => fn(entity.kind, entity.id));
        return;
      }
      const [x, y] = toMapPoint(event);
      mapClickHandlers.forEach((fn) => fn(x, y));
    }

    function onWheel(event) {
      event.preventDefault();
      animation = null;
      const [px, py] = toMapPoint(event);
      zoomAround(px, py, view.w * Math.exp(event.deltaY * WHEEL_ZOOM_RATE));
    }

    function zoomAround(px, py, targetW) {
      const w = clamp(targetW, MIN_VIEW_W, MAX_VIEW_W);
      const k = w / view.w;
      view.cx = px - (px - view.cx) * k;
      view.cy = py - (py - view.cy) * k;
      view.w = w;
      applyView();
    }

    function zoomBy(step) {
      animateTo({ cx: view.cx, cy: view.cy, w: view.w * step }, BUTTON_ZOOM_MS);
    }

    function setHover(entity) {
      const same = hover && entity && hover.kind === entity.kind && hover.id === entity.id;
      if (same || (!hover && !entity)) return;
      hover = entity;
      updateTooltip(performance.now(), true);
    }

    function animateTo(target, durationMs) {
      const to = { cx: target.cx, cy: target.cy, w: clamp(target.w, MIN_VIEW_W, MAX_VIEW_W) };
      if (prefersReducedMotion() || durationMs <= 0) {
        Object.assign(view, to);
        applyView();
        return;
      }
      const run = { from: { ...view }, to, start: performance.now(), durationMs };
      animation = run;
      const step = (now) => {
        if (animation !== run) return;
        const k = easeInOutCubic(clamp((now - run.start) / run.durationMs, 0, 1));
        view.cx = run.from.cx + (run.to.cx - run.from.cx) * k;
        view.cy = run.from.cy + (run.to.cy - run.from.cy) * k;
        view.w = run.from.w * Math.pow(run.to.w / run.from.w, k);
        applyView();
        if (k < 1) requestAnimationFrame(step);
        else animation = null;
      };
      requestAnimationFrame(step);
    }

    function observeResize() {
      const onResize = () => {
        measure();
        mppKey = '';
        applyView();
      };
      if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(svgEl);
      else window.addEventListener('resize', onResize);
    }

    function setTrafficMode(mode) {
      if (!TRAFFIC_MODES.includes(mode)) return;
      trafficMode = mode;
      drawTraffic(performance.now());
    }

    function focus(x, y, w) {
      animateTo({ cx: x, cy: y, w: w || Math.min(view.w, DEFAULT_FOCUS_W) }, FOCUS_MS);
    }

    function setPlacing(on) {
      placing = Boolean(on);
      svgEl.classList.toggle('is-placing', placing);
      if (placing) hideTooltip();
    }

    function onMapClick(fn) {
      mapClickHandlers.push(fn);
    }

    function onEntityClick(fn) {
      entityClickHandlers.push(fn);
    }

    function highlightPatient(id) {
      highlightedId = id || null;
      for (const [pid, rec] of stores.patient) setFlag(rec, 'is-highlight', pid === highlightedId);
    }

    function refreshScenario() {
      applyScenario();
      drawTraffic(performance.now());
    }

    function clientToMap(clientX, clientY) {
      return toMapPoint({ clientX, clientY });
    }

    return { render, setTrafficMode, focus, setPlacing, onMapClick, onEntityClick, highlightPatient, refreshScenario, clientToMap };
  }

  BL.createMap = createMap;
})(window.BL);
