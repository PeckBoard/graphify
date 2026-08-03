// Graphify visualizer page. Runs inside PeckBoard's sandboxed plugin iframe
// (opaque origin, no auth token) — all data flows through the parent-proxied
// postMessage fetch bridge (see peckboard/web/src/components/PluginFullPage.tsx).
// Two views, no router: the repo index and the per-repo force-directed graph.

import { CSS } from "./style.js";
import {
  THEME,
  CONF_STYLE,
  CONFIDENCES,
  MAX_NODES,
  MAX_EDGES,
  capGraph,
  communityColorMap,
  communityLegend,
  confidenceSplit,
  formatCount,
  neighborIndex,
  nodeRadius,
  normalizeConfidence,
  searchNodes,
  timeAgo,
} from "./logic.js";
import { createSim, tickSim } from "./sim.js";

const P = "/api/plugin-ui/graphify";

// ── theme ────────────────────────────────────────────────────────────────────

const mediaDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function activeTheme() {
  const stamp = document.documentElement.dataset.theme;
  if (stamp === "dark") return THEME.dark;
  if (stamp === "light") return THEME.light;
  return mediaDark && mediaDark.matches ? THEME.dark : THEME.light;
}

// ── parent-proxied fetch bridge ──────────────────────────────────────────────

const pending = new Map();
let seq = 0;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (m && m.type === "plugin-ui-fetch-result" && pending.has(m.requestId)) {
    const cb = pending.get(m.requestId);
    pending.delete(m.requestId);
    cb(m);
  }
});

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const requestId = ++seq;
    pending.set(requestId, (m) => {
      let data = null;
      try {
        data = m.body ? JSON.parse(m.body) : null;
      } catch (_e) {
        // non-JSON error body; fall through to the status check
      }
      if (m.status >= 200 && m.status < 300) resolve(data || {});
      else reject(new Error((data && data.error) || "request failed (HTTP " + m.status + ")"));
    });
    parent.postMessage(
      {
        type: "plugin-ui-fetch",
        requestId,
        method,
        path,
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      "*",
    );
  });
}
const getJSON = (path) => api("GET", path);
const postJSON = (path, body) => api("POST", path, body || {});

// ── DOM helpers ──────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
  return n;
}
// Static, trusted markup only (icons) — data never goes through innerHTML.
function svgEl(cls, inner, viewBox) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", viewBox || "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "2");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  if (cls) s.setAttribute("class", cls);
  s.innerHTML = inner;
  return s;
}
const WAYPOINTS =
  '<circle cx="12" cy="4.5" r="2.5"/><circle cx="4.5" cy="19.5" r="2.5"/>' +
  '<circle cx="19.5" cy="19.5" r="2.5"/><path d="M10.2 6.3 6.3 17.2"/>' +
  '<path d="M13.8 6.3l3.9 10.9"/><path d="M7 19.5h10"/>';
const SEARCH_ICON = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';

// Small line sample encoding a confidence's dash style (the legend glyph).
function confSample(conf, color) {
  const st = CONF_STYLE[conf];
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 26 8");
  s.setAttribute("class", "sample");
  s.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "1");
  line.setAttribute("y1", "4");
  line.setAttribute("x2", "25");
  line.setAttribute("y2", "4");
  line.setAttribute("stroke", color);
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  if (st.dash.length) line.setAttribute("stroke-dasharray", st.dash.join(" "));
  line.setAttribute("opacity", String(Math.min(1, st.alpha + 0.35)));
  s.appendChild(line);
  return s;
}

function communityColor(theme, slot) {
  return slot >= 0 ? theme.series[slot] : theme.other;
}

// ── state ────────────────────────────────────────────────────────────────────

const state = {
  view: "index", // "index" | "graph"
  loading: true,
  loadError: "",
  status: null, // {graphify_installed, python_bin, version}
  repos: [],
  building: new Map(), // repo path -> {started}
  install: { phase: "idle", result: null, error: "" }, // idle|running|done
  repo: null, // repo card the graph view was opened from
};

let app;
let viz = null; // live graph-view runtime, see startViz()

// ── boot ─────────────────────────────────────────────────────────────────────

