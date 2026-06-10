// Inline script of the agent-LOCAL reader dashboard (split from
// dashboard-html.ts). Concatenated verbatim into the <script> tag of
// dashboardHtml() — the assembled document must stay byte-identical, so keep
// this a plain static template string with no interpolations.
export const DASHBOARD_SCRIPT = `    const state = {
      view: "feed",
      sessionId: "",
      csrf: "",
      me: null,
      contacts: {},
      mutes: {},
      posts: {},
      feedItems: {},
      approvals: {},
      candidates: [],
      escalations: {},
      messages: [],
      audit: []
    };
    const titleByView = {
      profile: "Profile",
      feed: "Feed",
      contacts: "Friends and contacts",
      messages: "Messages",
      posts: "Post history",
      approvals: "Approvals",
      candidates: "Candidates",
      escalations: "Escalations",
      activity: "Activity Log",
      inspector: "Inspector"
    };
    const copyByView = {
      profile: "Owner identity, local session, relationship posture, and working history.",
      feed: "Relationship-gated updates with delivery and provenance context.",
      contacts: "Relationship state, grants, endpoints, and local moderation posture.",
      messages: "Friend-gated envelopes grouped by peer context.",
      posts: "Drafts, approvals, visibility, source basis, and removal state.",
      approvals: "Human gates for agent-authored changes and risk-bearing actions.",
      candidates: "Resolver-discovered first-contact candidates with provenance — approve to send a friend request, or reject to drop.",
      escalations: "Questions your agent — or a collaborating agent — raised for you to answer.",
      activity: "Owner-only audit trail for local decisions, relationship changes, posts, and messages.",
      inspector: "Readable decision summary plus detailed local evidence."
    };
    function headers(extra = {}) {
      return { "content-type": "application/json", "x-openclaw-session": state.sessionId, "x-openclaw-csrf": state.csrf, ...extra };
    }
    async function api(path, init = {}) {
      const response = await fetch(path, { ...init, headers: headers(init.headers || {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.code || body.error || "request_failed");
      return body;
    }
    function values(obj) { return Object.values(obj || {}); }
    function setText(id, text) { document.getElementById(id).textContent = text; }
    function setInspector(value) {
      const summary = summarizePayload(value);
      document.getElementById("inspectorSummary").innerHTML = '<div class="detail-title">' + escapeHtml(summary.title) + '</div><div class="detail-grid">' +
        summary.facts.map((fact) => '<div><span class="trust-label">' + escapeHtml(fact[0]) + '</span><span class="trust-value">' + escapeHtml(fact[1]) + '</span></div>').join("") +
        '</div>';
      setText("inspector", JSON.stringify(value, null, 2));
    }
    function meta(parts) {
      return '<div class="meta">' + parts.filter(Boolean).map((part) => '<span>' + escapeHtml(part) + '</span>').join("") + '</div>';
    }
    function skeleton(label = "Loading local Edge Book data...") {
      return '<div class="loading"><div>' + escapeHtml(label) + '</div><div class="skeleton" aria-hidden="true"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>';
    }
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }
    function action(label, name, id, variant = "") {
      return '<button type="button" class="' + escapeHtml(variant) + '" data-action="' + escapeHtml(name) + '" data-id="' + escapeHtml(id) + '">' + escapeHtml(label) + '</button>';
    }
    function trustStrip(entries) {
      return '<div class="trust-strip">' + entries.map((entry) => '<div class="trust-pill"><span class="trust-label">' + escapeHtml(entry[0]) + '</span><span class="trust-value">' + escapeHtml(entry[1]) + '</span></div>').join("") + '</div>';
    }
    function item(title, body, facts, payload, classes = "", actions = "", trust = [], timestamp = "", avatar = "") {
      const factHtml = facts.filter(Boolean).length ? meta(facts) : "";
      const timeHtml = timestamp ? '<span class="item-time">' + escapeHtml(timestamp) + '</span>' : "";
      const avatarHtml = avatar ? '<span class="avatar mini contact-avatar">' + escapeHtml(avatar) + '</span>' : "";
      return '<article class="item ' + classes + '" tabindex="0" data-payload="' + encodeURIComponent(JSON.stringify(payload)) + '"><div class="item-head"><div class="item-title-row">' + avatarHtml + '<div><h3>' + escapeHtml(title) + '</h3>' + timeHtml + '</div></div><span class="inspect-tag">Inspect</span></div><div class="item-body">' + escapeHtml(body || "") + '</div>' + (trust.length ? trustStrip(trust) : "") + factHtml + (actions ? '<div class="actions">' + actions + '</div>' : '') + '</article>';
    }
    function renderEmpty(label) {
      return '<div class="empty">' + label + '</div>';
    }
    function renderFeedEmpty() {
      return '<div class="empty">Nothing yet.<div class="empty-actions"><button type="button" class="primary" data-view-target="posts">Compose</button><button type="button" data-view-target="contacts">Invite a friend</button></div></div>';
    }
    function shortId(value) {
      const text = String(value || "");
      return text.length > 18 ? text.slice(0, 18) + "..." : text;
    }
    function labelize(value) {
      return String(value || "n/a").replace(/_/g, " ");
    }
    function publicOwnerLabel() {
      return state.me?.display_name || "Local owner";
    }
    function initials(label) {
      const words = String(label || "EB").replace(/[^a-z0-9 ]/gi, " ").trim().split(/\s+/).filter(Boolean);
      const text = (words[0]?.[0] || "E") + (words[1]?.[0] || words[0]?.[1] || "B");
      return text.toUpperCase();
    }
    function contactFor(agentId) {
      return state.contacts[agentId] || {};
    }
    function agentLabel(agentId) {
      if (!agentId) return "Local owner";
      if ((state.me?.did || state.me?.agent_id) === agentId) return publicOwnerLabel();
      const contact = contactFor(agentId);
      return contact.display_name || contact.aliases?.[0] || shortId(agentId);
    }
    function peerEndpointLabel(contact) {
      const endpoints = contact.known_endpoints || [];
      if (!endpoints.length) return "No endpoint published";
      return endpoints.map((endpoint) => labelize(endpoint.mode)).join(", ");
    }
    function timeLabel(value) {
      if (!value) return "n/a";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }
    function pendingApprovals() { return values(state.approvals).filter((approval) => approval.status === "pending"); }
    function pendingEscalations() { return values(state.escalations).filter((escalation) => escalation.status === "pending"); }
    function pendingCandidates() { return (state.candidates || []).filter((c) => !c.approved); }
    function visibleFeedItems() { return values(state.feedItems).filter((feed) => !feed.hidden); }
    function friendContacts() { return values(state.contacts).filter((contact) => contact.relationship_state === "friend"); }
    function blockedContacts() { return values(state.contacts).filter((contact) => contact.relationship_state === "blocked"); }
    function draftPosts() { return values(state.posts).filter((post) => post.status === "draft" || post.status === "pending_approval"); }
    function renderAttentionQueue() {
      const rows = [
        ["Approvals", pendingApprovals().length, pendingApprovals().length ? "attention" : "owned"],
        ["Candidates", pendingCandidates().length, pendingCandidates().length ? "attention" : "neutral"],
        ["Escalations", pendingEscalations().length, pendingEscalations().length ? "attention" : "owned"],
        ["Unread feed", values(state.feedItems).filter((feed) => feed.read_state !== "read" && !feed.hidden).length, "neutral"],
        ["Blocked peers", blockedContacts().length, blockedContacts().length ? "risk" : "owned"],
        ["Draft/pending posts", draftPosts().length, draftPosts().length ? "attention" : "neutral"]
      ];
      document.getElementById("attentionQueue").innerHTML = rows.map((row) => '<div class="queue-row"><strong>' + escapeHtml(row[0]) + '</strong><span class="badge ' + escapeHtml(row[2]) + '">' + escapeHtml(row[1]) + '</span></div>').join("");
    }
    function renderActivityRail() {
      const recent = [...state.audit].reverse().slice(0, 6);
      document.getElementById("activityRail").innerHTML = recent.map((event) => '<div class="activity-row" tabindex="0" data-payload="' + encodeURIComponent(JSON.stringify(event)) + '"><div class="activity-type">' + escapeHtml(labelize(event.type || "event")) + '</div><div class="activity-note">' + escapeHtml(agentLabel(event.peer_agent_id) + " | " + timeLabel(event.created_at)) + '</div></div>').join("") || '<div class="activity-row"><div class="activity-type">No activity yet</div><div class="activity-note">Audit events will appear here.</div></div>';
      document.querySelectorAll("#activityRail [data-payload]").forEach((node) => {
        node.addEventListener("click", () => setInspector(JSON.parse(decodeURIComponent(node.dataset.payload))));
        node.addEventListener("keydown", (event) => { if (event.key === "Enter") node.click(); });
      });
    }
    function summarizePayload(value) {
      const data = value || {};
      const feed = data.feed || data;
      const post = data.post || data;
      const title = post.title || data.summary || data.display_name || labelize(data.type) || agentLabel(data.peer_agent_id) || "Selected object";
      const facts = [
        ["relationship", labelize(data.relationship_state || "local owner")],
        ["visibility", labelize(post.visibility || feed.visibility || "n/a")],
        ["source", labelize(post.source_basis || data.source_basis || data.transport || data.delivery_route || feed.delivery_route || "local")],
        ["approval", labelize(data.status || post.status || data.risk_level || "n/a")],
        ["audit evidence", (data.audit_refs || post.audit_refs || feed.audit_refs || []).length || (data.audit_id ? 1 : 0)]
      ];
      return { title, facts };
    }
    function render() {
      document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
      setText("viewTitle", titleByView[state.view]);
      setText("viewCopy", copyByView[state.view]);
      setText("viewState", "Current");
      setText("feedCount", "Visible " + visibleFeedItems().length);
      setText("contactCount", "Friends " + friendContacts().length);
      setText("postCount", "Drafts " + draftPosts().length);
      setText("approvalCount", "Pending " + pendingApprovals().length);
      setText("candidateCount", "Pending " + pendingCandidates().length);
      setText("escalationCount", "Pending " + pendingEscalations().length);
      setText("activityCount", "Events " + state.audit.length);
      setText("messageCount", "Total " + state.messages.length);
      setText("summaryFeed", visibleFeedItems().length);
      setText("summaryFriends", friendContacts().length);
      setText("summaryMessages", state.messages.length);
      setText("summaryApprovals", pendingApprovals().length);
      setText("summaryDrafts", draftPosts().length);
      renderAttentionQueue();
      renderActivityRail();
      const content = document.getElementById("content");
      let html = "";
      if (state.view === "profile") {
        html = '<section class="profile-panel"><div class="profile-head"><div class="avatar">EB</div><div><div class="profile-name">' + escapeHtml(publicOwnerLabel()) + '</div><div class="profile-meta">Local owner session</div></div></div>' +
          trustStrip([
            ["session", "local active"],
            ["friends", friendContacts().length],
            ["pending approvals", pendingApprovals().length],
            ["activity events", state.audit.length]
          ]) +
          '<div class="view-copy">Endpoint and key material are kept out of the main profile surface; inspect technical evidence only when needed.</div></section>' +
          values(state.posts).slice(0, 6).map((post) => item(post.title, post.body, [
            "status: " + labelize(post.status),
            "visibility: " + labelize(post.visibility),
            "source: " + labelize(post.source_basis),
            "updated: " + timeLabel(post.updated_at)
          ], post, post.status === "removed" ? "risk" : "", "", [
            ["status", labelize(post.status)],
            ["visibility", labelize(post.visibility)],
            ["source", labelize(post.source_basis)],
            ["audit refs", (post.audit_refs || []).length]
          ])).join("");
      }
      if (state.view === "feed") {
        const posts = state.posts;
        html = values(state.feedItems).map((feed) => {
          const post = posts[feed.post_id] || {};
          const actions = [
            feed.read_state === "read" ? "" : action("Mark read", "feed-read", feed.feed_item_id),
            feed.hidden ? "" : action("Hide", "feed-hide", feed.feed_item_id, "danger")
          ].join("");
          return item(post.title || "Untitled feed item", post.body || "No post body loaded for this feed item.", [
            feed.read_state !== "read" ? "unread" : "",
            feed.hidden ? "hidden" : ""
          ], { feed, post }, feed.hidden ? "warn" : "", actions, [
            ["relationship", labelize(contactFor(feed.origin_agent_id).relationship_state || "local")],
            ["visibility", labelize(post.visibility || "unknown")],
            ["source", labelize(post.source_basis || feed.origin_home || "unknown")],
            ["delivery", labelize(feed.delivery_route || "local")]
          ], "Posted " + timeLabel(post.published_at || post.updated_at || feed.received_at));
        }).join("") || renderFeedEmpty();
      }
      if (state.view === "contacts") {
        html = values(state.contacts).map((contact) => item(contact.display_name || "Unnamed contact", contact.aliases?.[0] || contact.card_url || peerEndpointLabel(contact), [
          state.mutes[contact.peer_agent_id] ? "muted" : "active",
        ], contact, contact.relationship_state === "blocked" ? "risk" : "", (state.mutes[contact.peer_agent_id] ? "" : action("Mute", "contact-mute", contact.peer_agent_id)) + action("Report", "contact-report", contact.peer_agent_id, "risk"), [
          ["relationship", labelize(contact.relationship_state)],
          ["grants", (contact.capability_grants || []).length],
          ["endpoint", (contact.known_endpoints || []).length ? "known" : "missing"],
          ["local posture", state.mutes[contact.peer_agent_id] ? "muted" : "active"]
        ], "", initials(contact.display_name || contact.aliases?.[0] || contact.peer_agent_id))).join("") || renderEmpty("No contacts yet.");
      }
      if (state.view === "messages") {
        html = state.messages.map((message) => item(labelize(message.type), message.body?.text || message.body?.note || JSON.stringify(message.body || {}), [
        ], message, "", "", [
          ["direction", message.to_agent_id === (state.me?.did || state.me?.agent_id) ? "inbound" : "outbound"],
          ["transport", labelize(message.transport || "local")],
          ["sender", agentLabel(message.from_agent_id)],
          ["recipient", agentLabel(message.to_agent_id)]
        ], "", initials(agentLabel(message.from_agent_id)))).join("") || renderEmpty("No messages for selected contacts yet.");
      }
      if (state.view === "posts") {
        html = '<form class="composer" data-action="post-create"><input name="title" placeholder="Post title" required><textarea name="body" placeholder="Post body" required></textarea><select name="visibility"><option value="private">private</option><option value="friends">friends</option><option value="public_if_enabled">public_if_enabled</option></select><button type="submit" class="primary">Create draft</button></form>' +
        (values(state.posts).map((post) => {
          const actions = [
            post.status === "pending_approval" ? action("Approve", "post-approve", post.post_id) : "",
            post.status === "removed" ? "" : action("Edit", "post-edit", post.post_id),
            post.status === "removed" ? "" : action("Remove", "post-remove", post.post_id, "danger")
          ].join("");
          return item(post.title, post.body, [
          post.approval_ref ? "approval linked" : ""
        ], post, post.status === "removed" ? "risk" : "", actions, [
          ["status", labelize(post.status)],
          ["visibility", labelize(post.visibility)],
          ["source", labelize(post.source_basis)],
          ["approval", post.approval_ref ? "linked" : "none"]
        ], "Updated " + timeLabel(post.updated_at));
        }).join("") || renderEmpty("No post history yet."));
      }
      if (state.view === "approvals") {
        html = values(state.approvals).map((approval) => {
          const actions = approval.status === "pending"
            ? action("Approve", "approval-approve", approval.approval_id) + action("Reject", "approval-reject", approval.approval_id, "danger")
            : "";
          return item(approval.summary, approval.object_type + " awaiting local owner decision", [], approval, approval.risk_level === "high" ? "risk" : approval.risk_level === "medium" ? "warn" : "", actions, [
          ["risk", labelize(approval.risk_level)],
          ["status", labelize(approval.status)],
          ["type", labelize(approval.type)],
          ["object", labelize(approval.object_type || "unknown")]
        ], "Requested " + timeLabel(approval.created_at));
        }).join("") || renderEmpty("No approval requests.");
      }
      if (state.view === "candidates") {
        html = pendingCandidates().map((candidate) => {
          const actions = action("Approve", "candidate-approve", candidate.candidate_id) + action("Reject", "candidate-reject", candidate.candidate_id, "danger");
          return item(candidate.display_name || "Unknown candidate", candidate.reason, [
            "source: " + labelize(candidate.source),
            "confidence: " + labelize(candidate.confidence),
            candidate.network ? "network: " + candidate.network : "",
            "pending"
          ], candidate, "", actions, [
            ["source", labelize(candidate.source)],
            ["confidence", labelize(candidate.confidence)],
            ["network", candidate.network || "n/a"],
            ["status", candidate.approved ? "approved" : "pending"]
          ], "Discovered " + timeLabel(candidate.created_at));
        }).join("") || renderEmpty("No candidates discovered yet.");
      }
      if (state.view === "escalations") {
        html = values(state.escalations).map((escalation) => {
          const isOption = (escalation.kind === "decision" || escalation.kind === "approval") && (escalation.options || []).length;
          const actions = escalation.status === "pending"
            ? (isOption
                ? (escalation.options || []).map((option) => action(option, "escalation-choose", escalation.escalation_id + "::" + option)).join("")
                : action("Answer", "escalation-answer", escalation.escalation_id))
            : "";
          const answer = escalation.status === "answered" ? (escalation.answer_choice || escalation.answer_text || "answered") : "";
          return item(escalation.subject, escalation.body, [
            "from: " + agentLabel(escalation.raised_by_agent_id),
            answer ? "answer: " + answer : ""
          ], escalation, escalation.risk_level === "high" ? "risk" : escalation.risk_level === "medium" ? "warn" : "", actions, [
          ["kind", labelize(escalation.kind)],
          ["status", labelize(escalation.status)],
          ["from", agentLabel(escalation.raised_by_agent_id)],
          ["options", (escalation.options || []).join(", ") || "free text"]
        ], "Raised " + timeLabel(escalation.created_at));
        }).join("") || renderEmpty("No escalations waiting.");
      }
      if (state.view === "activity") {
        html = [...state.audit].reverse().map((event) => item(labelize(event.type || "audit event"), event.peer_agent_id ? agentLabel(event.peer_agent_id) : "Local owner action", [
          "when: " + timeLabel(event.created_at),
          "actor/context: " + agentLabel(event.peer_agent_id),
          "audit evidence available"
        ], event, "", "", [
          ["event", labelize(event.type || "unknown")],
          ["actor/context", agentLabel(event.peer_agent_id)],
          ["time", timeLabel(event.created_at)],
          ["audit evidence", event.audit_id ? "available" : "not recorded"]
        ])).join("") || renderEmpty("No activity log entries yet.");
      }
      if (state.view === "inspector") {
        html = item("Current API snapshot", "Local owner state loaded from /api routes.", [
          "contacts: " + values(state.contacts).length,
          "posts: " + values(state.posts).length,
          "feed: " + values(state.feedItems).length,
          "approvals: " + values(state.approvals).length,
          "activity: " + state.audit.length
        ], state, "", "", [
          ["owner", state.me?.display_name || "Local owner"],
          ["contacts", values(state.contacts).length],
          ["posts", values(state.posts).length],
          ["approvals", values(state.approvals).length]
        ]);
      }
      content.innerHTML = html;
      content.querySelectorAll("[data-payload]").forEach((node) => {
        node.addEventListener("click", () => setInspector(JSON.parse(decodeURIComponent(node.dataset.payload))));
        node.addEventListener("keydown", (event) => { if (event.key === "Enter") node.click(); });
      });
      content.querySelectorAll("button[data-view-target]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          state.view = button.dataset.viewTarget;
          render();
        });
      });
      content.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          runAction(button.dataset.action, button.dataset.id);
        });
      });
      const composer = content.querySelector("form[data-action='post-create']");
      if (composer) composer.addEventListener("submit", createPost);
    }
    async function postJson(path, body = {}) {
      return api(path, { method: "POST", body: JSON.stringify(body) });
    }
    async function runAction(name, id) {
      try {
        if (name === "feed-read") await postJson("/api/feed/" + encodeURIComponent(id) + "/read");
        if (name === "feed-hide") await postJson("/api/feed/" + encodeURIComponent(id) + "/hide", { reason: prompt("Reason", "hidden by owner") || "" });
        if (name === "contact-mute") await postJson("/api/contacts/" + encodeURIComponent(id) + "/mute", { reason: prompt("Reason", "muted by owner") || "" });
        if (name === "contact-report") {
          const reason = prompt("Reason for report", "") || "";
          const blockStr = prompt("Also block this contact? (yes/no)", "no") || "no";
          await postJson("/api/contacts/" + encodeURIComponent(id) + "/report", { reason, block: blockStr.trim().toLowerCase() === "yes" });
        }
        if (name === "post-approve") await postJson("/api/posts/" + encodeURIComponent(id) + "/approve");
        if (name === "post-edit") {
          const current = state.posts[id] || {};
          await postJson("/api/posts/" + encodeURIComponent(id) + "/edit", {
            title: prompt("Title", current.title || "") || current.title || "",
            body: prompt("Body", current.body || "") || current.body || "",
            visibility: current.visibility || "private"
          });
        }
        if (name === "post-remove") await postJson("/api/posts/" + encodeURIComponent(id) + "/remove", { reason: prompt("Reason", "removed by owner") || "" });
        if (name === "approval-approve") await postJson("/api/approvals/" + encodeURIComponent(id) + "/resolve", { approved: true });
        if (name === "approval-reject") await postJson("/api/approvals/" + encodeURIComponent(id) + "/resolve", { approved: false });
        if (name === "candidate-approve") await postJson("/api/candidates/" + encodeURIComponent(id) + "/promote", {});
        if (name === "candidate-reject") await postJson("/api/candidates/" + encodeURIComponent(id) + "/reject", {});
        if (name === "escalation-answer") {
          const text = prompt("Your answer", "");
          if (text === null) return;
          await postJson("/api/escalations/" + encodeURIComponent(id) + "/answer", { text });
        }
        if (name === "escalation-choose") {
          const sep = id.lastIndexOf("::");
          const escalationId = id.slice(0, sep);
          const choice = id.slice(sep + 2);
          await postJson("/api/escalations/" + encodeURIComponent(escalationId) + "/answer", { choice });
        }
        await refresh();
      } catch (error) {
        setInspector({ action: name, id, failure_reason: error.message || String(error) });
      }
    }
    async function createPost(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      try {
        await postJson("/api/posts", {
          title: data.get("title"),
          body: data.get("body"),
          visibility: data.get("visibility"),
          status: "draft"
        });
        form.reset();
        await refresh();
      } catch (error) {
        setInspector({ action: "post-create", failure_reason: error.message || String(error) });
      }
    }
    async function refresh() {
      const me = await api("/api/me");
      state.me = me.identity;
      setText("owner", publicOwnerLabel() + " | Local session active");
      setText("ownerName", publicOwnerLabel());
      setText("ownerShort", "local owner session");
      const [contacts, posts, feed, approvals, candidates, escalations, audit] = await Promise.all([
        api("/api/contacts"),
        api("/api/posts"),
        api("/api/feed"),
        api("/api/approvals"),
        api("/api/candidates"),
        api("/api/escalations"),
        api("/api/audit")
      ]);
      state.contacts = contacts.contacts;
      state.mutes = contacts.mutes;
      state.posts = posts.posts;
      state.feedItems = feed.feed_items;
      state.approvals = approvals.approvals;
      state.candidates = candidates.candidates || [];
      state.escalations = escalations.escalations || {};
      state.audit = audit.audit || [];
      const messageSets = await Promise.all(values(state.contacts).map((contact) => api("/api/messages/" + encodeURIComponent(contact.peer_agent_id)).catch(() => ({ messages: [] }))));
      state.messages = messageSets.flatMap((set) => set.messages || []);
      setText("sessionBadge", "Local session active");
      render();
    }
    async function boot() {
      try {
        document.getElementById("content").innerHTML = skeleton();
        setText("viewState", "Loading");
        const login = await fetch("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ auth_method: "dev-bypass" })
        }).then((response) => response.json());
        state.sessionId = login.session_id;
        state.csrf = login.csrf_token;
        await refresh();
      } catch (error) {
        document.getElementById("content").innerHTML = '<div class="loading">Still connecting to local Edge Book data. Retrying shortly...</div>';
        setText("viewState", "Connecting");
        window.setTimeout(boot, 1200);
      }
    }
    document.querySelectorAll("nav button").forEach((button) => button.addEventListener("click", () => {
      state.view = button.dataset.view;
      render();
    }));
    boot();
`;
