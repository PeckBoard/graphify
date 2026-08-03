// Force-directed layout for the graph view. Velocity-decay integrator with
// Barnes-Hut quadtree repulsion, spring attraction along edges, and centering
// gravity; alpha cools each tick and the sim stops when settled. Pure JS with
// a seeded PRNG (deterministic — testable under vitest, no DOM).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSim(nodes, edges, opts = {}) {
  const o = Object.assign(
    {
      linkDistance: 40,
      charge: -80, // negative = repulsion, d3-style 1/d falloff
      gravity: 0.04,
      velocityDecay: 0.38,
      alphaMin: 0.004,
      alphaDecay: 0.024,
      theta2: 0.81, // Barnes-Hut opening criterion, squared
      seed: 1,
    },
    opts,
  );
  const rng = mulberry32(o.seed || 1);
  const byId = new Map();
  const simNodes = (nodes || []).map((n, i) => {
    const sn = { ref: n, index: i, x: 0, y: 0, vx: 0, vy: 0 };
    byId.set(n.id, sn);
    return sn;
  });

  // Seed positions with communities fanned around the origin so clusters start
  // separated and converge into distinct blobs instead of untangling slowly.
  const comms = [];
  const seen = new Set();
  for (const n of nodes || []) {
    if (!seen.has(n.community)) {
      seen.add(n.community);
      comms.push(n.community);
    }
  }
  const angle = new Map(comms.map((c, i) => [c, (i / Math.max(1, comms.length)) * Math.PI * 2]));
  const R = 60 + 10 * Math.sqrt(simNodes.length);
  for (const sn of simNodes) {
    const a = angle.get(sn.ref.community) || 0;
    const ringR = comms.length > 1 ? R : 0;
    const jr = Math.sqrt(rng()) * R * 0.55;
    const ja = rng() * Math.PI * 2;
    sn.x = Math.cos(a) * ringR + Math.cos(ja) * jr;
    sn.y = Math.sin(a) * ringR + Math.sin(ja) * jr;
  }

  const links = [];
  const deg = new Map();
  for (const e of edges || []) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || s === t) continue;
    links.push({ s, t, strength: 0 });
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  }
  for (const l of links) {
    // Weaker springs on high-degree endpoints (d3 heuristic) so hubs don't
    // collapse their whole neighbourhood onto themselves.
    l.strength = 1 / Math.min(deg.get(l.s.ref.id) || 1, deg.get(l.t.ref.id) || 1);
  }

  return { nodes: simNodes, links, byId, alpha: 1, opts: o, rng, done: false };
}

function jiggle(rng) {
  return (rng() - 0.5) * 1e-3;
}

// One step. Returns false once the sim has settled (alpha < alphaMin).
export function tickSim(sim) {
  if (sim.done || !sim.nodes.length) {
    sim.done = true;
    return false;
  }
  const o = sim.opts;
  const alpha = sim.alpha;

  const tree = buildQuadtree(sim.nodes);
  for (const a of sim.nodes) applyRepulsion(a, tree, o.theta2, o.charge, alpha, sim.rng);

  for (const l of sim.links) {
    let dx = l.t.x + l.t.vx - l.s.x - l.s.vx;
    let dy = l.t.y + l.t.vy - l.s.y - l.s.vy;
    if (!dx && !dy) {
      dx = jiggle(sim.rng);
      dy = jiggle(sim.rng);
    }
    const dist = Math.sqrt(dx * dx + dy * dy);
    const f = ((dist - o.linkDistance) / dist) * alpha * l.strength;
    dx *= f;
    dy *= f;
    l.t.vx -= dx * 0.5;
    l.t.vy -= dy * 0.5;
    l.s.vx += dx * 0.5;
    l.s.vy += dy * 0.5;
  }

  const decay = 1 - o.velocityDecay;
  for (const a of sim.nodes) {
    a.vx += -a.x * o.gravity * alpha;
    a.vy += -a.y * o.gravity * alpha;
    a.vx *= decay;
    a.vy *= decay;
    a.x += a.vx;
    a.y += a.vy;
  }

  sim.alpha += (0 - sim.alpha) * o.alphaDecay;
  if (sim.alpha < o.alphaMin) sim.done = true;
  return true;
}