(function boot() {
  const qs = new URLSearchParams(location.search);
  const t = qs.get("theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  app = document.getElementById("app");
  if (!app) {
    app = el("div");
    app.id = "app";
    document.body.appendChild(app);
  }
  if (mediaDark) {
    const onTheme = () => {
      if (viz) {
        viz.theme = activeTheme();
        buildLegend();
        requestDraw();
      }
    };
    if (mediaDark.addEventListener) mediaDark.addEventListener("change", onTheme);
  }
  window.addEventListener("keydown", onGlobalKey);
  loadIndex();
})();

async function loadIndex() {
  try {
    const [status, repos] = await Promise.all([getJSON(P + "/status"), getJSON(P + "/repos")]);
    state.status = status;
    state.repos = repos.repos || [];
    state.loadError = "";
  } catch (e) {
    state.loadError = String((e && e.message) || e);
  }
  state.loading = false;
  if (state.view === "index") renderIndex();
}

// ── repo index ───────────────────────────────────────────────────────────────

let elapsedTimer = null;

function renderIndex() {
  destroyViz();
  clear(app);
  const theme = activeTheme();

  const bar = el("header", "topbar");
  bar.appendChild(svgEl("mark", WAYPOINTS));
  bar.appendChild(el("h1", "", "Graphify"));
  const sub = el("span", "sub");
  if (state.status && state.status.graphify_installed) {
    sub.textContent =
      "graphify " + (state.status.version || "?") + " · " + (state.status.python_bin || "python3");
  } else if (state.status) {
    sub.textContent = "not installed";
  }
  bar.appendChild(sub);
  bar.appendChild(el("div", "spacer"));
  const refresh = el("button", "", "Refresh");
  refresh.addEventListener("click", () => {
    state.loading = true;
    renderIndex();
    loadIndex();
  });
  bar.appendChild(refresh);
  app.appendChild(bar);

  const wrap = el("main", "wrap");
  app.appendChild(wrap);

  if (state.loading) {
    const e = el("div", "empty");
    e.appendChild(el("span", "spin"));
    e.appendChild(el("div", "", "Looking for repos…"));
    wrap.appendChild(e);
    return;
  }
  if (state.loadError) {
    const b = el("div", "banner error");
    const g = el("div", "grow");
    g.appendChild(el("b", "", "Couldn't load Graphify data. "));
    g.appendChild(el("span", "note", state.loadError));
    b.appendChild(g);
    wrap.appendChild(b);
  }
  if (state.status && !state.status.graphify_installed) wrap.appendChild(installBanner());

  if (!state.repos.length && !state.loadError) {
    const e = el("div", "empty");
    e.appendChild(svgEl("", WAYPOINTS));
    e.appendChild(el("div", "", "No repos found in this folder."));
    e.appendChild(el("div", "", "Quiet skies — nothing to map yet."));
    wrap.appendChild(e);
    return;
  }

  const cards = el("div", "cards");
  for (const repo of state.repos) cards.appendChild(repoCard(repo, theme));
  wrap.appendChild(cards);

  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  if (state.building.size) {
    elapsedTimer = setInterval(() => {
      if (state.view !== "index" || !state.building.size) {
        clearInterval(elapsedTimer);
        elapsedTimer = null;
        return;
      }
      document.querySelectorAll("[data-elapsed]").forEach((n) => {
        const b = state.building.get(n.dataset.elapsed);
        if (b) n.textContent = buildElapsed(b.started);
      });
    }, 1000);
  }
}

function buildElapsed(started) {
  const s = Math.floor((Date.now() - started) / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function installBanner() {
  const b = el("div", "banner warn");
  const g = el("div", "grow");
  const inst = state.install;
  const r = inst.result;
  if (inst.phase === "done" && r && r.timed_out) {
    g.appendChild(el("b", "", "Install timed out. "));
    g.appendChild(
      el("span", "note", "It may still be running — otherwise run this yourself, then Refresh:"),
    );
    b.appendChild(g);
    const code = el("code", "codebox", r.manual_command || "pip install --user graphifyy");
    b.appendChild(code);
    b.appendChild(copyButton(r.manual_command || "pip install --user graphifyy"));
    return b;
  }
  if (inst.phase === "done" && r && !r.installed) {
    g.appendChild(el("b", "", "Install failed. "));
    g.appendChild(el("span", "note", "Output below — or run it by hand:"));
    b.appendChild(g);
    b.appendChild(el("code", "codebox", r.manual_command || "pip install --user graphifyy"));
    b.appendChild(copyButton(r.manual_command || "pip install --user graphifyy"));
    if (r.output) b.appendChild(el("pre", "outbox", String(r.output).slice(-2000)));
    return b;
  }
  if (inst.phase === "idle" && inst.error) {
    g.appendChild(el("b", "", "Install failed. "));
    g.appendChild(el("span", "note", inst.error));
  } else {
    g.appendChild(el("b", "", "graphify isn't installed. "));
    g.appendChild(
      el("span", "note", "Install it to build knowledge graphs (pip install --user graphifyy)."),
    );
  }
  b.appendChild(g);
  const btn = el("button", "primary");
  if (inst.phase === "running") {
    btn.disabled = true;
    btn.appendChild(el("span", "spin"));
    btn.appendChild(document.createTextNode(" Installing… can take a few minutes"));
  } else {
    btn.textContent = "Install graphify";
    btn.addEventListener("click", runInstall);
  }
  b.appendChild(btn);
  return b;
}

async function runInstall() {
  state.install = { phase: "running", result: null, error: "" };
  renderIndex();
  try {
    const r = await postJSON(P + "/install");
    state.install = { phase: "done", result: r, error: "" };
    if (r.installed) await loadIndex();
  } catch (e) {
    state.install = { phase: "idle", result: null, error: String((e && e.message) || e) };
  }
  if (state.view === "index") renderIndex();
}

function copyButton(text) {
  const btn = el("button", "", "Copy");
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const done = () => {
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => selectCode(btn));
    } else {
      selectCode(btn);
    }
  });
  return btn;
}
function selectCode(btn) {
  // Clipboard API can be denied in the sandbox — fall back to selecting the
  // command so a plain Ctrl/Cmd-C works.
  const code = btn.parentElement && btn.parentElement.querySelector(".codebox");
  if (code && window.getSelection) {
    const range = document.createRange();
    range.selectNodeContents(code);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function repoCard(repo, theme) {
  const building = state.building.has(repo.path);
  const canOpen = !!repo.has_graph && !building;
  const card = el("article", "card" + (canOpen ? " open" : ""));
  if (canOpen) {
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "Open graph for " + (repo.name || repo.path));
    const open = () => openGraph(repo);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  }

  const head = el("div", "card-head");
  head.appendChild(el("h2", "", repo.name || repo.path));
  const btn = el("button");
  if (building) {
    btn.disabled = true;
    btn.appendChild(el("span", "spin"));
    btn.appendChild(document.createTextNode(" Building… "));
    const t = el("span", "", buildElapsed(state.building.get(repo.path).started));
    t.dataset.elapsed = repo.path;
    btn.appendChild(t);
  } else {
    btn.textContent = repo.has_graph ? "Rebuild" : "Build";
    btn.disabled = !!(state.status && !state.status.graphify_installed);
    btn.setAttribute("aria-label", btn.textContent + " graph for " + (repo.name || repo.path));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      startBuild(repo);
    });
  }
  head.appendChild(btn);
  card.appendChild(head);
  card.appendChild(el("div", "path", repo.path));

  if (building) {
    card.setAttribute("aria-busy", "true");
    card.appendChild(
      el("div", "nograph", "Building the graph — large repos can take a few minutes."),
    );
    return card;
  }
  if (!repo.has_graph) {
    card.appendChild(el("div", "nograph", "No graph yet — build one to map this repo."));
    return card;
  }

  const stats = el("div", "stats");
  for (const [v, label] of [
    [repo.nodes, "nodes"],
    [repo.edges, "edges"],
    [repo.communities, "communities"],
  ]) {
    const s = el("div", "stat");
    s.appendChild(el("b", "", formatCount(v || 0)));
    s.appendChild(el("span", "", label));
    stats.appendChild(s);
  }
  card.appendChild(stats);

  const split = confidenceSplit(repo.confidence);
  const total = split.reduce((a, s) => a + s.count, 0);
  if (total) {
    const meter = el("div", "meter");
    meter.setAttribute("role", "img");
    meter.setAttribute(
      "aria-label",
      "Edge confidence: " + split.map((s) => s.key + " " + s.pct + "%").join(", "),
    );
    for (const s of split) {
      if (!s.count) continue;
      const seg = el("i");
      seg.style.width = Math.max(2, s.pct) + "%";
      seg.style.background = theme.conf[s.key];
      meter.appendChild(seg);
    }
    card.appendChild(meter);
    const leg = el("div", "meter-legend");
    for (const s of split) {
      const item = el("span");
      item.appendChild(el("span", "k", s.key.toLowerCase()));
      item.appendChild(document.createTextNode(" " + s.pct + "%"));
      leg.appendChild(item);
    }
    card.appendChild(leg);
  }

  if (Array.isArray(repo.god_nodes) && repo.god_nodes.length) {
    const chips = el("div", "chips");
    for (const g of repo.god_nodes.slice(0, 5)) {
      const c = el("span", "chip");
      c.appendChild(el("b", "", g.label || ""));
      c.appendChild(document.createTextNode(" · " + formatCount(g.degree || 0)));
      c.title = (g.label || "") + " — degree " + formatCount(g.degree || 0);
      chips.appendChild(c);
    }
    card.appendChild(chips);
  }

  const foot = el("div", "foot");
  const when = timeAgo(repo.built_at, Date.now());
  foot.appendChild(el("span", "built", when ? "Built " + when : ""));
  foot.appendChild(el("span", "sub", "View graph →"));
  card.appendChild(foot);
  return card;
}

