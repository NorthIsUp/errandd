/** Jobs section markup — two-pane: file list + editor. */
export const jobsHtml = `
  <div class="jobs-layout">
    <div class="jobs-list-pane" id="jobs-list-pane">
      <div class="jobs-list-header">
        <span class="jobs-pane-title">Job Files</span>
        <div class="jobs-list-actions">
          <button class="jobs-btn" id="jobs-new-btn" type="button">+ New</button>
          <button class="jobs-btn jobs-btn-danger" id="jobs-delete-btn" type="button" disabled>Delete</button>
        </div>
      </div>
      <div id="job-file-list" class="job-file-list">
        <div class="job-file-empty">Loading…</div>
      </div>
    </div>
    <div class="jobs-editor-pane" id="jobs-editor-pane">
      <div class="jobs-editor-header">
        <span class="jobs-current-file" id="jobs-current-file">No file selected</span>
        <span class="jobs-dirty-indicator" id="jobs-dirty" hidden>● unsaved</span>
      </div>
      <div class="job-fm-summary" id="job-fm-summary" hidden></div>
      <div id="jobs-repos-status-list" class="jobs-repos-status-list">
        <!-- Per-repo status lines populated by loadJobsRepoStatus() -->
      </div>
      <textarea id="job-editor" class="job-editor" spellcheck="false" placeholder="Select a file to edit…" disabled></textarea>
      <div class="jobs-editor-actions">
        <button class="jobs-btn jobs-btn-save" id="jobs-save-btn" type="button" disabled>Save</button>
        <button class="jobs-btn" id="jobs-back-btn" type="button" hidden>← Back</button>
      </div>
      <div class="jobs-status" id="jobs-status"></div>
    </div>
  </div>
`;
