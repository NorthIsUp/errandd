export const pageStyles = String.raw`    :root {
      --bg-top: #2a4262;
      --bg-bottom: #0d1828;
      --bg-spot-a: #7fb8ff3d;
      --bg-spot-b: #95d1ff38;
      --text: #f0f4fb;
      --muted: #a8b4c5;
      --panel: #0b1220aa;
      --border: #d8e4ff1f;
      --accent: #9be7ff;
      --good: #67f0b5;
      --bad: #ff7f7f;
      --warn: #ffc276;
      --rail-width: 72px;
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
    }

    body {
      font-family: "Space Grotesk", system-ui, sans-serif;
      color: var(--text);
      background:
        radial-gradient(1400px 700px at 15% -10%, var(--bg-spot-a), transparent 60%),
        radial-gradient(900px 500px at 85% 10%, var(--bg-spot-b), transparent 65%),
        linear-gradient(180deg, var(--bg-top) 0%, var(--bg-bottom) 100%);
      overflow: hidden;
      position: relative;
      transition: background 320ms ease;
    }

    /* ── App shell ── */
    .app {
      display: flex;
      width: 100%;
      height: 100vh;
      overflow: hidden;
    }

    .rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      width: var(--rail-width);
      min-width: var(--rail-width);
      height: 100vh;
      background: #06101ccc;
      border-right: 1px solid var(--border);
      backdrop-filter: blur(10px);
      z-index: 10;
      padding: 10px 0;
      gap: 4px;
      flex-shrink: 0;
      overflow: hidden;
    }

    .rail-brand {
      font-size: 22px;
      padding: 8px 0 14px;
      cursor: default;
      user-select: none;
      text-align: center;
      width: 100%;
    }

    .rail-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      width: 58px;
      padding: 8px 4px;
      border: 1px solid transparent;
      border-radius: 10px;
      background: transparent;
      color: var(--muted);
      font-family: "Space Grotesk", sans-serif;
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }

    .rail-btn span {
      display: block;
      font-size: 9px;
      line-height: 1;
    }

    .rail-btn:hover {
      background: #ffffff10;
      color: var(--text);
      border-color: var(--border);
    }

    .rail-btn-active {
      background: #0e2040cc;
      border-color: #ffffff22;
      color: #eef4ff;
    }

    .rail-git {
      margin-top: auto;
      padding: 8px 4px;
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      color: #4a6a8a;
      text-decoration: none;
      text-align: center;
      width: 100%;
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      transition: color 0.15s ease;
      flex-shrink: 0;
    }

    .rail-git:hover {
      color: #8aaccc;
    }

    .rail-toggle {
      display: none;
      position: fixed;
      top: 10px;
      left: 10px;
      z-index: 20;
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #0b1220cc;
      color: var(--text);
      font-size: 18px;
      cursor: pointer;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
    }

    .rail-scrim {
      position: fixed;
      inset: 0;
      z-index: 9;
      background: rgba(0,0,0,0.55);
    }

    .section-host {
      flex: 1;
      height: 100vh;
      overflow: hidden;
      position: relative;
      min-width: 0;
    }

    .section {
      position: absolute;
      inset: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0;
      margin: 0;
    }

    .section-active {
      display: block;
    }

    @media (max-width: 760px) {
      .rail {
        position: fixed;
        left: 0;
        top: 0;
        height: 100vh;
        transform: translateX(-100%);
        transition: transform 0.22s ease;
        z-index: 15;
      }
      .rail.rail-open {
        transform: translateX(0);
      }
      /* Small floating button — sits inline with section headings */
      .rail-toggle {
        display: flex;
        position: fixed;
        top: 10px;
        left: 10px;
        width: 38px;
        height: 38px;
        border-radius: 8px;
        border: 1px solid var(--border);
        background: #0b1220cc;
        z-index: 20;
        font-size: 18px;
      }
      .rail.rail-open ~ .rail-toggle {
        display: none;
      }
      .section-host {
        width: 100vw;
      }
      /* Minimal top padding — heading sits near burger's vertical centre */
      .section {
        padding-top: 12px;
      }
      /* Shift leading content right so heading text clears the 38px burger + 10px left + gap */
      .home-grid {
        padding-left: 56px;
        padding-right: 20px;
        padding-top: 4px;
      }
      .settings-section {
        padding-left: 56px;
      }
      /* Chats sidebar header */
      .chat-sidebar-header {
        padding-left: 56px;
      }
      /* Jobs list pane header */
      .jobs-list-header {
        padding-left: 56px;
      }
    }

    /* ── Home section ── */
    .home-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      padding: 20px;
    }

    .card-wide {
      grid-column: 1 / -1;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background:
        radial-gradient(120% 100% at 100% 0%, #7dc5ff12, transparent 55%),
        linear-gradient(180deg, #0e1a2a88 0%, #0a1220a8 100%);
      backdrop-filter: blur(6px);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .card h2 {
      margin: 0;
      font-family: "Space Grotesk", sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
    }

    .card-body {
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      color: var(--text);
      line-height: 1.6;
    }

    .card-loading {
      color: var(--muted);
      font-size: 11px;
    }

    .card-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 0;
      border-bottom: 1px solid #ffffff08;
    }

    .card-row:last-child {
      border-bottom: none;
    }

    .card-row-label {
      color: var(--muted);
      font-size: 11px;
    }

    .card-row-value {
      font-size: 12px;
      font-weight: 500;
    }

    .card-row-value.ok { color: var(--good); }
    .card-row-value.warn { color: var(--warn); }
    .card-row-value.bad { color: var(--bad); }

    .card-link-btn {
      margin-top: 6px;
      padding: 5px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #ffffff0f;
      color: var(--accent);
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.14s ease;
    }

    .card-link-btn:hover { background: #ffffff1a; }

    .card-list {
      display: grid;
      gap: 6px;
    }

    .card-list-item {
      padding: 5px 8px;
      border: 1px solid #ffffff12;
      border-radius: 8px;
      background: #0b1422a8;
      font-size: 11px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 2px 8px;
    }

    .card-list-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-list-meta { color: var(--muted); white-space: nowrap; flex-shrink: 0; }
    .card-list-sub { color: var(--muted); font-size: 10px; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: normal; overflow-wrap: anywhere; width: 100%; margin-top: 2px; }

    .card-empty {
      color: var(--muted);
      font-size: 11px;
      font-style: italic;
    }

    /* ── Chat / Session section ── */
    .chat-layout {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    .chat-list-pane {
      width: 260px;
      min-width: 260px;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      background: #06101caa;
      overflow: hidden;
      flex-shrink: 0;
    }

    .chat-sidebar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      gap: 6px;
    }

    .chat-sidebar-header h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      flex: 1;
    }

    .chat-sidebar-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .show-closed-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      color: var(--muted);
      cursor: pointer;
      white-space: nowrap;
    }

    .new-session-btn {
      background: var(--accent);
      color: #000;
      border: none;
      border-radius: 5px;
      padding: 3px 10px;
      font-size: 12px;
      font-family: "Space Grotesk", sans-serif;
      cursor: pointer;
      white-space: nowrap;
    }

    .new-session-btn:hover { opacity: 0.85; }

    .session-list {
      flex: 1;
      overflow-y: auto;
    }

    .session-item {
      padding: 9px 14px;
      cursor: pointer;
      border-bottom: 1px solid var(--border);
      transition: background 0.12s ease;
    }

    .session-item:hover { background: rgba(255,255,255,0.05); }

    .session-item.active {
      background: rgba(255,255,255,0.08);
      border-left: 3px solid var(--accent);
      padding-left: 11px;
    }

    .session-item.closed {
      opacity: 0.6;
    }

    .session-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 3px;
    }

    .session-agent {
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .session-channel {
      font-size: 10px;
      color: var(--muted);
      background: rgba(255,255,255,0.1);
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: 4px;
      flex-shrink: 0;
    }

    .session-preview {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-job {
      margin: 2px 0;
    }

    .session-job-link {
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      color: var(--accent, #7dc5ff);
      background: rgba(125,197,255,0.1);
      border: 1px solid rgba(125,197,255,0.25);
      border-radius: 4px;
      padding: 1px 6px;
      cursor: pointer;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-job-link:hover {
      background: rgba(125,197,255,0.2);
      text-decoration: underline;
    }

    .session-time {
      font-size: 10px;
      color: var(--muted);
      margin-top: 2px;
    }

    .session-time-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .session-time-row .session-close {
      flex-shrink: 0;
      min-width: 22px;
      min-height: 18px;
    }

    .session-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }

    .session-rename,
    .session-close {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 11px;
      cursor: pointer;
      transition: color 0.12s ease, background 0.12s ease;
    }

    .session-rename:hover { color: var(--accent); background: rgba(255,255,255,0.06); }
    .session-close:hover { color: var(--bad); background: rgba(255,100,100,0.08); }

    .session-title-input {
      width: 100%;
      border: 1px solid var(--accent);
      border-radius: 4px;
      background: #0b1828;
      color: var(--text);
      font-family: "Space Grotesk", sans-serif;
      font-size: 12px;
      padding: 2px 6px;
    }

    .session-loading {
      padding: 16px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
    }

    .chat-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }

    .chat-main-header {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
    }

    .chat-back-btn {
      display: none;
      padding: 8px 14px;
      border: none;
      background: transparent;
      color: var(--accent);
      font-size: 12px;
      cursor: pointer;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }

    .chat-history-banner {
      padding: 5px 14px;
      font-size: 11px;
      color: var(--muted);
      background: rgba(255,255,255,0.04);
      border-bottom: 1px solid var(--border);
      text-align: center;
      flex-shrink: 0;
    }

    .load-more-container {
      text-align: center;
      padding: 6px;
      flex-shrink: 0;
    }

    .load-more-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--muted);
      padding: 4px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }

    .load-more-btn:hover { background: rgba(255,255,255,0.05); }

    .chat-messages {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      scrollbar-width: thin;
      scrollbar-color: #7fa6d5 #091222;
    }

    .chat-messages::-webkit-scrollbar { width: 6px; }
    .chat-messages::-webkit-scrollbar-track { background: transparent; }
    .chat-messages::-webkit-scrollbar-thumb { background: #3a5a80; border-radius: 999px; }

    .chat-empty {
      margin: auto;
      text-align: center;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #5a7a9a;
      padding: 40px 20px;
    }

    .chat-msg {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 88%;
    }

    .chat-msg-user {
      align-self: flex-end;
      align-items: flex-end;
    }

    .chat-msg-assistant {
      align-self: flex-start;
      align-items: flex-start;
    }

    .chat-msg-role {
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.55;
      padding: 0 4px;
    }

    .chat-msg-text {
      padding: 10px 14px;
      border-radius: 14px;
      font-family: "JetBrains Mono", monospace;
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .chat-msg-user .chat-msg-text {
      background: linear-gradient(135deg, #1a4a7a, #0f3060);
      border: 1px solid #2a6aaa44;
      color: #d8eeff;
      border-bottom-right-radius: 4px;
    }

    .chat-msg-assistant .chat-msg-text {
      background: #0b1828cc;
      border: 1px solid #ffffff18;
      color: #e4eefb;
      border-bottom-left-radius: 4px;
    }

    .chat-msg-streaming .chat-msg-text::after {
      content: "▋";
      display: inline-block;
      color: var(--accent);
      animation: caret 0.8s step-end infinite;
      margin-left: 2px;
    }

    @keyframes caret {
      0%, 49% { opacity: 1; }
      50%, 100% { opacity: 0; }
    }

    /* ── Goal banner ── */
    .chat-prefs-banner {
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      background: linear-gradient(90deg, #1a3a5a, #0f2840);
      border-top: 1px solid #4a9fdf44;
      border-bottom: 1px solid #4a9fdf22;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #9be7ff;
      letter-spacing: 0.02em;
    }
    .chat-prefs-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 14px;
    }
    .chat-prefs-row + .chat-prefs-row {
      border-top: 1px solid #4a9fdf18;
    }
    .chat-prefs-label {
      opacity: 0.65;
      font-weight: 600;
      flex-shrink: 0;
    }
    .chat-goal-text,
    .chat-model-text,
    .chat-effort-text {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-style: italic;
    }
    .chat-prefs-clear {
      flex-shrink: 0;
      background: transparent;
      border: 1px solid #4a9fdf55;
      border-radius: 50%;
      color: #9be7ff;
      width: 18px;
      height: 18px;
      font-size: 13px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      padding: 0;
      opacity: 0.7;
      transition: opacity 0.15s ease;
    }
    .chat-prefs-clear:hover { opacity: 1; }

    /* ── System bubble (for /goal and /loop feedback) ── */
    .chat-msg-system {
      align-self: center;
      max-width: 90%;
      background: rgba(60, 100, 140, 0.12);
      border: 1px solid rgba(60, 120, 180, 0.3);
      border-radius: 8px;
      padding: 6px 12px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #7ab8d8;
      letter-spacing: 0.02em;
      font-style: italic;
    }
    .chat-msg-system a { color: var(--accent); text-decoration: underline; cursor: pointer; }

    .chat-input-area {
      flex-shrink: 0;
      padding: 10px 12px 12px;
      border-top: 1px solid #ffffff12;
      background: #080f1c66;
    }

    .chat-form {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 8px;
      border: 1px solid #ffffff2e;
      border-radius: 14px;
      background: #ffffff09;
      padding: 8px 8px 8px 12px;
      transition: border-color 0.18s ease;
    }

    .chat-form:focus-within { border-color: #7dc5ff55; }

    .chat-input {
      flex: 1;
      border: 0;
      background: transparent;
      color: #eef4ff;
      font-family: "JetBrains Mono", monospace;
      font-size: 13px;
      line-height: 1.5;
      resize: none;
      max-height: 160px;
      overflow-y: auto;
      padding: 2px 0;
      scrollbar-width: thin;
      scrollbar-color: #3a5a80 transparent;
    }

    .chat-input::placeholder { color: #4a6a8a; }
    .chat-input:focus { outline: none; }

    .chat-send,
    .chat-cancel {
      flex-shrink: 0;
      height: 34px;
      padding: 0 14px;
      border-radius: 999px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      letter-spacing: 0.03em;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.16s ease, filter 0.16s ease, opacity 0.16s ease, background 0.16s ease, border-color 0.16s ease;
    }

    .chat-send {
      border: 1px solid #3cb87980;
      background: linear-gradient(180deg, #1f6f47d4 0%, #18563ace 100%);
      color: #c8f8de;
      font-weight: 600;
    }

    .chat-send:hover { transform: translateY(-1px); filter: brightness(1.06); }
    .chat-send:disabled { opacity: 0.45; cursor: not-allowed; transform: none; filter: none; }

    .chat-cancel {
      border: 1px solid #ff7f7f55;
      background: #34181855;
      color: #ff9b9b;
    }

    .chat-cancel:hover { transform: translateY(-1px); background: #4d191970; border-color: #ff9b9b66; }

    .chat-msg-time {
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      letter-spacing: 0.04em;
      color: var(--muted);
      opacity: 0.55;
      padding: 1px 4px;
      margin-top: 1px;
    }

    .chat-msg-elapsed {
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      letter-spacing: 0.04em;
      color: #5a8aaa;
      padding: 2px 4px;
      margin-top: 2px;
    }

    .chat-msg-background {
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      letter-spacing: 0.04em;
      color: #7a9aba;
      padding: 2px 4px;
      margin-top: 4px;
      animation: caret 2s step-end infinite;
    }

    .chat-msg-agent {
      align-self: center;
      max-width: 90%;
      background: rgba(90, 130, 170, 0.08);
      border: 1px solid rgba(90, 130, 170, 0.25);
      border-radius: 8px;
      padding: 6px 12px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #7aaac8;
      letter-spacing: 0.02em;
    }

    .chat-msg-agent-running { color: #8ac0e8; border-color: rgba(100, 160, 200, 0.4); }
    .chat-msg-agent-done { color: #5a9a7a; border-color: rgba(90, 154, 122, 0.35); background: rgba(90, 154, 122, 0.06); }
    .chat-agent-spinner { opacity: 0.6; animation: caret 1.2s step-end infinite; }

    /* ── File attachment UI ── */
    .chat-attach {
      flex-shrink: 0;
      height: 34px;
      width: 34px;
      padding: 0;
      border-radius: 999px;
      border: 1px solid #ffffff2a;
      background: #ffffff09;
      color: #c8d8f0;
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.16s ease, background 0.16s ease, border-color 0.16s ease, opacity 0.16s ease;
    }

    .chat-attach:hover { transform: translateY(-1px); background: #ffffff18; border-color: #ffffff44; }
    .chat-attach:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }

    .chat-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 0 0 4px;
      width: 100%;
      flex-basis: 100%;
      border-bottom: 1px solid #ffffff14;
      margin-bottom: 2px;
    }

    .attach-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px 3px 10px;
      border-radius: 999px;
      background: #0e1e34cc;
      border: 1px solid #ffffff22;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #c8d8f0;
      max-width: 220px;
    }

    .attach-chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 150px;
    }

    .attach-chip-remove {
      flex-shrink: 0;
      border: none;
      background: transparent;
      color: #8aaccc;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.14s ease;
    }

    .attach-chip-remove:hover { color: #ff9b9b; }

    .attach-warn {
      width: 100%;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: #ffc276;
      padding: 2px 4px;
    }

    /* ── Mobile chat ── */
    @media (max-width: 760px) {
      .chat-layout { flex-direction: column; }
      .chat-list-pane { width: 100%; min-width: 100%; border-right: none; border-bottom: 1px solid var(--border); max-height: 50vh; }
      .chat-main { min-height: 0; flex: 1; }
      .chat-back-btn { display: block; }

      .section-chats-detail .chat-list-pane { display: none; }
      .section-chats-detail .chat-back-btn { display: block; }
    }

    /* ── Jobs section ── */
    .jobs-layout {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    .jobs-list-pane {
      width: 240px;
      min-width: 240px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      background: #06101caa;
      overflow: hidden;
    }

    .jobs-list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      gap: 6px;
      flex-shrink: 0;
    }

    .jobs-pane-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .jobs-list-actions {
      display: flex;
      gap: 4px;
    }

    .job-file-list {
      flex: 1;
      overflow-y: auto;
    }

    .job-file-item {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--text);
      transition: background 0.12s ease;
    }

    .job-file-item:hover { background: rgba(255,255,255,0.05); }
    .job-file-item.active { background: rgba(255,255,255,0.08); border-left: 3px solid var(--accent); padding-left: 9px; }

    .job-file-is-job {
      display: inline-block;
      margin-right: 4px;
      font-size: 9px;
      color: var(--good);
      border: 1px solid var(--good);
      border-radius: 3px;
      padding: 0 3px;
      vertical-align: middle;
    }

    .job-file-empty {
      padding: 16px;
      color: var(--muted);
      font-size: 11px;
      font-family: "JetBrains Mono", monospace;
    }

    .jobs-editor-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
      padding: 0;
    }

    .jobs-editor-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .jobs-current-file {
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .jobs-dirty-indicator {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--warn);
      flex-shrink: 0;
    }

    .job-fm-summary {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      padding: 4px 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.02);
      flex-shrink: 0;
    }

    .jobs-repo-status {
      padding: 5px 14px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    /* Per-repo status row in the editor pane */
    .jobs-repo-status-row {
      padding: 6px 14px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    /* Repo name line: icon on left, muted label style */
    .jobs-repo-status-name {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 3px;
    }

    /* Status text + sync button on one flex row, button pushed right */
    .jobs-repo-status-bottom {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }

    .jobs-repo-status-text {
      flex: 1;
      color: var(--muted);
      min-width: 0;
    }

    .jobs-btn-sync {
      flex-shrink: 0;
      margin-left: auto;
    }

    /* File-list group heading: small muted uppercase, icon on left */
    .job-file-group-header {
      padding: 5px 12px 3px;
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.01);
    }

    .jobs-plugin-icon {
      opacity: 0.75;
    }

    .jobs-plugin-list {
      padding: 2px 14px 6px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    .jobs-plugin-item {
      padding: 1px 0;
      color: #7dc5ff99;
    }

    /* ── Jobs Plugin Repos: per-repo editable row in Settings ── */
    .jobs-repos-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 10px;
    }

    .jobs-repos-row {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #0b1422a8;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .jobs-repos-row-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid #ffffff10;
      margin-bottom: 4px;
    }

    .jobs-repos-row-label {
      font-family: "Space Grotesk", sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--muted);
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .jobs-repos-remove-btn {
      width: 26px;
      height: 26px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color 0.14s ease, background 0.14s ease, border-color 0.14s ease;
    }

    .jobs-repos-remove-btn:hover {
      color: var(--bad);
      border-color: rgba(255,127,127,0.4);
      background: rgba(255,127,127,0.08);
    }

    /* ── Slash-command autocomplete popover ── */
    .slash-popover {
      position: relative;
      width: 100%;
      background: #0d1929;
      border: 1px solid #7dc5ff44;
      border-radius: 6px;
      margin-bottom: 4px;
      max-height: 160px;
      overflow-y: auto;
      z-index: 100;
    }

    .slash-option {
      padding: 5px 10px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      color: #b0cce8;
      cursor: pointer;
      border-radius: 4px;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .slash-option-name {
      flex-shrink: 0;
      font-weight: 600;
    }

    .slash-option-meta {
      flex: 1;
      text-align: right;
      font-size: 11px;
      color: var(--muted, #637a8a);
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .slash-option:hover, .slash-option-selected {
      background: #7dc5ff22;
      color: #e0f0ff;
    }

    .slash-option-empty {
      padding: 6px 10px;
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      color: var(--muted, #637a8a);
      font-style: italic;
      user-select: none;
    }

    .job-editor {
      flex: 1;
      width: 100%;
      border: none;
      background: #060d18;
      color: #d7e3f5;
      font-family: "JetBrains Mono", monospace;
      font-size: 13px;
      line-height: 1.6;
      padding: 14px;
      resize: none;
      outline: none;
      overflow-y: auto;
    }

    .job-editor:disabled { opacity: 0.5; }

    .jobs-editor-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-top: 1px solid var(--border);
      background: #06101caa;
      flex-shrink: 0;
    }

    .jobs-status {
      padding: 4px 14px 6px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      min-height: 22px;
      flex-shrink: 0;
    }

    .jobs-btn {
      height: 30px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #ffffff0f;
      color: var(--text);
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.14s ease;
    }

    .jobs-btn:hover { background: #ffffff1a; }
    .jobs-btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .jobs-btn-danger {
      border-color: #ff7f7f44;
      color: var(--bad);
    }

    .jobs-btn-danger:hover { background: rgba(255,100,100,0.12); }

    .jobs-btn-save {
      border-color: #3cb87966;
      color: var(--good);
    }

    .jobs-btn-save:hover { background: rgba(67, 240, 181, 0.1); }

    @media (max-width: 760px) {
      .jobs-layout { flex-direction: column; }
      .jobs-list-pane { width: 100%; min-width: 100%; max-height: 40vh; border-right: none; border-bottom: 1px solid var(--border); }
      .jobs-editor-pane { flex: 1; min-height: 0; }
      .jobs-back-btn { display: inline-flex !important; }
      .section-jobs-detail .jobs-list-pane { display: none; }
    }

    /* ── Settings section ── */
    .settings-section {
      padding: 20px;
      max-width: 760px;
    }

    .settings-section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .settings-section-head h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .settings-save-btn {
      height: 34px;
      padding: 0 18px;
      border: 1px solid #3cb87966;
      border-radius: 999px;
      background: linear-gradient(180deg, #1f6f47d4 0%, #18563ace 100%);
      color: #c8f8de;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: filter 0.14s ease, opacity 0.14s ease;
    }

    .settings-save-btn:hover { filter: brightness(1.1); }
    .settings-save-btn:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }

    .settings-status {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--good);
      min-height: 18px;
      margin-bottom: 8px;
    }

    .settings-groups {
      display: grid;
      gap: 16px;
    }

    .settings-group {
      border: 1px solid var(--border);
      border-radius: 12px;
      background:
        radial-gradient(120% 100% at 100% 0%, #7dc5ff0a, transparent 55%),
        linear-gradient(180deg, #0e1a2a88 0%, #0a1220a8 100%);
      padding: 14px 16px;
    }

    /* Float the legend so it renders as a normal block header inside the
       card instead of straddling/notching the fieldset border. */
    .settings-group legend {
      float: left;
      width: 100%;
      margin: 0 0 10px;
      padding: 0 0 8px;
      border-bottom: 1px solid var(--border);
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }

    .settings-group legend + * { clear: both; }

    .settings-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid #ffffff08;
    }

    .settings-row:last-child { border-bottom: none; }

    .settings-row-col {
      flex-direction: column;
      align-items: stretch;
    }

    .settings-label {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      min-width: 160px;
      flex-shrink: 0;
    }

    .settings-input,
    .settings-select,
    .settings-textarea {
      flex: 1;
      border: 1px solid #ffffff2e;
      border-radius: 8px;
      background: #ffffff09;
      color: var(--text);
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      padding: 6px 10px;
    }

    .settings-input:focus,
    .settings-select:focus,
    .settings-textarea:focus {
      outline: 1px solid #7dc5ff66;
      outline-offset: 1px;
    }

    .settings-input-sm { max-width: 160px; flex: none; }

    .settings-select option { background: #0b1828; }

    .settings-textarea {
      resize: vertical;
      min-height: 80px;
      line-height: 1.5;
    }

    .settings-checkbox {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--accent);
    }

    /* ── MCP fieldset ── */
    .settings-btn-secondary {
      height: 28px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #ffffff0f;
      color: var(--muted);
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .settings-btn-secondary:hover { background: #ffffff1a; color: var(--text); }

    .settings-btn-primary {
      height: 28px;
      padding: 0 12px;
      border: 1px solid #3cb87966;
      border-radius: 6px;
      background: linear-gradient(180deg, #1f6f47d4 0%, #18563ace 100%);
      color: #c8f8de;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      cursor: pointer;
      transition: filter 0.14s ease;
    }
    .settings-btn-primary:hover { filter: brightness(1.1); }
    .settings-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }

    .mcp-status {
      min-height: 16px;
      margin-bottom: 6px;
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
    }
    .mcp-status.ok { color: var(--good); }
    .mcp-status.err { color: var(--bad); }

    .mcp-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 0;
      border-bottom: 1px solid #ffffff08;
    }
    .mcp-row:last-child { border-bottom: none; }

    .mcp-name {
      font-family: "JetBrains Mono", monospace;
      font-size: 12px;
      color: var(--text);
      flex-shrink: 0;
      min-width: 100px;
    }

    .mcp-transport-badge {
      font-family: "JetBrains Mono", monospace;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .mcp-transport-stdio {
      color: var(--muted);
      background: rgba(168,180,197,0.12);
      border: 1px solid rgba(168,180,197,0.2);
    }
    .mcp-transport-http {
      color: var(--accent);
      background: rgba(155,231,255,0.1);
      border: 1px solid rgba(155,231,255,0.2);
    }
    .mcp-transport-sse {
      color: var(--warn);
      background: rgba(255,194,118,0.1);
      border: 1px solid rgba(255,194,118,0.2);
    }

    .mcp-target {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .mcp-remove-btn {
      flex-shrink: 0;
      width: 24px;
      height: 24px;
      border: 1px solid #ff7f7f44;
      border-radius: 4px;
      background: transparent;
      color: var(--bad);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.14s ease;
    }
    .mcp-remove-btn:hover { background: rgba(255,100,100,0.12); }

    .mcp-scope-heading {
      font-family: "JetBrains Mono", monospace;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      padding: 6px 0 2px;
      opacity: 0.7;
    }

    .mcp-empty {
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      color: var(--muted);
      padding: 6px 0;
      font-style: italic;
    }

    .mcp-form {
      margin-top: 8px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #ffffff05;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .mcp-form-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .mcp-headers-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
    }

    .mcp-header-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .mcp-header-input {
      flex: 1;
      border: 1px solid #ffffff2e;
      border-radius: 6px;
      background: #ffffff09;
      color: var(--text);
      font-family: "JetBrains Mono", monospace;
      font-size: 11px;
      padding: 4px 8px;
    }
    .mcp-header-input:focus { outline: 1px solid #7dc5ff66; outline-offset: 1px; }

    .mcp-header-remove {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      border: 1px solid #ff7f7f44;
      border-radius: 4px;
      background: transparent;
      color: var(--bad);
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .mcp-header-remove:hover { background: rgba(255,100,100,0.12); }

    /* ── Thread blocks (Chats sidebar) ── */
    .thread {
      border-bottom: 1px solid var(--border);
    }

    .thread-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px 8px 10px;
      cursor: pointer;
      transition: background 0.12s ease;
      user-select: none;
    }

    .thread-header:hover { background: rgba(255,255,255,0.04); }

    .thread-caret {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: var(--muted);
      transition: transform 0.15s ease;
      cursor: pointer;
      border: none;
      background: transparent;
      padding: 0;
    }

    .thread-caret:hover { color: var(--text); }
    .thread.expanded .thread-caret { transform: rotate(90deg); }

    .thread-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 0;
    }

    .thread-badge {
      font-size: 9px;
      font-family: "JetBrains Mono", monospace;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .thread-badge-job { color: var(--warn); background: rgba(255,194,118,0.12); border: 1px solid rgba(255,194,118,0.25); }
    .thread-badge-agent { color: var(--good); background: rgba(103,240,181,0.1); border: 1px solid rgba(103,240,181,0.2); }
    .thread-badge-discord { color: #b9abff; background: rgba(185,171,255,0.1); border: 1px solid rgba(185,171,255,0.2); }
    .thread-badge-web { color: var(--muted); background: rgba(168,180,197,0.1); border: 1px solid rgba(168,180,197,0.18); }

    .thread-job-link {
      background: transparent;
      border: 1px solid transparent;
      padding: 0 4px;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .thread-job-link:hover {
      background: rgba(125,197,255,0.12);
      border-color: rgba(125,197,255,0.25);
    }

    .thread-summary {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
      overflow: hidden;
    }

    .thread-summary-row {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
    }

    .thread-summary-preview {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .thread-summary-meta {
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .thread-count {
      font-size: 10px;
      color: var(--muted);
      flex-shrink: 0;
      opacity: 0.7;
    }

    .thread-body {
      display: none;
    }

    .thread.expanded .thread-body {
      display: block;
    }

    .thread-body .session-item {
      padding-left: 26px;
      border-left: 2px solid transparent;
    }

    .thread-body .session-item.active {
      border-left: 2px solid var(--accent);
      padding-left: 24px;
    }

    .thread-paginator {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 6px 14px;
      border-top: 1px solid var(--border);
    }

    .thread-page-btn {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--muted);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      font-family: "JetBrains Mono", monospace;
      transition: color 0.12s ease, background 0.12s ease;
    }

    .thread-page-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }
    .thread-page-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    .thread-page-info {
      font-size: 10px;
      color: var(--muted);
      font-family: "JetBrains Mono", monospace;
    }

    /* ── Usage table (reused in home card) ── */
    .usage-table-wrap { overflow-x: auto; }
    .usage-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .usage-th {
      text-align: left;
      color: var(--muted);
      font-weight: 500;
      padding: 4px 10px 8px 0;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    .usage-th-num { text-align: right; }
    .usage-td {
      padding: 7px 10px 7px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      vertical-align: middle;
      white-space: nowrap;
    }
    .usage-td-num, .usage-td-turns { text-align: right; color: var(--muted); font-variant-numeric: tabular-nums; }
    .usage-td-label { color: var(--text); font-weight: 500; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .usage-td-age { color: var(--muted); font-size: 11px; }
    .usage-td-cost { min-width: 120px; }
    .usage-cost-wrap { position: relative; height: 18px; display: flex; align-items: center; }
    .usage-cost-bar {
      position: absolute; left: 0; top: 0; height: 100%;
      background: rgba(99, 179, 237, 0.18);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    .usage-cost-label { position: relative; padding-left: 6px; font-variant-numeric: tabular-nums; color: var(--text); }
    .usage-loading { font-size: 12px; color: var(--muted); padding: 8px 0; }

    /* Usage grouping */
    .usage-group-parent { cursor: pointer; }
    .usage-group-parent:hover { background: rgba(255,255,255,0.03); }
    .usage-group-caret {
      border: none; background: transparent; color: var(--muted);
      font-size: 9px; padding: 0 3px 0 0; cursor: pointer; vertical-align: middle;
      transition: transform 0.14s ease;
    }
    .usage-group-count { color: var(--muted); font-size: 10px; }
    .usage-group-child { font-size: 11px; }
    .usage-group-child-hidden { display: none; }
    .usage-child-indent { color: var(--muted); opacity: 0.55; margin-right: 4px; }
    .usage-group-child .usage-td-label { padding-left: 18px; color: var(--muted); font-weight: 400; }
    .usage-td-group-label { font-weight: 600; }

    .usage-total {
      background: rgba(155,231,255,0.05);
      border-bottom: 1px solid var(--border);
    }
    .usage-total .usage-td {
      font-weight: 700;
      color: var(--text);
    }

`;