async function startBuild(repo) {
  if (state.building.has(repo.path)) return;
  state.building.set(repo.path, { started: Date.now() });
  if (state.view === "index") renderIndex();
  try {
    await postJSON(P + "/build", { repo: repo.path });
  } catch (e) {
    state.loadError = "Build failed for " + repo.path + ": " + String((e && e.message) || e);
  }
  state.building.delete(repo.path);
  await loadIndex();
}

// ── graph view ───────────────────────────────────────────────────────────────

function onGlobalKey(e) {
  if (e.key !== "Escape" || !viz) return;
  if (viz.searchOpen) {
    closeSearchMenu();
  } else if (viz.selected) {
    selectNode(null);
  } else if (viz.communityFocus !== null) {
    viz.communityFocus = null;
    buildLegend();
    requestDraw();
  }
}

async function openGraph(repo) {
  state.view = "graph";
  state.repo = repo;
  clear(app);
  const gv = el("div", "gview");
  const loading = el("div", "gloading");
  loading.appendChild(el("span", "spin"));
  loading.appendChild(el("span", "", "Loading graph for " + (repo.name || repo.path) + "…"));
  const gmain = el("div", "gmain");
  gmain.appendChild(loading);
  gv.appendChild(graphBar(repo, null));
  gv.appendChild(gmain);
  app.appendChild(gv);
  try {
    const g = await getJSON(P + "/graph?repo=" + encodeURIComponent(repo.path));
    if (state.view !== "graph" || state.repo !== repo) return;
    startViz(repo, g);
  } catch (e) {
    if (state.view !== "graph" || state.repo !== repo) return;
    clear(gmain);
    const b = el("div", "banner error");
    b.style.margin = "20px";
    const gr = el("div", "grow");
    gr.appendChild(el("b", "", "Couldn't load the graph. "));
    gr.appendChild(el("span", "note", String((e && e.message) || e)));
    b.appendChild(gr);
    gmain.appendChild(b);
  }
}

