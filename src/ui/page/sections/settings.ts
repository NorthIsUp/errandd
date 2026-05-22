/** Settings section markup — form groups for all configurable settings. */
export const settingsHtml = `
  <div class="settings-section">
    <div class="settings-section-head">
      <h2>Settings</h2>
      <button class="settings-save-btn" id="settings-save-btn" type="button" disabled>Save Changes</button>
    </div>
    <div class="settings-status" id="settings-section-status"></div>
    <div class="settings-groups">

      <fieldset class="settings-group">
        <legend>Model</legend>
        <div class="settings-row">
          <label class="settings-label" for="s-model">Primary Model</label>
          <input class="settings-input" id="s-model" type="text" placeholder="e.g. claude-sonnet-4-5" />
        </div>
        <div class="settings-row">
          <label class="settings-label" for="s-fallback-model">Fallback Model</label>
          <input class="settings-input" id="s-fallback-model" type="text" placeholder="e.g. claude-haiku-3-5" />
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Heartbeat</legend>
        <div class="settings-row">
          <label class="settings-label" for="s-hb-enabled">Enabled</label>
          <input type="checkbox" id="s-hb-enabled" class="settings-checkbox" />
        </div>
        <div class="settings-row">
          <label class="settings-label" for="s-hb-interval">Interval (minutes)</label>
          <input class="settings-input settings-input-sm" id="s-hb-interval" type="number" min="1" max="1440" step="1" />
        </div>
        <div class="settings-row settings-row-col">
          <label class="settings-label" for="s-hb-prompt">Prompt</label>
          <textarea class="settings-textarea" id="s-hb-prompt" rows="4" placeholder="What should the heartbeat run?"></textarea>
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Security</legend>
        <div class="settings-row">
          <label class="settings-label" for="s-security">Level</label>
          <select class="settings-select" id="s-security">
            <option value="locked">Locked</option>
            <option value="strict">Strict</option>
            <option value="moderate">Moderate</option>
            <option value="unrestricted">Unrestricted</option>
          </select>
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Clock</legend>
        <div class="settings-row">
          <label class="settings-label" for="s-clock-format">Format</label>
          <select class="settings-select" id="s-clock-format">
            <option value="24">24-hour</option>
            <option value="12">12-hour</option>
          </select>
        </div>
        <div class="settings-row">
          <label class="settings-label" for="s-timezone">Timezone</label>
          <select class="settings-select" id="s-timezone">
            <option value="UTC">UTC</option>
            <option value="America/New_York">America/New_York</option>
            <option value="America/Chicago">America/Chicago</option>
            <option value="America/Denver">America/Denver</option>
            <option value="America/Los_Angeles">America/Los_Angeles</option>
            <option value="Europe/London">Europe/London</option>
            <option value="Europe/Berlin">Europe/Berlin</option>
            <option value="Asia/Tokyo">Asia/Tokyo</option>
            <option value="Australia/Sydney">Australia/Sydney</option>
          </select>
        </div>
      </fieldset>

      <fieldset class="settings-group">
        <legend>Jobs Repo (Git)</legend>
        <div class="settings-row">
          <label class="settings-label" for="s-repo-url">Git URL</label>
          <input class="settings-input" id="s-repo-url" type="text" placeholder="git@github.com:org/jobs.git" />
        </div>
        <div class="settings-row">
          <label class="settings-label" for="s-repo-branch">Branch</label>
          <input class="settings-input settings-input-sm" id="s-repo-branch" type="text" placeholder="main" />
        </div>
        <div class="settings-row">
          <label class="settings-label" for="s-repo-interval">Pull Interval (seconds)</label>
          <input class="settings-input settings-input-sm" id="s-repo-interval" type="number" min="0" step="1" />
        </div>
      </fieldset>

    </div>
  </div>
`;