// ── Barnes-Hut quadtree ──────────────────────────────────────────────────────

function newCell(x0, y0, x1, y1) {
  return { x0, y0, x1, y1, points: null, children: null, mass: 0, cx: 0, cy: 0 };
}

function childFor(cell, n) {
  const mx = (cell.x0 + cell.x1) / 2;
  const my = (cell.y0 + cell.y1) / 2;
  const i = (n.x >= mx ? 1 : 0) | (n.y >= my ? 2 : 0);
  return cell.children[i];
}

function subdivide(cell) {
  const mx = (cell.x0 + cell.x1) / 2;
  const my = (cell.y0 + cell.y1) / 2;
  cell.children = [
    newCell(cell.x0, cell.y0, mx, my),
    newCell(mx, cell.y0, cell.x1, my),
    newCell(cell.x0, my, mx, cell.y1),
    newCell(mx, my, cell.x1, cell.y1),
  ];
}

function insert(cell, n, depth) {
  if (cell.children) {
    insert(childFor(cell, n), n, depth + 1);
    return;
  }
  if (!cell.points) {
    cell.points = [n];
    return;
  }
  const p = cell.points[0];
  // Coincident points (or pathological depth) stack in one leaf instead of
  // recursing forever.
  if (depth > 24 || (Math.abs(p.x - n.x) < 1e-9 && Math.abs(p.y - n.y) < 1e-9)) {
    cell.points.push(n);
    return;
  }
  const pts = cell.points;
  cell.points = null;
  subdivide(cell);
  for (const q of pts) insert(childFor(cell, q), q, depth + 1);
  insert(childFor(cell, n), n, depth + 1);
}

function computeMass(cell) {
  if (cell.children) {
    let m = 0;
    let cx = 0;
    let cy = 0;
    for (const c of cell.children) {
      computeMass(c);
      if (c.mass) {
        m += c.mass;
        cx += c.cx * c.mass;
        cy += c.cy * c.mass;
      }
    }
    cell.mass = m;
    if (m) {
      cell.cx = cx / m;
      cell.cy = cy / m;
    }
    return;
  }
  if (cell.points) {
    cell.mass = cell.points.length;
    let cx = 0;
    let cy = 0;
    for (const p of cell.points) {
      cx += p.x;
      cy += p.y;
    }
    cell.cx = cx / cell.points.length;
    cell.cy = cy / cell.points.length;
  }
}

export function buildQuadtree(nodes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x;
    if (n.y < y0) y0 = n.y;
    if (n.x > x1) x1 = n.x;
    if (n.y > y1) y1 = n.y;
  }
  if (!isFinite(x0)) {
    x0 = y0 = -1;
    x1 = y1 = 1;
  }
  const size = Math.max(x1 - x0, y1 - y0) || 1;
  const root = newCell(x0, y0, x0 + size, y0 + size);
  for (const n of nodes) insert(root, n, 0);
  computeMass(root);
  return root;
}

export function applyRepulsion(a, cell, theta2, charge, alpha, rng) {
  if (!cell.mass) return;
  let dx = cell.cx - a.x;
  let dy = cell.cy - a.y;
  const w = cell.x1 - cell.x0;
  let d2 = dx * dx + dy * dy;

  // Far enough: treat the whole cell as one body.
  if ((w * w) / theta2 < d2) {
    const f = (charge * alpha * cell.mass) / d2;
    a.vx += dx * f;
    a.vy += dy * f;
    return;
  }
  if (cell.children) {
    for (const c of cell.children) applyRepulsion(a, c, theta2, charge, alpha, rng);
    return;
  }
  if (cell.points) {
    for (const p of cell.points) {
      if (p === a) continue;
      dx = p.x - a.x;
      dy = p.y - a.y;
      if (!dx && !dy) {
        dx = jiggle(rng);
        dy = jiggle(rng);
      }
      d2 = dx * dx + dy * dy;
      const f = (charge * alpha) / d2;
      a.vx += dx * f;
      a.vy += dy * f;
    }
  }
}