function backToIndex() {
  state.view = "index";
  state.repo = null;
  renderIndex();
  loadIndex();
}

function graphBar(repo, g) {
  const bar = el("div", "gbar");
  const back = el("button", "", "← Repos");
  back.addEventListener("click", backToIndex);
  bar.appendChild(back);
  const title = el("div", "gtitle");
  title.appendChild(el("b", "", repo.name || repo.path));
  if (g && g.stats) {
    title.appendChild(
      el(
        "span",
        "gstats",
        formatCount(g.stats.nodes || 0) +
          " nodes · " +
          formatCount(g.stats.edges || 0) +
          " edges · " +
          formatCount(g.stats.communities || 0) +
          " communities",
      ),
    );
  }
  bar.appendChild(title);
  bar.appendChild(el("div", "spacer"));
  if (g) bar.appendChild(searchBox());
  return bar;
}

function startViz(repo, g) {
  const cap = capGraph(g.nodes || [], g.edges || [], MAX_NODES, MAX_EDGES);
  const colorIdx = communityColorMap(g.communities);
  const commLabel = new Map((g.communities || []).map((c) => [c.id, c.label || "community " + c.id]));
  const sim = createSim(cap.nodes, cap.edges, { seed: 42 });

  viz = {
    repo,
    g,
    cap,
    sim,
    colorIdx,
    commLabel,
    adj: neighborIndex(cap.edges),
    nodeById: new Map(cap.nodes.map((n) => [n.id, n])),
    theme: activeTheme(),
    // view transform (CSS px): screen = world * k + t
    k: 1,
    tx: 0,
    ty: 0,
    autoFit: true,
    dpr: window.devicePixelRatio || 1,
    hovered: null,
    selected: null,
    communityFocus: null,
    confOff: new Set(),
    searchOpen: false,
    searchQ: "",
    raf: 0,
    running: false,
    canvas: null,
    ctx: null,
    w: 0,
    h: 0,
    labelNodes: cap.nodes
      .slice()
      .sort((a, b) => (b.degree || 0) - (a.degree || 0))
      .slice(0, 22),
    edgesByConf: { EXTRACTED: [], INFERRED: [], AMBIGUOUS: [] },
    ro: null,
    destroyers: [],
  };
  for (const e of cap.edges) viz.edgesByConf[normalizeConfidence(e.confidence)].push(e);

  clear(app);
  const gv = el("div", "gview");
  gv.appendChild(graphBar(repo, g));

  if (cap.nodeCapped || cap.edgeCapped) {
    let msg = "";
    if (cap.nodeCapped) {
      msg =
        "Showing the " +
        formatCount(cap.nodes.length) +
        " highest-degree nodes of " +
        formatCount(cap.totalNodes) +
        " — edges touching hidden nodes are hidden too.";
    }
    if (cap.edgeCapped) {
      msg +=
        (msg ? " " : "") +
        "Edges capped at " +
        formatCount(MAX_EDGES) +
        " of " +
        formatCount(cap.totalEdges) +
        ", keeping EXTRACTED first.";
    }
    gv.appendChild(el("div", "capnote", msg));
  }

  const gmain = el("div", "gmain");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Force-directed graph of " +
      (repo.name || repo.path) +
      ". Use the search box to find nodes; details open in a side panel.",
  );
  gmain.appendChild(canvas);
  gmain.appendChild(el("div", "legend"));
  const tooltip = el("div", "tooltip");
  tooltip.hidden = true;
  gmain.appendChild(tooltip);
  const drawer = el("aside", "drawer");
  drawer.hidden = true;
  drawer.setAttribute("aria-label", "Node details");
  gmain.appendChild(drawer);
  gv.appendChild(gmain);
  app.appendChild(gv);

  viz.canvas = canvas;
  viz.ctx = canvas.getContext("2d");
  viz.gmain = gmain;
  viz.tooltip = tooltip;
  viz.drawer = drawer;

  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(gmain);
  viz.ro = ro;
  resizeCanvas();
  buildLegend();
  bindCanvas(canvas);
  startLoop();
}

