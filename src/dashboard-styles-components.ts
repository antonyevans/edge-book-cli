// Component styles of the agent-LOCAL reader dashboard (split from
// dashboard-html.ts): list items, trust pills, buttons, forms, inspector,
// and responsive rules. Concatenated verbatim into the <style> tag of
// dashboardHtml() — keep this a plain static template string.
export const DASHBOARD_STYLES_COMPONENTS = `    .item {
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
`;
