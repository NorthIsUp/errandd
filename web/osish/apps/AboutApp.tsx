export function AboutApp() {
  return (
    <div style={{ padding: 16, fontSize: 12, lineHeight: 1.5 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>osish 🖥️</h3>
      <p>A tiny web OS inspired by Mac OS 9. Apps live in draggable windows.</p>
      <p>
        Windows clamp to the viewport so the titlebar is always grabbable. Settings
        and menubar config are persisted in <code>localStorage</code>.
      </p>
    </div>
  );
}
