// Base styles of the agent-LOCAL reader dashboard (split from
// dashboard-html.ts): CSS variables, page shell, layout grid, header, rails,
// and summary cards. Concatenated verbatim into the <style> tag of
// dashboardHtml() — keep this a plain static template string.
export const DASHBOARD_STYLES_BASE = `    :root {
      color-scheme: light;
      --bg: #eef2f4;
      --panel: #ffffff;
      --line: #c7d1d6;
      --text: #1d2a31;
      --muted: #5f7079;
      --accent: #116466;
      --accent-dark: #0a4244;
      --accent-soft: #dcefee;
      --active: #1f7a4f;
      --active-soft: #e5f5ec;
      --active-line: #a8d5bd;
      --note: #345995;
      --note-soft: #e8eef9;
      --ink: #12343b;
      --warn: #9a3412;
      --warn-soft: #fff7ed;
      --warn-line: #fed7aa;
      --danger: #b42318;
      --danger-soft: #fff7f6;
      --danger-line: #f0b5ae;
      --neutral-soft: #f4f7f8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "Lucida Grande", Tahoma, Verdana, Arial, sans-serif;
      font-size: 12px;
      letter-spacing: 0;
    }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto 1fr;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 16px;
      border-bottom: 1px solid #07383a;
      background: linear-gradient(#14797b, #0d5557);
      color: #ffffff;
      box-shadow: 0 1px 2px rgb(0 0 0 / 18%);
    }
    .top-inner {
      width: min(1220px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: 220px minmax(240px, 1fr) auto;
      gap: 12px;
      align-items: center;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0;
      text-shadow: 0 -1px 0 rgb(0 0 0 / 25%);
    }
    .product-mark {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .product-subtitle {
      color: #d8f1ef;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    h2 {
      margin: 0;
      font-size: 13px;
      font-weight: 700;
    }
    h3 { font-size: 14px; }
    .search {
      width: 100%;
      height: 25px;
      border: 1px solid #07383a;
      border-radius: 2px;
      padding: 4px 8px;
      font: inherit;
      background: #f7fbfb;
      color: var(--text);
      box-shadow: inset 0 1px 1px rgb(0 0 0 / 12%);
    }
    .status {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      color: #eef8f8;
      min-width: 0;
    }
    .badge {
      border: 1px solid var(--line);
      border-radius: 3px;
      padding: 4px 7px;
      background: #f9fafb;
      color: var(--muted);
      white-space: nowrap;
    }
    .badge.owned {
      border-color: var(--active-line);
      background: var(--active-soft);
      color: var(--active);
    }
    .badge.attention {
      border-color: var(--warn-line);
      background: var(--warn-soft);
      color: var(--warn);
    }
    .badge.risk {
      border-color: var(--danger-line);
      background: var(--danger-soft);
      color: var(--danger);
    }
    .badge.neutral {
      border-color: var(--line);
      background: var(--neutral-soft);
      color: var(--muted);
    }
    header .badge {
      border-color: #0a4244;
      background: rgb(255 255 255 / 14%);
      color: #ffffff;
    }
    .page {
      width: min(1220px, 100%);
      margin: 0 auto;
      display: grid;
      grid-template-columns: 170px minmax(520px, 1fr) 250px;
      gap: 12px;
      padding: 14px 12px 28px;
    }
    nav, aside {
      align-self: start;
      position: sticky;
      top: 56px;
    }
    nav {
      padding: 0;
    }
    nav button {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2px;
      border: 1px solid transparent;
      border-radius: 2px;
      background: transparent;
      color: var(--text);
      padding: 5px 6px;
      text-align: left;
      cursor: pointer;
      font-weight: 700;
    }
    nav button span { color: var(--muted); font-weight: 400; }
    nav button:hover { background: #e2ebef; }
    nav button.active {
      border-color: #b7c5cc;
      background: #dbe7eb;
      color: var(--accent-dark);
    }
    main {
      min-width: 0;
    }
    aside {
      background: #f8fafb;
      border: 1px solid var(--line);
      padding: 10px;
      min-width: 0;
      color: #40535c;
    }
    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid var(--line);
      border-bottom: 0;
      background: #f7f9fa;
      padding: 7px 9px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .summary-card {
      min-height: 62px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--panel);
      padding: 8px;
      display: grid;
      align-content: space-between;
      gap: 5px;
    }
    .summary-label {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .summary-value {
      font-size: 19px;
      font-weight: 700;
      color: var(--ink);
    }
    .summary-card.warn { background: var(--warn-soft) !important; }
    .summary-card.risk { background: var(--danger-soft) !important; }
    .summary-card.active { background: var(--active-soft); border-color: #b5ddc9; }
    .list {
      display: grid;
      gap: 10px;
    }
`;
