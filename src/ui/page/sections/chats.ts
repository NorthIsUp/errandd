/** Chats section markup — two-pane: session list + chat main. */
export const chatsHtml = `
  <div class="chat-layout">
    <div class="chat-list-pane" id="chat-list-pane">
      <div class="chat-sidebar-header">
        <h3>Sessions</h3>
        <div class="chat-sidebar-controls">
          <label class="show-closed-label" title="Show closed sessions">
            <input type="checkbox" id="show-closed" /> Show closed
          </label>
          <button id="new-session-btn" class="new-session-btn" type="button">+ New</button>
        </div>
      </div>
      <div id="session-list" class="session-list">
        <div class="session-loading">Loading…</div>
      </div>
    </div>
    <div class="chat-main" id="chat-main-pane">
      <div class="chat-main-header" id="chat-main-header">
        <button class="chat-back-btn" id="chat-back" type="button" hidden>← Back</button>
        <div id="chat-history-banner" class="chat-history-banner" hidden>
          Viewing history — new messages go to current session
        </div>
      </div>
      <div id="load-more-container" class="load-more-container" hidden>
        <button id="load-more-btn" class="load-more-btn" type="button">Load older messages</button>
      </div>
      <div id="chat-messages" class="chat-messages"></div>
      <div class="chat-prefs-banner" id="chat-prefs-banner" hidden>
        <div class="chat-prefs-row" id="chat-goal-row" hidden><span class="chat-prefs-label">Goal:</span> <span class="chat-goal-text" id="chat-goal-text"></span><button class="chat-prefs-clear" id="chat-goal-clear" type="button" title="Clear goal">×</button></div>
        <div class="chat-prefs-row" id="chat-model-row" hidden><span class="chat-prefs-label">Model:</span> <span class="chat-model-text" id="chat-model-text"></span><button class="chat-prefs-clear" id="chat-model-clear" type="button" title="Clear model">×</button></div>
        <div class="chat-prefs-row" id="chat-effort-row" hidden><span class="chat-prefs-label">Effort:</span> <span class="chat-effort-text" id="chat-effort-text"></span><button class="chat-prefs-clear" id="chat-effort-clear" type="button" title="Clear effort">×</button></div>
      </div>
      <div class="chat-input-area">
        <form id="chat-form" class="chat-form">
          <input
            type="file"
            id="chat-file-input"
            multiple
            style="display:none"
            accept="text/plain,text/html,text/css,text/javascript,text/typescript,text/x-python,text/csv,text/xml,text/markdown,application/json,application/yaml,application/toml,image/jpeg,image/png,image/gif,image/webp,.js,.ts,.py,.json,.yaml,.yml,.md,.txt,.csv,.xml,.sh,.sql,.toml,.ini,.env,.log"
          />
          <textarea
            id="chat-input"
            class="chat-input"
            placeholder="Message Claude..."
            rows="1"
            autocomplete="off"
          ></textarea>
          <div id="chat-attachments" class="chat-attachments" hidden></div>
          <button id="chat-attach" class="chat-attach" type="button" title="Attach files">📎</button>
          <button id="chat-cancel" class="chat-cancel" type="button" hidden>Cancel</button>
          <button id="chat-send" class="chat-send" type="submit">Send</button>
        </form>
      </div>
    </div>
  </div>
`;