function destroyViz() {
  if (!viz) return;
  if (viz.raf) cancelAnimationFrame(viz.raf);
  if (viz.ro) viz.ro.disconnect();
  for (const d of viz.destroyers) d();
  viz = null;
}

function resizeCanvas() {
  if (!viz || !viz.canvas) return;
  const r = viz.gmain.getBoundingClientRect();
  viz.w = Math.max(1, r.width);
  viz.h = Math.max(1, r.height);
  viz.dpr = window.devicePixelRatio || 1;
  viz.canvas.width = Math.round(viz.w * viz.dpr);
  viz.canvas.height = Math.round(viz.h * viz.dpr);
  requestDraw();
}

// ── sim loop / drawing ───────────────────────────────────────────────────────

function startLoop() {
  viz.running = true;
  const loop = () => {
    if (!viz) return;
    let active = false;
    for (let i = 0; i < 2; i++) active = tickSim(viz.sim) || active;
    if (viz.autoFit) fitView();
    draw();
    if (active) {
      viz.raf = requestAnimationFrame(loop);
    } else {
      viz.raf = 0;
      viz.running = false;
    }
  };
  viz.raf = requestAnimationFrame(loop);
}

function requestDraw() {
  if (!viz || viz.running || viz.raf) return;
  viz.raf = requestAnimationFrame(() => {
    if (!viz) return;
    viz.raf = 0;
    draw();
  });
}

function fitView() {
  const n = viz.sim.nodes;
  if (!n.length) return;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const a of n) {
    if (a.x < x0) x0 = a.x;
    if (a.y < y0) y0 = a.y;
    if (a.x > x1) x1 = a.x;
    if (a.y > y1) y1 = a.y;
  }
  const pad = 60;
  const bw = x1 - x0 + pad * 2;
  const bh = y1 - y0 + pad * 2;
  viz.k = Math.min(2, Math.min(viz.w / bw, viz.h / bh));
  viz.tx = viz.w / 2 - ((x0 + x1) / 2) * viz.k;
  viz.ty = viz.h / 2 - ((y0 + y1) / 2) * viz.k;
}

// Which nodes are emphasized right now (null = no emphasis anywhere).
function focusSet() {
  if (viz.hovered) {
    const s = new Set([viz.hovered.id]);
    for (const nb of viz.adj.get(viz.hovered.id) || []) s.add(nb.id);
    return { set: s, anchor: viz.hovered.id };
  }
  if (viz.searchQ) {
    const s = new Set(searchNodes(viz.cap.nodes, viz.searchQ, 1e9).map((n) => n.id));
    return { set: s, anchor: null };
  }
  if (viz.selected) {
    const s = new Set([viz.selected.id]);
    for (const nb of viz.adj.get(viz.selected.id) || []) s.add(nb.id);
    return { set: s, anchor: viz.selected.id };
  }
  if (viz.communityFocus !== null) {
    const s = new Set();
    for (const n of viz.cap.nodes) {
      const slot = viz.colorIdx.get(n.community);
      const inOther = slot === undefined || slot < 0;
      if (viz.communityFocus === -1 ? inOther : n.community === viz.communityFocus) s.add(n.id);
    }
    return { set: s, anchor: null };
  }
  return null;
}

