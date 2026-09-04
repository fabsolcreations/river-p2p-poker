/**
 * Panel stylesheet. Lives inside the shadow root, so nothing here can reach the
 * host page and nothing on the host page can reach us.
 *
 * Two deliberate choices:
 *
 * 1. `:host { all: initial }` first, so the panel does not inherit the site's
 *    font, colour, line-height or direction. The declarations after it re-assert
 *    the handful of properties the panel actually needs, with `!important`,
 *    because in the shadow cascade an important declaration from the inner tree
 *    beats a normal declaration from the outer one - that is the only way to
 *    survive a page rule like `div { display: none !important }`.
 *
 * 2. No `transform`, `filter`, `contain` or `will-change` on `:host` or
 *    `.bs-root`. Any of those would make the host a containing block for its
 *    fixed-position descendants, and the panel would start scrolling with the
 *    page instead of staying put.
 *
 * Colours are the Duel tokens listed in CONTRACT.md. The one addition is
 * `--bs-fg`: Duel's token list stops at dark-100 (#a4aac6), which is too dim for
 * primary text on dark-800, so the panel lightens it for body copy and keeps
 * dark-100 for secondary text.
 */

export const PANEL_CSS = `
:host {
  all: initial;
  display: block !important;
  position: fixed !important;
  inset: 0 auto auto 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  /* One below the max so a site's own "always on top" layer can still win if it
     has to; nothing we render is worth trapping the user behind. */
  z-index: 2147483646 !important;
  /* The host itself is a 0x0 anchor - it must never eat a click meant for the
     page underneath. .bs-root turns pointer events back on for itself. */
  pointer-events: none !important;
  color-scheme: dark;
}

:host {
  --bs-dark-900: #070b23;
  --bs-dark-800: #0c102b;
  --bs-dark-700: #121731;
  --bs-dark-600: #181e3c;
  --bs-dark-500: #1f2546;
  --bs-dark-400: #343c64;
  --bs-dark-300: #47507c;
  --bs-dark-200: #767faa;
  --bs-dark-100: #a4aac6;
  --bs-fg: #e4e8fa;
  --bs-blue-500: #5e6eff;
  --bs-blue-600: #4558ff;
  --bs-blue-700: #2133dc;
  --bs-green-500: #6de8bf;
  --bs-green-600: #20d095;
  --bs-green-700: #19a375;
  --bs-red-500: #e8305e;
  --bs-red-600: #cf1745;
  --bs-red-700: #a11236;
  --bs-yellow-500: #ff9900;
  --bs-yellow-600: #db8504;
  --bs-purple-500: #8a70e2;
  --bs-purple-600: #765dc5;
  --bs-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --bs-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

.bs-root {
  position: fixed;
  pointer-events: auto;
  font-family: var(--bs-sans);
  font-size: 12px;
  line-height: 1.35;
  color: var(--bs-fg);
  -webkit-font-smoothing: antialiased;
}

/* ---------------------------------------------------------------- shell -- */

.bs-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  position: relative;
  background: var(--bs-dark-800);
  border: 1px solid var(--bs-dark-500);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

.bs-titlebar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 6px 0 10px;
  background: var(--bs-dark-700);
  border-bottom: 1px solid var(--bs-dark-600);
  cursor: grab;
  user-select: none;
  flex: 0 0 auto;
}
.bs-titlebar.bs-dragging { cursor: grabbing; }

.bs-brand {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  color: var(--bs-fg);
  white-space: nowrap;
}
.bs-ver {
  font-family: var(--bs-mono);
  font-size: 10px;
  color: var(--bs-dark-200);
}
.bs-counter {
  font-family: var(--bs-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--bs-dark-100);
  white-space: nowrap;
}
.bs-counter b { color: var(--bs-fg); font-weight: 600; }
.bs-counter .bs-drop { color: var(--bs-yellow-500); }
.bs-spacer { flex: 1 1 auto; min-width: 4px; }

.bs-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--bs-dark-400);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.04);
}
.bs-dot.ok  { background: var(--bs-green-600); }
.bs-dot.warn{ background: var(--bs-yellow-500); }
.bs-dot.bad { background: var(--bs-red-600); }
.bs-dot.off { background: var(--bs-dark-400); }
.bs-dotlabel {
  font-family: var(--bs-mono);
  font-size: 10px;
  color: var(--bs-dark-200);
  white-space: nowrap;
}

/* --------------------------------------------------------------- buttons -- */

.bs-btn {
  font-family: var(--bs-sans);
  font-size: 11px;
  line-height: 1;
  color: var(--bs-dark-100);
  background: var(--bs-dark-600);
  border: 1px solid var(--bs-dark-500);
  border-radius: 8px;
  padding: 5px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.bs-btn:hover { background: var(--bs-dark-500); color: var(--bs-fg); }
.bs-btn:active { background: var(--bs-dark-400); }
.bs-btn.on {
  background: var(--bs-blue-700);
  border-color: var(--bs-blue-600);
  color: #fff;
}
.bs-btn.warnstate {
  background: var(--bs-yellow-600);
  border-color: var(--bs-yellow-500);
  color: var(--bs-dark-900);
}
.bs-btn.icon { padding: 5px 7px; font-family: var(--bs-mono); }

/* ------------------------------------------------------------------ body -- */

.bs-body { display: flex; flex: 1 1 auto; min-height: 0; }

.bs-left {
  display: flex;
  flex-direction: column;
  min-width: 240px;
  flex: 0 0 auto;
  border-right: 1px solid var(--bs-dark-600);
  min-height: 0;
}

.bs-split {
  flex: 0 0 5px;
  cursor: col-resize;
  background: transparent;
}
.bs-split:hover { background: var(--bs-blue-700); }

.bs-right {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.bs-toolrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--bs-dark-600);
  flex: 0 0 auto;
}

.bs-input {
  font-family: var(--bs-sans);
  font-size: 11px;
  color: var(--bs-fg);
  background: var(--bs-dark-900);
  border: 1px solid var(--bs-dark-500);
  border-radius: 8px;
  padding: 5px 7px;
  min-width: 0;
  width: 100%;
}
.bs-input:focus { outline: none; border-color: var(--bs-blue-600); }
.bs-input.mono { font-family: var(--bs-mono); font-variant-numeric: tabular-nums; }
.bs-input.bad { border-color: var(--bs-red-600); }

.bs-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px;
  border-bottom: 1px solid var(--bs-dark-600);
  max-height: 88px;
  overflow: auto;
  flex: 0 0 auto;
}
.bs-kchip {
  font-family: var(--bs-mono);
  font-size: 10px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid var(--bs-dark-500);
  background: var(--bs-dark-700);
  color: var(--bs-dark-100);
  cursor: pointer;
  white-space: nowrap;
}
.bs-kchip:hover { border-color: var(--bs-dark-300); color: var(--bs-fg); }
.bs-kchip.on { background: var(--bs-blue-700); border-color: var(--bs-blue-500); color: #fff; }
.bs-kchip .n { font-variant-numeric: tabular-nums; color: var(--bs-dark-200); }
.bs-kchip.on .n { color: #dfe3ff; }

/* --------------------------------------------------------- capture list -- */

.bs-list { flex: 1 1 auto; overflow: auto; min-height: 0; }

.bs-row {
  display: grid;
  grid-template-columns: 54px 30px 34px 30px minmax(0, 1fr) 52px 70px;
  gap: 5px;
  align-items: center;
  padding: 4px 6px;
  border-bottom: 1px solid rgba(24, 30, 60, 0.7);
  cursor: pointer;
  font-family: var(--bs-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--bs-dark-100);
}
.bs-row:hover { background: var(--bs-dark-700); }
.bs-row.sel { background: var(--bs-dark-600); box-shadow: inset 2px 0 0 var(--bs-blue-500); }
.bs-row .t { color: var(--bs-dark-200); }
.bs-row .m { color: var(--bs-fg); }
.bs-row .sz { text-align: right; color: var(--bs-dark-200); }
.bs-row .st { text-align: right; }
.bs-row .st.ok2 { color: var(--bs-green-500); }
.bs-row .st.warn4 { color: var(--bs-yellow-500); }
.bs-row .st.bad5 { color: var(--bs-red-500); }
.bs-loc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.bs-loc .h { color: var(--bs-dark-200); }
.bs-loc .p { color: var(--bs-fg); }

.bs-tr {
  font-size: 9px;
  text-align: center;
  border-radius: 4px;
  padding: 2px 0;
  background: var(--bs-dark-600);
  color: var(--bs-dark-100);
  text-transform: uppercase;
}
.bs-tr.ws { background: var(--bs-purple-600); color: #fff; }
.bs-tr.sse { background: var(--bs-blue-700); color: #fff; }
.bs-tr.dom { background: var(--bs-dark-500); }

.bs-chip {
  font-size: 9px;
  line-height: 1;
  padding: 3px 4px;
  border-radius: 4px;
  text-align: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border: 1px solid transparent;
}
/* Solid = confident. Outlined + "?" = a guess. Never let the two look alike. */
.bs-chip.guess { background: transparent !important; color: var(--bs-dark-100) !important; border-color: var(--bs-dark-400); }
.bs-chip.k-bets_feed    { background: var(--bs-green-700); color: #eafff7; }
.bs-chip.k-user_bets    { background: var(--bs-green-600); color: #04231a; }
.bs-chip.k-event_list   { background: var(--bs-blue-700); color: #eef0ff; }
.bs-chip.k-event_detail { background: var(--bs-blue-600); color: #eef0ff; }
.bs-chip.k-market_list  { background: var(--bs-blue-500); color: #0a0f2b; }
.bs-chip.k-odds_update  { background: var(--bs-purple-600); color: #f3efff; }
.bs-chip.k-betslip      { background: var(--bs-yellow-600); color: #241500; }
.bs-chip.k-sport_tree   { background: var(--bs-dark-400); color: var(--bs-fg); }
.bs-chip.k-translation  { background: var(--bs-dark-500); color: var(--bs-dark-100); }
.bs-chip.k-config       { background: var(--bs-dark-500); color: var(--bs-dark-100); }
.bs-chip.k-auth         { background: var(--bs-red-700); color: #ffe9ef; }
.bs-chip.k-telemetry    { background: var(--bs-dark-600); color: var(--bs-dark-200); }
.bs-chip.k-asset        { background: var(--bs-dark-700); color: var(--bs-dark-300); }
.bs-chip.k-unknown      { background: transparent; color: var(--bs-dark-200); border-color: var(--bs-dark-500); }

.bs-empty {
  padding: 14px 12px;
  color: var(--bs-dark-200);
  font-size: 11px;
  line-height: 1.5;
}

/* ------------------------------------------------------------------ tabs -- */

.bs-tabs {
  display: flex;
  gap: 2px;
  padding: 5px 6px 0;
  border-bottom: 1px solid var(--bs-dark-600);
  overflow-x: auto;
  flex: 0 0 auto;
}
.bs-tab {
  font-family: var(--bs-sans);
  font-size: 11px;
  color: var(--bs-dark-200);
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  padding: 5px 9px;
  cursor: pointer;
  white-space: nowrap;
}
.bs-tab:hover { color: var(--bs-fg); }
.bs-tab.on {
  color: var(--bs-fg);
  background: var(--bs-dark-700);
  border-color: var(--bs-dark-600);
}
.bs-tab .badge {
  font-family: var(--bs-mono);
  font-variant-numeric: tabular-nums;
  font-size: 9px;
  margin-left: 5px;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--bs-dark-600);
  color: var(--bs-dark-100);
}
.bs-tab .badge.alert { background: var(--bs-yellow-600); color: var(--bs-dark-900); }
.bs-tab .badge.info { background: var(--bs-blue-700); color: #fff; }

.bs-tabbody {
  flex: 1 1 auto;
  overflow: auto;
  padding: 8px 10px 14px;
  min-height: 0;
}

/* ------------------------------------------------------------ detail kit -- */

.bs-h {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--bs-dark-200);
  margin: 10px 0 5px;
}
.bs-h:first-child { margin-top: 0; }

.bs-kv { display: grid; grid-template-columns: 116px minmax(0, 1fr); gap: 2px 10px; }
.bs-kv dt {
  font-size: 10px;
  color: var(--bs-dark-200);
  padding: 2px 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.bs-kv dd {
  margin: 0;
  padding: 2px 0;
  font-family: var(--bs-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--bs-fg);
  overflow-wrap: anywhere;
}
.bs-kv dd.dim { color: var(--bs-dark-200); }

.bs-note {
  border-left: 2px solid var(--bs-dark-400);
  padding: 6px 10px;
  margin: 6px 0;
  color: var(--bs-dark-100);
  font-size: 11px;
  line-height: 1.5;
  background: var(--bs-dark-700);
  border-radius: 0 8px 8px 0;
}
.bs-note.warn { border-left-color: var(--bs-yellow-500); }
.bs-note.bad { border-left-color: var(--bs-red-500); }

.bs-reasons { margin: 0; padding-left: 16px; }
.bs-reasons li { margin: 2px 0; color: var(--bs-dark-100); font-size: 11px; line-height: 1.45; }

.bs-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--bs-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.bs-table th {
  text-align: left;
  font-weight: 600;
  color: var(--bs-dark-200);
  border-bottom: 1px solid var(--bs-dark-500);
  padding: 4px 6px;
  white-space: nowrap;
  position: sticky;
  top: 0;
  background: var(--bs-dark-800);
}
.bs-table td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--bs-dark-700);
  color: var(--bs-fg);
  vertical-align: top;
  overflow-wrap: anywhere;
}
.bs-table td.num { text-align: right; }
.bs-table td.null { color: var(--bs-dark-300); }
.bs-table tr.leg td { background: var(--bs-dark-900); color: var(--bs-dark-100); }
.bs-scrollx { overflow-x: auto; }

.bs-fields { font-family: var(--bs-mono); font-size: 10px; }
.bs-fields div {
  padding: 2px 6px;
  border-bottom: 1px solid var(--bs-dark-700);
  color: var(--bs-fg);
  overflow-wrap: anywhere;
}
.bs-fields div:nth-child(even) { background: rgba(18, 23, 49, 0.6); }

/* ------------------------------------------------------------ json tree -- */

.bs-json { font-family: var(--bs-mono); font-size: 11px; line-height: 1.45; }
.bs-jnode { padding-left: 12px; border-left: 1px solid rgba(52, 60, 100, 0.35); }
.bs-jnode.root { padding-left: 0; border-left: none; }
.bs-jrow { display: flex; align-items: baseline; gap: 5px; flex-wrap: wrap; }
.bs-twisty {
  font-family: var(--bs-mono);
  font-size: 9px;
  width: 14px;
  color: var(--bs-dark-200);
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
.bs-twisty:hover { color: var(--bs-fg); }
.bs-jkey { color: var(--bs-blue-500); }
.bs-jmeta { color: var(--bs-dark-300); }
.bs-jstr { color: var(--bs-green-500); overflow-wrap: anywhere; }
.bs-jnum { color: var(--bs-yellow-500); }
.bs-jbool { color: var(--bs-purple-500); }
.bs-jnull { color: var(--bs-dark-300); }
.bs-raw {
  font-family: var(--bs-mono);
  font-size: 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--bs-fg);
  background: var(--bs-dark-900);
  border: 1px solid var(--bs-dark-600);
  border-radius: 8px;
  padding: 8px;
  margin: 0;
  max-height: 60vh;
  overflow: auto;
}

/* -------------------------------------------------------------- settings -- */

.bs-drawer {
  position: absolute;
  left: 0;
  right: 0;
  top: 34px;
  bottom: 0;
  background: var(--bs-dark-800);
  overflow: auto;
  padding: 10px 12px 16px;
}
.bs-set {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 2px 8px;
  align-items: start;
  padding: 6px 0;
  border-bottom: 1px solid var(--bs-dark-700);
}
.bs-set label { font-size: 11px; color: var(--bs-fg); cursor: pointer; }
.bs-set .hint {
  grid-column: 2;
  font-size: 10px;
  color: var(--bs-dark-200);
  line-height: 1.45;
}
.bs-set .hint.warn { color: var(--bs-yellow-500); }
.bs-set input[type="checkbox"] { accent-color: var(--bs-blue-600); margin: 1px 0 0; }
.bs-setnum { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 4px 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--bs-dark-700); }
.bs-setnum .hint { grid-column: 1 / -1; font-size: 10px; color: var(--bs-dark-200); }
.bs-setnum label { font-size: 11px; color: var(--bs-fg); }

/* ---------------------------------------------------------------- footer -- */

.bs-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  border-top: 1px solid var(--bs-dark-600);
  background: var(--bs-dark-700);
  font-family: var(--bs-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--bs-dark-200);
  flex: 0 0 auto;
}
.bs-footer .msg { color: var(--bs-dark-100); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.bs-footer .msg.bad { color: var(--bs-red-500); }

.bs-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  background:
    linear-gradient(135deg, transparent 50%, var(--bs-dark-400) 50%, var(--bs-dark-400) 62%, transparent 62%,
    transparent 74%, var(--bs-dark-400) 74%, var(--bs-dark-400) 86%, transparent 86%);
}

/* ------------------------------------------------------------------ pill -- */

.bs-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--bs-dark-700);
  border: 1px solid var(--bs-dark-500);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  cursor: grab;
  user-select: none;
  width: max-content;
}
.bs-pill.bs-dragging { cursor: grabbing; }

/* Scrollbars: the page's own scrollbar styling does not cross the shadow
   boundary, so without this the panel gets fat OS bars on a dark surface. */
.bs-list::-webkit-scrollbar,
.bs-tabbody::-webkit-scrollbar,
.bs-drawer::-webkit-scrollbar,
.bs-raw::-webkit-scrollbar,
.bs-chips::-webkit-scrollbar,
.bs-scrollx::-webkit-scrollbar { width: 9px; height: 9px; }
.bs-list::-webkit-scrollbar-thumb,
.bs-tabbody::-webkit-scrollbar-thumb,
.bs-drawer::-webkit-scrollbar-thumb,
.bs-raw::-webkit-scrollbar-thumb,
.bs-chips::-webkit-scrollbar-thumb,
.bs-scrollx::-webkit-scrollbar-thumb { background: var(--bs-dark-500); border-radius: 6px; }
.bs-list::-webkit-scrollbar-track,
.bs-tabbody::-webkit-scrollbar-track,
.bs-drawer::-webkit-scrollbar-track,
.bs-raw::-webkit-scrollbar-track,
.bs-chips::-webkit-scrollbar-track,
.bs-scrollx::-webkit-scrollbar-track { background: transparent; }
`;
