// Page CSS, generated from the THEME tokens in logic.js so the DOM and the
// canvas always agree on colours. Light is the default; dark applies via
// prefers-color-scheme AND via an explicit <html data-theme="dark"> stamp
// (?theme=dark|light in the iframe URL), with the stamp winning both ways.

import { THEME } from "./logic.js";

function vars(t) {
  return (
    `--bg:${t.bg};--surface:${t.surface};--surface2:${t.surface2};` +
    `--surface-hover:${t.surfaceHover};--text:${t.text};--text2:${t.text2};` +
    `--text3:${t.text3};--border:${t.border};--border-strong:${t.borderStrong};` +
    `--accent:${t.accent};--accent-hover:${t.accentHover};--accent-subtle:${t.accentSubtle};` +
    `--ring:${t.ring};--danger:${t.danger};--danger-bg:${t.dangerBg};` +
    `--danger-border:${t.dangerBorder};--warn-text:${t.warnText};--warn-bg:${t.warnBg};` +
    `--warn-border:${t.warnBorder};--conf-e:${t.conf.EXTRACTED};--conf-i:${t.conf.INFERRED};` +
    `--conf-a:${t.conf.AMBIGUOUS};`
  );
}

export const CSS = `
:root { ${vars(THEME.light)} color-scheme: light; }
:root[data-theme="dark"] { ${vars(THEME.dark)} color-scheme: dark; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${vars(THEME.dark)} color-scheme: dark; }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
}
#app { height: 100%; display: flex; flex-direction: column; }
code, .mono { font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace; }

button {
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 11px; font: inherit; cursor: pointer;
}
button:hover { background: var(--surface-hover); border-color: var(--border-strong); }
button.primary { background: var(--accent); border-color: transparent; color: #fff; }
button.primary:hover { background: var(--accent-hover); }
button:disabled { opacity: 0.55; cursor: default; }
button.ghost { background: none; border-color: transparent; }
button.ghost:hover { background: var(--surface-hover); }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
input {
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 9px; font: inherit;
}
input::placeholder { color: var(--text3); }
input:focus { outline: 2px solid var(--ring); outline-offset: 1px; border-color: transparent; }

.spin {
  display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--border-strong); border-top-color: var(--accent);
  animation: spin 0.8s linear infinite; vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── repo index ── */
.topbar {
  display: flex; align-items: center; gap: 10px; padding: 12px 20px;
  border-bottom: 1px solid var(--border); background: var(--surface); flex: none;
}
.topbar svg.mark { width: 18px; height: 18px; color: var(--accent); flex: none; }
.topbar h1 { font-size: 15px; font-weight: 600; margin: 0; }
.topbar .sub { color: var(--text3); font-size: 12px; }
.topbar .spacer { flex: 1; }
.wrap { flex: 1; overflow: auto; padding: 20px; }
.wrap > * { max-width: 1180px; margin-left: auto; margin-right: auto; }

.banner {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  border: 1px solid var(--border); border-radius: 10px; background: var(--surface);
  padding: 12px 16px; margin-bottom: 16px;
}
.banner.warn { background: var(--warn-bg); border-color: var(--warn-border); }
.banner.error { background: var(--danger-bg); border-color: var(--danger-border); }
.banner .grow { flex: 1; min-width: 200px; }
.banner b { font-weight: 600; }
.banner .note { color: var(--text2); font-size: 12px; }
.codebox {
  font-family: "SF Mono", "Fira Code", ui-monospace, monospace; font-size: 12px;
  background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
  padding: 7px 10px; user-select: all; overflow-x: auto; white-space: nowrap;
}
.outbox {
  font-family: ui-monospace, monospace; font-size: 11px; color: var(--text2);
  background: var(--surface2); border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 10px; max-height: 140px; overflow: auto; white-space: pre-wrap;
  flex-basis: 100%; margin: 0;
}

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
  transition: border-color 150ms ease, box-shadow 150ms ease; text-align: left;
}
.card.open { cursor: pointer; }
.card.open:hover {
  border-color: var(--border-strong);
  box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04);
}
.card-head { display: flex; align-items: center; gap: 10px; }
.card-head h2 {
  font-size: 14px; font-weight: 600; margin: 0; flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.path {
  font-family: ui-monospace, monospace; font-size: 11px; color: var(--text3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.stats { display: flex; gap: 22px; }
.stat b { display: block; font-size: 16px; font-weight: 600; }
.stat span { font-size: 11px; color: var(--text3); }
.meter { display: flex; height: 6px; border-radius: 3px; overflow: hidden; gap: 2px; }
.meter i { display: block; height: 100%; border-radius: 1px; }
.meter-legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--text3); }
.meter-legend .k { color: var(--text2); font-weight: 500; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  border: 1px solid var(--border); background: var(--surface2); border-radius: 999px;
  padding: 1px 9px; font-size: 11px; color: var(--text2); max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chip b { font-weight: 600; color: var(--text); }
.card .foot { display: flex; align-items: center; gap: 10px; margin-top: 2px; }
.built { font-size: 11px; color: var(--text3); flex: 1; }
.nograph { color: var(--text3); font-size: 12px; font-style: italic; }
.empty { text-align: center; color: var(--text3); padding: 60px 20px; }
.empty svg { width: 34px; height: 34px; color: var(--border-strong); display: block; margin: 0 auto 12px; }

/* ── graph view ── */
.gview { height: 100%; display: flex; flex-direction: column; }
.gbar {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border-bottom: 1px solid var(--border); background: var(--surface); flex: none;
  flex-wrap: wrap;
}
.gtitle { min-width: 0; }
.gtitle b { font-size: 13.5px; }
.gstats { color: var(--text3); font-size: 12px; margin-left: 8px; }
.gbar .spacer { flex: 1; }
.capnote {
  padding: 6px 14px; font-size: 12px; color: var(--warn-text);
  background: var(--warn-bg); border-bottom: 1px solid var(--warn-border); flex: none;
}
.gmain { position: relative; flex: 1; min-height: 0; overflow: hidden; }
.gmain canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
.gloading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--text3); }

.legend {
  position: absolute; left: 12px; bottom: 12px; z-index: 5;
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04);
  padding: 10px 12px; max-width: 250px; max-height: calc(100% - 24px); overflow: auto;
  display: flex; flex-direction: column; gap: 3px; font-size: 12px;
}
.legend h3 {
  font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--text3); margin: 0 0 3px;
}
.legend h3 + .lrow, .legend .sep { margin-top: 2px; }
.legend .sep { border-top: 1px solid var(--border); margin: 7px 0 5px; }
.lrow {
  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
  background: none; border: none; border-radius: 5px; padding: 2px 5px; color: var(--text2);
  font-size: 12px;
}
.lrow:hover { background: var(--surface-hover); }
.lrow[aria-pressed="true"] { background: var(--accent-subtle); color: var(--text); }
.lrow .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.lrow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow .n { color: var(--text3); font-size: 11px; font-variant-numeric: tabular-nums; }
.lrow svg.sample { width: 26px; height: 8px; flex: none; }
.lrow.off { color: var(--text3); }
.lrow.off .name { text-decoration: line-through; }

.search { position: relative; width: 250px; }
.search input { width: 100%; padding-left: 28px; }
.search svg.icon {
  position: absolute; left: 8px; top: 50%; transform: translateY(-50%);
  width: 13px; height: 13px; color: var(--text3); pointer-events: none;
}
.smenu {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 10px 25px rgba(0,0,0,0.08), 0 4px 10px rgba(0,0,0,0.04);
  overflow: hidden; max-height: 320px; overflow-y: auto;
}
.sopt { display: block; width: 100%; text-align: left; background: none; border: none; border-radius: 0; padding: 6px 10px; }
.sopt:hover, .sopt.hi { background: var(--surface-hover); }
.sopt .sub { color: var(--text3); font-size: 11px; display: flex; align-items: center; gap: 5px; }
.sopt .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; }
.sopt .lab { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }

.drawer {
  position: absolute; top: 0; right: 0; bottom: 0; width: 320px; max-width: 85%;
  z-index: 6; background: var(--surface); border-left: 1px solid var(--border);
  box-shadow: 0 10px 25px rgba(0,0,0,0.08), 0 4px 10px rgba(0,0,0,0.04);
  overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px;
}
.drawer .dhead { display: flex; align-items: flex-start; gap: 8px; }
.drawer h2 { font-size: 14px; font-weight: 600; margin: 0; flex: 1; word-break: break-word; }
.drawer .kv { display: grid; grid-template-columns: 86px 1fr; gap: 5px 10px; font-size: 12px; margin: 0; }
.drawer .kv dt { color: var(--text3); }
.drawer .kv dd { margin: 0; word-break: break-word; }
.drawer .kv dd.mono { font-size: 11px; }
.drawer h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text3); margin: 4px 0 0; }
.nrows { display: flex; flex-direction: column; }
.nrow {
  display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
  background: none; border: none; border-radius: 5px; padding: 5px 6px; font-size: 12px;
}
.nrow:hover { background: var(--surface-hover); }
.nrow .nl { flex: 1; min-width: 0; word-break: break-word; color: var(--text); }
.nrow .rel { color: var(--text3); font-size: 11px; white-space: nowrap; }
.nrow svg.sample { width: 18px; height: 6px; flex: none; align-self: center; }
.drawer .more { color: var(--text3); font-size: 11px; padding: 4px 6px; }
.drawer .note { color: var(--text3); font-size: 11px; }

.tooltip {
  position: absolute; z-index: 10; pointer-events: none; max-width: 340px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
  box-shadow: 0 4px 6px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04);
  padding: 4px 9px; font-size: 12px;
}
.tooltip .sub { color: var(--text3); font-size: 11px; }

@media (max-width: 760px) {
  .wrap { padding: 12px; }
  .search { width: 100%; order: 9; }
  .legend { max-width: 200px; }
}
`;