function draw() {
  const t = viz.theme;
  const ctx = viz.ctx;
  const dpr = viz.dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viz.w, viz.h);
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, viz.w, viz.h);

  const k = viz.k;
  const tx = viz.tx;
  const ty = viz.ty;
  const focus = focusSet();
  const sn = viz.sim.byId;
  const sx = (n) => n.x * k + tx;
  const sy = (n) => n.y * k + ty;

  // Edges: one pass per confidence per emphasis level, batched into single
  // strokes (setLineDash is per-path, and dashes stay in screen px).
  for (const conf of CONFIDENCES) {
    if (viz.confOff.has(conf)) continue;
    const st = CONF_STYLE[conf];
    const edges = viz.edgesByConf[conf];
    for (const bright of focus ? [false, true] : [false]) {
      ctx.beginPath();
      let any = false;
      for (const e of edges) {
        const a = sn.get(e.source);
        const b = sn.get(e.target);
        if (!a || !b) continue;
        if (focus) {
          let hit;
          if (focus.anchor !== null) {
            hit =
              (e.source === focus.anchor && focus.set.has(e.target)) ||
              (e.target === focus.anchor && focus.set.has(e.source));
          } else {
            hit = focus.set.has(e.source) && focus.set.has(e.target);
          }
          if (hit !== bright) continue;
        }
        ctx.moveTo(sx(a), sy(a));
        ctx.lineTo(sx(b), sy(b));
        any = true;
      }
      if (!any) continue;
      ctx.setLineDash(st.dash);
      ctx.lineWidth = 1;
      ctx.strokeStyle = t.edge;
      ctx.globalAlpha = focus && !bright ? st.alpha * 0.15 : st.alpha;
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Nodes: dim pass then bright pass so emphasized nodes sit on top.
  for (const bright of focus ? [false, true] : [true]) {
    for (const a of viz.sim.nodes) {
      const id = a.ref.id;
      if (focus && focus.set.has(id) !== bright) continue;
      const slot = viz.colorIdx.has(a.ref.community) ? viz.colorIdx.get(a.ref.community) : -1;
      const r = Math.max(1.5, nodeRadius(a.ref.degree) * Math.min(1, k * 2));
      ctx.globalAlpha = focus && !bright ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(sx(a), sy(a), r, 0, Math.PI * 2);
      ctx.fillStyle = communityColor(t, slot);
      ctx.fill();
      // hairline surface ring so touching nodes stay separable
      ctx.lineWidth = 1;
      ctx.strokeStyle = t.bg;
      ctx.stroke();
      if (viz.selected && id === viz.selected.id) {
        ctx.beginPath();
        ctx.arc(sx(a), sy(a), r + 3, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = t.accent;
        ctx.stroke();
      }
    }
  }
  ctx.globalAlpha = 1;

  // Labels: top-degree nodes always; the focused neighbourhood when focused.
  ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  let labelled;
  if (focus && focus.anchor !== null) {
    labelled = [];
    for (const id of focus.set) {
      const a = sn.get(id);
      if (a) labelled.push(a);
      if (labelled.length >= 40) break;
    }
  } else if (focus) {
    labelled = viz.labelNodes.map((n) => sn.get(n.id)).filter((a) => a && focus.set.has(a.ref.id));
  } else {
    labelled = viz.labelNodes.map((n) => sn.get(n.id)).filter(Boolean);
  }
  for (const a of labelled) {
    const r = Math.max(1.5, nodeRadius(a.ref.degree) * Math.min(1, k * 2));
    const x = sx(a) + r + 4;
    const y = sy(a);
    if (x < -80 || x > viz.w + 20 || y < -20 || y > viz.h + 20) continue;
    const label = String(a.ref.label || "").slice(0, 40);
    ctx.lineWidth = 3;
    ctx.strokeStyle = t.halo;
    ctx.strokeText(label, x, y);
    ctx.fillStyle = t.text2;
    ctx.fillText(label, x, y);
  }
}

// ── canvas interaction ───────────────────────────────────────────────────────

function bindCanvas(canvas) {
  let dragging = false;
  let moved = false;
  let px = 0;
  let py = 0;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = false;
    px = e.clientX;
    py = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        moved = true;
        viz.autoFit = false;
        viz.tx += dx;
        viz.ty += dy;
        px = e.clientX;
        py = e.clientY;
        requestDraw();
      }
      return;
    }
    const n = hitTest(e);
    if (n !== viz.hovered) {
      viz.hovered = n;
      canvas.style.cursor = n ? "pointer" : "";
      requestDraw();
    }
    moveTooltip(e, n);
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    if (!moved) {
      const n = hitTest(e);
      selectNode(n || null);
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (viz && viz.hovered) {
      viz.hovered = null;
      viz.tooltip.hidden = true;
      requestDraw();
    }
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      viz.autoFit = false;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      const k2 = Math.min(8, Math.max(0.03, viz.k * factor));
      // keep the world point under the cursor fixed
      viz.tx = mx - ((mx - viz.tx) / viz.k) * k2;
      viz.ty = my - ((my - viz.ty) / viz.k) * k2;
      viz.k = k2;
      requestDraw();
    },
    { passive: false },
  );
}

