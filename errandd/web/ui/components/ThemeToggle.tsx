import { Monitor, Moon, Sun } from "lucide-react";
import type React from "react";
import { setMode, useThemeState } from "../theme";

export function ThemeToggle() {
  const { mode } = useThemeState();

  const ActiveIcon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
  const label = mode === "light" ? "Light theme" : mode === "dark" ? "Dark theme" : "System theme";

  return (
    <div className="dropdown dropdown-end">
      <button
        type="button"
        tabIndex={0}
        className="btn btn-ghost btn-sm btn-square"
        aria-label={label}
        title={label}
      >
        <ActiveIcon size={18} />
      </button>
      <ul className="dropdown-content menu bg-base-100 rounded-box z-50 mt-2 w-40 p-1 shadow-lg border border-base-300">
        <Item
          icon={<Sun size={16} />}
          label="Light"
          active={mode === "light"}
          onClick={() => setMode("light")}
        />
        <Item
          icon={<Moon size={16} />}
          label="Dark"
          active={mode === "dark"}
          onClick={() => setMode("dark")}
        />
        <Item
          icon={<Monitor size={16} />}
          label="System"
          active={mode === "system"}
          onClick={() => setMode("system")}
        />
      </ul>
    </div>
  );
}

function Item({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={active ? "menu-active flex items-center gap-2" : "flex items-center gap-2"}
      >
        {icon}
        <span>{label}</span>
      </button>
    </li>
  );
}
