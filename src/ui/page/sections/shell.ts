/** The outer app shell markup: rail nav + section host. */
export const shellHtml = `
  <div class="app">
    <nav class="rail" id="rail" aria-label="Sections">
      <div class="rail-brand" title="ClaudeClaw">🦞</div>
      <button class="rail-btn rail-btn-active" data-section="home" type="button">🏠<span>Home</span></button>
      <button class="rail-btn" data-section="chats" type="button">💬<span>Chats</span></button>
      <button class="rail-btn" data-section="jobs" type="button">🗂️<span>Jobs</span></button>
      <button class="rail-btn" data-section="settings" type="button">⚙️<span>Settings</span></button>
      <a id="rail-git" class="rail-git" target="_blank" rel="noopener noreferrer" hidden></a>
    </nav>
    <button class="rail-toggle" id="rail-toggle" type="button" aria-label="Menu">☰</button>
    <div class="rail-scrim" id="rail-scrim" hidden></div>
    <main class="section-host">
      <section class="section section-active" id="section-home"></section>
      <section class="section" id="section-chats" hidden></section>
      <section class="section" id="section-jobs" hidden></section>
      <section class="section" id="section-settings" hidden></section>
    </main>
  </div>
`;
