import { ListView } from "@liiift-studio/mac-os9-ui";
import { useState } from "react";
import { useOs } from "../store";

const ITEMS = [
  { id: "settings", name: "Settings", kind: "app", appId: "settings" },
  { id: "notes", name: "Notes", kind: "app", appId: "notes" },
  { id: "about", name: "About", kind: "app", appId: "about" },
  { id: "readme", name: "README.txt", kind: "doc" },
];

export function FilesApp() {
  const { openApp } = useOs();
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <ListView
      items={ITEMS.map((i) => ({
        id: i.id,
        name: i.name,
        modified: "—",
        size: i.kind === "app" ? "—" : "1 KB",
      }))}
      columns={[
        { key: "name", label: "Name" },
        { key: "modified", label: "Date Modified" },
        { key: "size", label: "Size" },
      ]}
      selectedIds={selected}
      onSelectionChange={setSelected}
      onItemOpen={(item) => {
        const it = ITEMS.find((x) => x.id === item.id);
        if (it?.kind === "app" && it.appId) openApp(it.appId);
      }}
    />
  );
}
