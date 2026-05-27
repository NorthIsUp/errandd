import { useState } from "react";
import { useOs } from "./store";

/**
 * Classic Mac OS resource-fork icons live under web/osish/icons/ (extracted
 * from `~/Downloads/Mac Classic 9/*.rsrc` via DeRez + sips). They are copied
 * into the bundle at build time.
 *
 * For now every app uses icon 26 — the user can remap per-app later by
 * changing the path here.
 */
const ICONS: Record<string, string> = {
  settings: "icons/26.png",
  files: "icons/26.png",
  chats: "icons/26.png",
  jobs: "icons/26.png",
  about: "icons/26.png",
};
const FALLBACK_ICON = "icons/26.png";

export function DesktopIcons() {
  const { apps, openApp } = useOs();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        display: "grid",
        gridTemplateColumns: "repeat(1, 80px)",
        gap: 8,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelected(null);
      }}
    >
      {apps.map((app) => (
        <div
          key={app.id}
          className="osish-icon"
          data-selected={selected === app.id}
          onClick={(e) => {
            e.stopPropagation();
            setSelected(app.id);
          }}
          onDoubleClick={() => openApp(app.id)}
        >
          <span className="osish-icon-glyph">
            <img
              src={ICONS[app.id] ?? FALLBACK_ICON}
              alt={app.title}
              width={40}
              height={40}
              style={{ imageRendering: "pixelated" }}
              draggable={false}
            />
          </span>
          <span className="osish-icon-label">{app.title}</span>
        </div>
      ))}
    </div>
  );
}
