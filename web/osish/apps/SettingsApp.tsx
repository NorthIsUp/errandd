import { Button, Checkbox, Select, TextField } from "@liiift-studio/mac-os9-ui";
import { type MenuConfig, type MenuItemConfig, useOs } from "../store";
import { WALLPAPER_PRESETS } from "../wallpaper";

export interface SettingsAppProps {
  /** Hide the osish-native "Desktop" panel — useful when a richer background
   *  picker is rendered alongside (e.g. the os9 SettingsSection.DesktopPanel
   *  inside SettingsAppHost). */
  hideDesktop?: boolean;
  /** Which osish sections to render. Defaults to all. */
  sections?: ("desktop" | "preferences" | "menubar")[];
}

export function SettingsApp({ hideDesktop, sections }: SettingsAppProps = {}) {
  const show = (k: "desktop" | "preferences" | "menubar") =>
    !sections || sections.includes(k);
  const { state, settingSpecs, setSetting, setWallpaper, setMenus, apps } = useOs();
  const wallpaper = state.wallpaper;

  const updateMenu = (idx: number, next: MenuConfig) => {
    setMenus(state.menus.map((m, i) => (i === idx ? next : m)));
  };
  const addMenuItem = (idx: number, item: MenuItemConfig) => {
    const m = state.menus[idx];
    if (!m) return;
    updateMenu(idx, { label: m.label, items: [...m.items, item] });
  };
  const removeMenuItem = (mIdx: number, iIdx: number) => {
    const m = state.menus[mIdx];
    if (!m) return;
    updateMenu(mIdx, { label: m.label, items: m.items.filter((_, i) => i !== iIdx) });
  };

  return (
    <div style={{ padding: 12, fontSize: 12, display: "flex", flexDirection: "column", gap: 16 }}>
      {hideDesktop || !show("desktop") ? null : <Section title="Desktop">
        <p style={{ margin: "0 0 6px", color: "#555" }}>Pick a wallpaper</p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, 88px)",
            gap: 8,
          }}
        >
          {WALLPAPER_PRESETS.map((p) => {
            const selected = p.url === wallpaper.url;
            return (
              <Button
                key={p.label}
                onClick={() => setWallpaper({ url: p.url, tile: p.tile })}
                variant={selected ? "primary" : "default"}
                aria-label={p.label}
                style={{
                  padding: 0,
                  width: 88,
                  height: 80,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    flex: 1,
                    background: p.url
                      ? `#6a7a8a url("${p.url}") ${p.tile ? "repeat" : "center / cover no-repeat"}`
                      : "#6a7a8a",
                    borderBottom: "1px solid #000",
                  }}
                />
                <span style={{ padding: 2, fontSize: 11, textAlign: "center" }}>
                  {p.label}
                </span>
              </Button>
            );
          })}
        </div>
        <Row label="Custom URL">
          <TextField
            value={wallpaper.url}
            onChange={(e) =>
              setWallpaper({ ...wallpaper, url: (e.target as HTMLInputElement).value })
            }
            placeholder="https://…"
            fullWidth
          />
        </Row>
        <Row label="Tile">
          <Checkbox
            checked={wallpaper.tile}
            onChange={(e) =>
              setWallpaper({ ...wallpaper, tile: (e.target as HTMLInputElement).checked })
            }
          />
        </Row>
      </Section>}

      {!show("preferences") ? null : <Section title="Preferences">
        {settingSpecs.map((spec) => {
          const val = state.settings[spec.key];
          return (
            <Row key={spec.key} label={spec.label}>
              {spec.type === "boolean" ? (
                <Checkbox
                  checked={!!val}
                  onChange={(e) =>
                    setSetting(spec.key, (e.target as HTMLInputElement).checked)
                  }
                />
              ) : spec.type === "select" ? (
                <Select
                  value={String(val)}
                  onChange={(e) => setSetting(spec.key, (e.target as HTMLSelectElement).value)}
                >
                  {spec.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : spec.type === "number" ? (
                <TextField
                  type="number"
                  value={String(val)}
                  onChange={(e) =>
                    setSetting(spec.key, Number((e.target as HTMLInputElement).value))
                  }
                />
              ) : (
                <TextField
                  value={String(val)}
                  onChange={(e) => setSetting(spec.key, (e.target as HTMLInputElement).value)}
                />
              )}
            </Row>
          );
        })}
      </Section>}

      {!show("menubar") ? null : <Section title="Menu Bar">
        {state.menus.map((menu, mIdx) => (
          <div
            key={mIdx}
            style={{ border: "1px solid #888", padding: 8, marginBottom: 8 }}
          >
            <Row label="Title">
              <TextField
                value={menu.label}
                onChange={(e) =>
                  updateMenu(mIdx, { label: (e.target as HTMLInputElement).value, items: menu.items })
                }
              />
            </Row>
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {menu.items.map((item, iIdx) => (
                <div key={iIdx} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <TextField
                    value={item.label}
                    onChange={(e) => {
                      const nextItems = [...menu.items];
                      nextItems[iIdx] = { ...item, label: (e.target as HTMLInputElement).value };
                      updateMenu(mIdx, { label: menu.label, items: nextItems });
                    }}
                  />
                  <Select
                    value={item.appId ?? ""}
                    onChange={(e) => {
                      const v = (e.target as HTMLSelectElement).value;
                      const nextItems = [...menu.items];
                      const next: MenuItemConfig = { label: item.label };
                      if (v) next.appId = v;
                      if (item.action) next.action = item.action;
                      if (item.separator) next.separator = item.separator;
                      nextItems[iIdx] = next;
                      updateMenu(mIdx, { label: menu.label, items: nextItems });
                    }}
                  >
                    <option value="">— action —</option>
                    {apps.map((a) => (
                      <option key={a.id} value={a.id}>
                        Open {a.title}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" onClick={() => removeMenuItem(mIdx, iIdx)}>
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                onClick={() => addMenuItem(mIdx, { label: "New Item" })}
              >
                + Item
              </Button>
            </div>
          </div>
        ))}
        <Button
          onClick={() => setMenus([...state.menus, { label: "New Menu", items: [] }])}
        >
          + Menu
        </Button>
      </Section>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 style={{ fontSize: 13, marginBottom: 6, borderBottom: "1px solid #888" }}>
        {title}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <label style={{ width: 110, color: "#333" }}>{label}</label>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
