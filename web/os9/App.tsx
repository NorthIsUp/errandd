import { MenuBar, MenuItem } from "@liiift-studio/mac-os9-ui";
import { type ReactElement, useEffect, useState } from "react";
import { Icon } from "./components/Icon";
import { ChatsSection } from "./sections/ChatsSection";
import { HomeSection } from "./sections/HomeSection";
import { RoutinesSection } from "./sections/RoutinesSection";
import { SettingsSection } from "./sections/SettingsSection";
import { type Os9Section, useOs9Hash } from "./useOs9Hash";

const SECTIONS: { id: Os9Section; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "chats", label: "Chats" },
  { id: "routines", label: "Routines" },
  { id: "settings", label: "Settings" },
];

const SECTION_ICONS: Record<Os9Section, ReactElement> = {
  home: <Icon src="home.png" fallback="🏠" size={14} />,
  chats: <Icon src="chats.png" fallback="💬" size={14} />,
  routines: <Icon src="routines.png" fallback="⚙" size={14} />,
  settings: <Icon src="settings.png" fallback="🔧" size={14} />,
};

export default function App() {
  const { section, setSection } = useOs9Hash();
  const [viewportH, setViewportH] = useState(() => window.innerHeight);
  const [openMenu, setOpenMenu] = useState<number>(-1);

  useEffect(() => {
    const onResize = () => setViewportH(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const closeMenu = () => setOpenMenu(-1);

  const menus = [
    {
      label: "🦞",
      items: (
        <>
          <MenuItem
            label="About ClaudeClaw…"
            onClick={() => {
              closeMenu();
              alert("ClaudeClaw — Classic edition");
            }}
          />
          <MenuItem
            label="Switch to Darwin UI"
            onClick={() => {
              closeMenu();
              window.location.href = "/darwin/";
            }}
          />
        </>
      ),
    },
    {
      label: "View",
      items: (
        <>
          {SECTIONS.map((s) => (
            <MenuItem
              key={s.id}
              label={s.label}
              icon={SECTION_ICONS[s.id]}
              checked={s.id === section}
              onClick={() => {
                setSection(s.id);
                closeMenu();
              }}
            />
          ))}
        </>
      ),
    },
  ];

  // Cap each Window so it never exceeds the viewport — but it can be shorter
  // if its content is small. Subtract: menu bar (~28) + top + bottom margin.
  const maxSectionHeight = Math.max(320, viewportH - 80);

  return (
    <div style={{ width: "100%" }}>
      <MenuBar
        menus={menus}
        openMenuIndex={openMenu}
        onMenuOpen={setOpenMenu}
        onMenuClose={closeMenu}
      />
      {/* Padding around the window so the desktop wallpaper shows on the edges. */}
      <div
        style={{
          width: "100%",
          maxWidth: 980,
          margin: "0 auto",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        {section === "home" ? <HomeSection maxHeight={maxSectionHeight} /> : null}
        {section === "chats" ? <ChatsSection maxHeight={maxSectionHeight} /> : null}
        {section === "routines" ? (
          <RoutinesSection maxHeight={maxSectionHeight} />
        ) : null}
        {section === "settings" ? (
          <SettingsSection maxHeight={maxSectionHeight} />
        ) : null}
      </div>
    </div>
  );
}
