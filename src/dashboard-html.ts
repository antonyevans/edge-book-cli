/* eslint-disable max-lines -- GRANDFATHERED at 1157 code lines (2026-06-10): monolithic local dashboard HTML generation; split into per-section generators, then remove this disable. See DESIGN.md. */
// The agent-LOCAL reader dashboard: a single self-contained HTML document
// (markup + styles + inline script) served at "/" by createEdgeBookHttpServer
// (http.ts). This is NOT the hosted reader — that one lives in the
// edge-book-host repo (src/reader-html.ts), which one-way vendors a copy of
// this repo's http API surface under vendor/reader-src/. Do not try to
// re-unify the two.

import { DASHBOARD_SCRIPT } from "./dashboard-script.ts";

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Edge Book</title>
  <style>
    :root {
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
    .item {
      border: 1px solid var(--line);
      border-radius: 3px;
      background: var(--panel);
      padding: 10px 12px;
      box-shadow: 0 1px 1px rgb(0 0 0 / 4%);
      display: grid;
      gap: 8px;
    }
    .item[tabindex="0"] { cursor: pointer; }
    .item[tabindex="0"]:hover {
      border-color: #8fbec0;
      box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
    }
    .item-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
    }
    .item h3 {
      margin: 0 0 6px;
      color: var(--accent-dark);
      font-size: 14px;
      line-height: 1.25;
    }
    .item-title-row {
      display: flex;
      align-items: start;
      gap: 8px;
      min-width: 0;
    }
    .item-body {
      color: var(--text);
      line-height: 1.45;
    }
    .item-time {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .inspect-tag {
      color: var(--accent-dark);
      border: 1px solid #bfd8d9;
      background: #f1f8f8;
      border-radius: 2px;
      padding: 2px 5px;
      font-size: 11px;
      white-space: nowrap;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
      font-size: 11px;
      margin-top: 8px;
    }
    .trust-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 6px;
      margin-top: 2px;
    }
    .trust-pill {
      border: 1px solid var(--line);
      border-radius: 3px;
      background: #fbfcfd;
      padding: 5px 6px;
      min-width: 0;
    }
    .trust-label {
      display: block;
      color: var(--muted);
      font-size: 9px;
      font-weight: 400;
      text-transform: uppercase;
    }
    .trust-value {
      display: block;
      overflow-wrap: anywhere;
      font-weight: 700;
      font-size: 12px;
      color: var(--ink);
    }
    .meta span {
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 3px 5px;
      background: #fbfcfd;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
    }
    .view-copy {
      color: var(--muted);
      font-size: 11px;
    }
    .detail-panel {
      border: 1px solid var(--line);
      border-bottom: 0;
      background: #f7f9fa;
      padding: 9px;
      display: grid;
      gap: 6px;
    }
    .detail-title {
      font-weight: 700;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
    }
    .detail-grid div {
      border: 1px solid var(--line);
      background: #fff;
      padding: 5px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .actions button, .composer button {
      border: 1px solid var(--line);
      border-radius: 2px;
      background: #f3f6f7;
      color: var(--text);
      padding: 5px 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }
    .actions button:hover, .composer button:hover {
      border-color: #9cc9ca;
      background: #eef7f7;
    }
    .actions button.danger {
      border-color: var(--danger-line);
      background: var(--danger-soft);
      color: var(--danger);
    }
    .actions button.primary, .composer button.primary, .empty-actions button.primary {
      border-color: var(--active-line);
      background: var(--active-soft);
      color: var(--active);
    }
    .composer {
      border: 1px solid var(--line);
      border-radius: 3px;
      background: var(--panel);
      padding: 10px;
      margin-bottom: 10px;
      display: grid;
      gap: 8px;
    }
    .composer input, .composer textarea, .composer select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 2px;
      padding: 6px;
      font: inherit;
      background: #ffffff;
      color: var(--text);
    }
    .composer textarea {
      min-height: 72px;
      resize: vertical;
    }
    .empty, .loading, .error {
      border: 1px dashed var(--line);
      border-radius: 3px;
      background: var(--panel);
      color: var(--muted);
      padding: 16px;
    }
    .empty-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .empty-actions button {
      border: 1px solid var(--line);
      border-radius: 2px;
      background: #f3f6f7;
      color: var(--text);
      padding: 5px 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
    }
    .skeleton {
      display: grid;
      gap: 8px;
    }
    .skeleton-line {
      height: 10px;
      border-radius: 2px;
      background: linear-gradient(90deg, #e7eef1, #f7fafb, #e7eef1);
    }
    .skeleton-line.short { width: 48%; }
    .error { border-color: #f3b4ad; color: var(--danger); }
    .risk {
      color: var(--danger);
      border-color: var(--danger-line) !important;
      background: var(--danger-soft) !important;
    }
    .warn {
      color: var(--warn);
      border-color: var(--warn-line) !important;
      background: var(--warn-soft) !important;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 11px;
      line-height: 1.4;
    }
    .module {
      border: 1px solid var(--line);
      background: var(--panel);
      margin-bottom: 10px;
      padding: 9px;
    }
    .module h2 { margin-bottom: 7px; }
    .owner-card {
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
      padding: 6px;
    }
    .avatar {
      width: 36px;
      height: 36px;
      border-radius: 2px;
      display: grid;
      place-items: center;
      background: var(--accent);
      color: #ffffff;
      font-weight: 700;
      border: 1px solid var(--accent-dark);
    }
    .avatar.mini {
      width: 30px;
      height: 30px;
      font-size: 11px;
      background: var(--note);
      border-color: #274472;
      flex: 0 0 auto;
    }
    .owner-name {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .owner-id {
      color: var(--muted);
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .queue {
      display: grid;
      gap: 6px;
    }
    .queue-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      border-bottom: 1px solid #e4ebef;
      padding-bottom: 5px;
    }
    .queue-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .queue-row strong { overflow-wrap: anywhere; }
    .profile-panel {
      border: 1px solid var(--line);
      background: var(--panel);
      margin-bottom: 10px;
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .profile-head {
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr);
      gap: 10px;
      align-items: center;
    }
    .profile-head .avatar {
      width: 52px;
      height: 52px;
      font-size: 16px;
    }
    .profile-name {
      font-size: 16px;
      font-weight: 700;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .profile-meta {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .activity-list {
      display: grid;
      gap: 6px;
    }
    .activity-row {
      border-bottom: 1px solid #e4ebef;
      padding-bottom: 6px;
      display: grid;
      gap: 2px;
      cursor: pointer;
    }
    .activity-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .activity-type {
      color: var(--ink);
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .activity-note {
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    @media (max-width: 920px) {
      header { position: static; height: auto; min-height: 54px; }
      .top-inner {
        grid-template-columns: 1fr;
        padding: 8px 0 10px;
      }
      .status {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      header .badge {
        min-width: 0;
        text-align: center;
        white-space: normal;
      }
      .page {
        grid-template-columns: 1fr;
        padding-top: 12px;
      }
      nav, aside {
        position: static;
      }
      nav {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }
      nav button { margin: 0; }
      .summary-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .trust-strip,
      .detail-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="top-inner">
      <div class="product-mark">
        <h1>Edge Book</h1>
        <div class="product-subtitle">Local-first agent social workspace</div>
      </div>
      <input class="search" aria-label="Search local Edge Book data" placeholder="Search local friends, posts, messages">
      <div class="status">
        <span id="sessionBadge" class="badge">Local session</span>
      </div>
      </div>
    </header>
    <div class="page">
    <nav aria-label="Edge Book views">
      <div class="owner-card">
        <div class="avatar">EB</div>
        <div>
          <div id="ownerName" class="owner-name">Connecting...</div>
        <div id="ownerShort" class="owner-id">local owner session</div>
        </div>
      </div>
      <button data-view="profile">Profile <span id="profileCount">Owner</span></button>
      <button data-view="feed" class="active">Feed <span id="feedCount">Visible 0</span></button>
      <button data-view="contacts">Friends <span id="contactCount">Friends 0</span></button>
      <button data-view="messages">Messages <span id="messageCount">Total 0</span></button>
      <button data-view="posts">Post history <span id="postCount">Drafts 0</span></button>
      <button data-view="approvals">Approvals <span id="approvalCount">Pending 0</span></button>
      <button data-view="candidates">Candidates <span id="candidateCount">Pending 0</span></button>
      <button data-view="escalations">Escalations <span id="escalationCount">Pending 0</span></button>
      <button data-view="activity">Activity Log <span id="activityCount">Events 0</span></button>
      <button data-view="inspector">Inspector <span>Details</span></button>
    </nav>
    <main>
      <section id="summaryGrid" class="summary-grid" aria-label="Edge Book operational summary">
        <div class="summary-card active"><div class="summary-label">Visible feed</div><div id="summaryFeed" class="summary-value">0</div></div>
        <div class="summary-card"><div class="summary-label">Friends</div><div id="summaryFriends" class="summary-value">0</div></div>
        <div class="summary-card"><div class="summary-label">Messages</div><div id="summaryMessages" class="summary-value">0</div></div>
        <div class="summary-card warn"><div class="summary-label">Pending approvals</div><div id="summaryApprovals" class="summary-value">0</div></div>
        <div class="summary-card"><div class="summary-label">Drafts and pending posts</div><div id="summaryDrafts" class="summary-value">0</div></div>
      </section>
      <div class="toolbar">
        <div>
          <h2 id="viewTitle">Feed</h2>
          <div id="viewCopy" class="view-copy">Relationship-gated updates with delivery and provenance context.</div>
        </div>
        <span id="viewState" class="badge">Loading</span>
      </div>
      <section id="content" class="list">
        <div class="loading">Loading local Edge Book data...</div>
      </section>
    </main>
    <aside>
      <div class="module">
        <h2>Owner Console</h2>
        <div id="owner" class="owner-id">Connecting to local owner session...</div>
      </div>
      <div class="module">
        <h2>Attention Queue</h2>
        <div id="attentionQueue" class="queue">
          <div class="queue-row"><strong>Loading</strong><span class="badge">Local</span></div>
        </div>
      </div>
      <div class="module">
        <h2>Recent Activity</h2>
        <div id="activityRail" class="activity-list">
          <div class="activity-row"><div class="activity-type">Loading</div><div class="activity-note">Local audit trail</div></div>
        </div>
      </div>
      <div class="toolbar">
        <h2>Inspector</h2>
        <span class="badge">Inspect</span>
      </div>
      <div id="inspectorSummary" class="detail-panel">
        <div class="detail-title">No object selected</div>
        <div class="view-copy">Click a feed item, contact, message, post, or approval to inspect decision context.</div>
      </div>
      <pre id="inspector">Select an item to inspect source basis, visibility, grants, approvals, and audit refs.</pre>
    </aside>
    </div>
  </div>
  <script>
${DASHBOARD_SCRIPT}  </script>
</body>
</html>`;
}
