// The agent-LOCAL reader dashboard: a single self-contained HTML document
// (markup + styles + inline script) served at "/" by createEdgeBookHttpServer
// (http.ts). This is NOT the hosted reader — that one lives in the
// edge-book-host repo (src/reader-html.ts), which one-way vendors a copy of
// this repo's http API surface under vendor/reader-src/. Do not try to
// re-unify the two.

import { DASHBOARD_SCRIPT } from "./dashboard-script.ts";
import { DASHBOARD_STYLES_BASE } from "./dashboard-styles-base.ts";
import { DASHBOARD_STYLES_COMPONENTS } from "./dashboard-styles-components.ts";

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Edge Book</title>
  <style>
${DASHBOARD_STYLES_BASE}${DASHBOARD_STYLES_COMPONENTS}  </style>
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