function hitTest(e) {
  const rect = viz.canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  let best = null;
  let bestD = Infinity;
  for (const a of viz.sim.nodes) {
    const r = Math.max(6, nodeRadius(a.ref.degree) * Math.min(1, viz.k * 2) + 2);
    const dx = a.x * viz.k + viz.tx - mx;
    const dy = a.y * viz.k + viz.ty - my;
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r && d2 < bestD) {
      best = a.ref;
      bestD = d2;
    }
  }
  return best;
}

function moveTooltip(e, n) {
  const tip = viz.tooltip;
  if (!n) {
    tip.hidden = true;
    return;
  }
  clear(tip);
  tip.appendChild(el("div", "", n.label || ""));
  const slot = viz.colorIdx.has(n.community) ? viz.colorIdx.get(n.community) : -1;
  tip.appendChild(
    el(
      "div",
      "sub",
      (viz.commLabel.get(n.community) || "community " + n.community) +
        " · degree " +
        formatCount(n.degree || 0),
    ),
  );
  tip.style.borderLeft = "3px solid " + communityColor(viz.theme, slot);
  const rect = viz.gmain.getBoundingClientRect();
  tip.hidden = false;
  const x = Math.min(e.clientX - rect.left + 14, rect.width - tip.offsetWidth - 8);
  const y = Math.min(e.clientY - rect.top + 14, rect.height - tip.offsetHeight - 8);
  tip.style.left = Math.max(4, x) + "px";
  tip.style.top = Math.max(4, y) + "px";
}

function centerOn(node) {
  const a = viz.sim.byId.get(node.id);
  if (!a) return;
  viz.autoFit = false;
  if (viz.k < 1) viz.k = 1.4;
  viz.tx = viz.w / 2 - a.x * viz.k;
  viz.ty = viz.h / 2 - a.y * viz.k;
  requestDraw();
}

// ── legend ───────────────────────────────────────────────────────────────────

function buildLegend() {
  if (!viz) return;
  const t = viz.theme;
  const box = viz.gmain.querySelector(".legend");
  clear(box);

  box.appendChild(el("h3", "", "Communities"));
  const leg = communityLegend(viz.g.communities);
  leg.top.forEach((c, i) => {
    box.appendChild(
      legendRow(t.series[i], c.label || "community " + c.id, formatCount(c.size || 0), c.id),
    );
  });
  if (leg.otherCount) {
    box.appendChild(
      legendRow(t.other, "Other (" + leg.otherCount + " smaller)", formatCount(leg.otherSize), -1),
    );
  }

  box.appendChild(el("div", "sep"));
  box.appendChild(el("h3", "", "Edge confidence"));
  const split = confidenceSplit(viz.g.stats && viz.g.stats.confidence);
  for (const s of split) {
    const off = viz.confOff.has(s.key);
    const row = el("button", "lrow" + (off ? " off" : ""));
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", String(!off));
    row.setAttribute("aria-label", "Show " + s.key + " edges");
    row.appendChild(confSample(s.key, t.conf[s.key]));
    row.appendChild(el("span", "name", s.key.toLowerCase()));
    row.appendChild(el("span", "n", s.pct + "%"));
    row.addEventListener("click", () => {
      if (viz.confOff.has(s.key)) viz.confOff.delete(s.key);
      else viz.confOff.add(s.key);
      buildLegend();
      requestDraw();
    });
    box.appendChild(row);
  }
}

function legendRow(color, name, count, communityId) {
  const row = el("button", "lrow");
  const pressed = viz.communityFocus === communityId;
  row.setAttribute("aria-pressed", String(pressed));
  row.title = "Highlight this community";
  const dot = el("span", "dot");
  dot.style.background = color;
  row.appendChild(dot);
  row.appendChild(el("span", "name", name));
  row.appendChild(el("span", "n", count));
  row.addEventListener("click", () => {
    viz.communityFocus = pressed ? null : communityId;
    buildLegend();
    requestDraw();
  });
  return row;
}

// ── search ───────────────────────────────────────────────────────────────────

