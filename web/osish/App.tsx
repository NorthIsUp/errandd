import { MenuBar, MenuItem } from "@liiift-studio/mac-os9-ui";
import { useEffect, useState } from "react";
import { DesktopIcons } from "./DesktopIcons";
import { DraggableWindow } from "./DraggableWindow";
import { APPS, SETTING_SPECS } from "./apps";
import { OsProvider, useOs } from "./store";
import { useViewport } from "./useViewport";

function Shell() {
  const { state, openApp, closeWindow, focusWindow, appById, snapAll } = useOs();
  const [openMenu, setOpenMenu] = useState(-1);
  const [now, setNow] = useState(() => new Date());
  const vp = useViewport();

  // In narrow mode, keep every open window snapped to fill the desktop layer.
  // Re-snaps on orientation change or soft-keyboard resize. Crossing back to
  // wide leaves them at the last snapped geometry; the user can then drag freely.
  useEffect(() => {
    if (!vp.narrow) return;
    const d = document.querySelector(".osish-desktop");
    const r = d?.getBoundingClientRect();
    if (!r) return;
    snapAll(0, 0, r.width, r.height);
  }, [vp.narrow, vp.width, vp.height, snapAll]);


  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const closeMenu = () => setOpenMenu(-1);

  const menus = state.menus.map((menu) => ({
    label: menu.label,
    items: (
      <>
        {menu.items.map((item, i) => {
          if (item.separator) return <MenuItem key={i} label="—" separator disabled />;
          return (
            <MenuItem
              key={i}
              label={item.label}
              onClick={() => {
                closeMenu();
                if (item.appId) openApp(item.appId);
                else if (item.action === "about") openApp("about");
                else if (item.action === "switchToDarwin") window.location.href = "/darwin/";
                else if (item.action === "switchToOs9") window.location.href = "/os9/";
              }}
            />
          );
        })}
      </>
    ),
  }));

  const topZ = state.windows.reduce((max, w) => Math.max(max, w.z), 0);
  const showClock = state.settings.showClock !== false;

  return (
    <>
      <MenuBar
        menus={menus}
        openMenuIndex={openMenu}
        onMenuOpen={setOpenMenu}
        onMenuClose={closeMenu}
        rightContent={
          showClock ? (
            <span style={{ fontSize: 12, padding: "0 8px" }}>
              {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          ) : null
        }
      />
      <div className="osish-desktop">
        <DesktopIcons />
        {state.windows.map((w) => {
          const app = appById(w.appId);
          if (!app) return null;
          return (
            <DraggableWindow
              key={w.id}
              id={w.id}
              title={w.title}
              x={w.x}
              y={w.y}
              width={w.width}
              height={w.height}
              z={w.z}
              active={w.z === topZ}
              onClose={() => closeWindow(w.id)}
            >
              {app.render()}
            </DraggableWindow>
          );
        })}
      </div>
    </>
  );
}

export default function App() {
  return (
    <OsProvider apps={APPS} settingSpecs={SETTING_SPECS}>
      <Shell />
    </OsProvider>
  );
}
