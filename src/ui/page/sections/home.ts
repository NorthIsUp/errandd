/** Home section markup — populated client-side by loadHome(). */
export const homeHtml = `
  <div class="home-grid">
    <article class="card" id="home-server">
      <h2>Server</h2>
      <div class="card-body"><div class="card-loading">Loading…</div></div>
    </article>
    <article class="card" id="home-upcoming">
      <h2>Upcoming Jobs</h2>
      <div class="card-body"><div class="card-loading">Loading…</div></div>
    </article>
    <article class="card" id="home-git">
      <h2>Git Sync</h2>
      <div class="card-body"><div class="card-loading">Loading…</div></div>
    </article>
    <article class="card" id="home-recent">
      <h2>Recent Activity</h2>
      <div class="card-body"><div class="card-loading">Loading…</div></div>
    </article>
    <article class="card card-wide" id="home-usage">
      <h2>Session Usage</h2>
      <div class="card-body">
        <div class="usage-table-wrap" id="home-usage-wrap"><div class="card-loading">Loading…</div></div>
      </div>
    </article>
  </div>
`;