function searchBox() {
  const box = el("div", "search");
  box.appendChild(svgEl("icon", SEARCH_ICON));
  const input = el("input");
  input.type = "search";
  input.placeholder = "Find a node…";
  input.setAttribute("aria-label", "Find a node by label");
  box.appendChild(input);
  const menu = el("div", "smenu");
  menu.hidden = true;
  box.appendChild(menu);

  let hi = -1;
  const rebuild = () => {
    if (!viz) return;
    viz.searchQ = input.value.trim();
    hi = -1;
    clear(menu);
    const matches = viz.searchQ ? searchNodes(viz.cap.nodes, viz.searchQ, 8) : [];
    if (!matches.length) {
      menu.hidden = true;
      viz.searchOpen = false;
      requestDraw();
      return;
    }
    matches.forEach((n) => {
      const opt = el("button", "sopt");
      opt.appendChild(el("span", "lab", n.label || ""));
      const sub = el("span", "sub");
      const slot = viz.colorIdx.has(n.community) ? viz.colorIdx.get(n.community) : -1;
      const dot = el("span", "dot");
      dot.style.background = communityColor(viz.theme, slot);
      sub.appendChild(dot);
      sub.appendChild(
        document.createTextNode(
          (viz.commLabel.get(n.community) || "community " + n.community) +
            " · degree " +
            formatCount(n.degree || 0),
        ),
      );
      opt.appendChild(sub);
      opt.addEventListener("click", () => pick(n));
      menu.appendChild(opt);
    });
    menu.hidden = false;
    viz.searchOpen = true;
    requestDraw();
  };
  const pick = (n) => {
    input.value = n.label || "";
    closeSearchMenu();
    viz.searchQ = "";
    selectNode(n);
    centerOn(n);
  };
  const setHi = (d) => {
    const opts = [...menu.querySelectorAll(".sopt")];
    if (!opts.length) return;
    hi = (hi + d + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("hi", i === hi));
  };
  input.addEventListener("input", rebuild);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(-1);
    } else if (e.key === "Enter") {
      const opts = [...menu.querySelectorAll(".sopt")];
      if (opts.length) opts[Math.max(0, hi)].click();
    } else if (e.key === "Escape") {
      input.value = "";
      if (viz) viz.searchQ = "";
      closeSearchMenu();
      requestDraw();
      e.stopPropagation();
    }
  });
  input.addEventListener("blur", () => setTimeout(closeSearchMenu, 150));
  return box;
}

function closeSearchMenu() {
  if (!viz) return;
  const menu = document.querySelector(".smenu");
  if (menu) menu.hidden = true;
  viz.searchOpen = false;
}

// ── detail drawer ────────────────────────────────────────────────────────────

function selectNode(n) {
  if (!viz) return;
  viz.selected = n;
  renderDrawer();
  requestDraw();
}

function renderDrawer() {
  const d = viz.drawer;
  const n = viz.selected;
  if (!n) {
    d.hidden = true;
    return;
  }
  clear(d);
  const t = viz.theme;
  const head = el("div", "dhead");
  head.appendChild(el("h2", "", n.label || ""));
  const close = el("button", "ghost", "✕");
  close.setAttribute("aria-label", "Close details");
  close.addEventListener("click", () => selectNode(null));
  head.appendChild(close);
  d.appendChild(head);

  const kv = el("dl", "kv");
  const slot = viz.colorIdx.has(n.community) ? viz.colorIdx.get(n.community) : -1;
  const addKV = (k, vNode) => {
    kv.appendChild(el("dt", "", k));
    kv.appendChild(vNode);
  };
  if (n.source_file) {
    const dd = el("dd", "mono");
    dd.className = "mono";
    dd.textContent = n.source_file + (n.source_location ? ":" + n.source_location : "");
    addKV("Source", dd);
  }
  const cdd = el("dd");
  const cdot = el("span", "dot");
  cdot.style.cssText =
    "display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:" +
    communityColor(t, slot);
  cdd.appendChild(cdot);
  cdd.appendChild(
    document.createTextNode(viz.commLabel.get(n.community) || "community " + n.community),
  );
  addKV("Community", cdd);
  addKV("Degree", el("dd", "", formatCount(n.degree || 0)));
  d.appendChild(kv);

  const neighbors = (viz.adj.get(n.id) || [])
    .slice()
    .sort(
      (a, b) =>
        ((viz.nodeById.get(b.id) || {}).degree || 0) - ((viz.nodeById.get(a.id) || {}).degree || 0),
    );
  d.appendChild(el("h3", "", "Neighbours (" + neighbors.length + ")"));
  if (viz.cap.nodeCapped || viz.cap.edgeCapped) {
    d.appendChild(el("div", "note", "Within the shown subgraph — the full graph has more."));
  }
  const list = el("div", "nrows");
  for (const nb of neighbors.slice(0, 100)) {
    const other = viz.nodeById.get(nb.id);
    const row = el("button", "nrow");
    row.appendChild(confSample(nb.confidence, t.conf[nb.confidence]));
    row.appendChild(el("span", "nl", (other && other.label) || nb.id));
    row.appendChild(
      el("span", "rel", (nb.dir === "in" ? "← " : "") + nb.relation + " · " + nb.confidence.toLowerCase()),
    );
    row.addEventListener("click", () => {
      if (other) {
        selectNode(other);
        centerOn(other);
      }
    });
    list.appendChild(row);
  }
  d.appendChild(list);
  if (neighbors.length > 100) {
    d.appendChild(el("div", "more", "+" + formatCount(neighbors.length - 100) + " more"));
  }
  d.hidden = false;
}
