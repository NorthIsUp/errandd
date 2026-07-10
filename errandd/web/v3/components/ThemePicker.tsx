import { Check, Monitor, Palette } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "./ui/utils";

/**
 * v3 theme picker (spec §14). A curated set of 5 themes plus a "System" option
 * that follows `prefers-color-scheme` + `prefers-contrast` live. An explicit
 * choice is persisted under `errandd:v3:theme`; "System" clears it. The
 * before-paint default lives in index.html — this keeps it in sync at runtime.
 */

const THEMES = [
  { id: "abyssal", label: "Abyssal", hint: "dark" },
  { id: "tidepool", label: "Tidepool", hint: "light" },
  { id: "contrast-dark", label: "Contrast Dark", hint: "a11y" },
  { id: "contrast-light", label: "Contrast Light", hint: "a11y" },
  { id: "colorblind", label: "Colorblind", hint: "Okabe-Ito" },
] as const;
const VALID: string[] = THEMES.map((t) => t.id);
const KEY = "errandd:v3:theme";

function systemTheme(): string {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const more = matchMedia("(prefers-contrast: more)").matches;
  if (more) {
    return dark ? "contrast-dark" : "contrast-light";
  }
  return dark ? "abyssal" : "tidepool";
}

function applyTheme(id: string): void {
  document.documentElement.setAttribute("data-theme", id);
  const lightish = id === "tidepool" || id === "contrast-light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", lightish ? "#f4efe4" : "#101a1e");
}

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  // "system" when there's no explicit saved choice.
  const [choice, setChoice] = useState<string>(() => {
    try {
      const s = localStorage.getItem(KEY);
      return s && VALID.includes(s) ? s : "system";
    } catch {
      return "system";
    }
  });
  const ref = useRef<HTMLDivElement>(null);
  // The theme currently painted on <html>. Tracked in state (set inside the
  // effects/handlers that apply it) instead of read from the DOM during render,
  // which would be an impure read.
  const [appliedTheme, setAppliedTheme] = useState<string>(choice === "system" ? "" : choice);

  // Follow the OS live while in system mode.
  useEffect(() => {
    if (choice !== "system") {
      setAppliedTheme(choice);
      return;
    }
    const mqs = [
      matchMedia("(prefers-color-scheme: dark)"),
      matchMedia("(prefers-contrast: more)"),
    ];
    const onChange = () => {
      const t = systemTheme();
      applyTheme(t);
      setAppliedTheme(t);
    };
    onChange();
    for (const m of mqs) {
      m.addEventListener("change", onChange);
    }
    return () => {
      for (const m of mqs) {
        m.removeEventListener("change", onChange);
      }
    };
  }, [choice]);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = useCallback((id: string) => {
    if (id === "system") {
      try {
        localStorage.removeItem(KEY);
      } catch {
        // ignore
      }
      setChoice("system");
      const t = systemTheme();
      applyTheme(t);
      setAppliedTheme(t);
    } else {
      try {
        localStorage.setItem(KEY, id);
      } catch {
        // ignore
      }
      setChoice(id);
      applyTheme(id);
      setAppliedTheme(id);
    }
    setOpen(false);
  }, []);

  return (
    <div ref={ref} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        className="grid size-6 place-items-center rounded-md text-base-content/50 transition-colors hover:bg-base-200 hover:text-base-content"
      >
        <Palette className="size-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-52 overflow-hidden rounded-lg border border-base-300 bg-base-100 p-1 shadow-xl"
        >
          <Row
            icon={<Monitor className="size-3.5" />}
            label="System"
            hint="auto"
            selected={choice === "system"}
            onClick={() => pick("system")}
          />
          <div className="my-1 h-px bg-base-300/60" />
          {THEMES.map((t) => (
            <Row
              key={t.id}
              swatch={t.id}
              label={t.label}
              hint={t.hint}
              selected={choice === t.id}
              following={choice === "system" && appliedTheme === t.id}
              onClick={() => pick(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  hint,
  selected,
  following,
  onClick,
  swatch,
  icon,
}: {
  label: string;
  hint: string;
  selected: boolean;
  following?: boolean;
  onClick: () => void;
  swatch?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-base-200",
        selected && "bg-base-200",
      )}
    >
      {swatch ? (
        <span
          data-theme={swatch}
          className="flex shrink-0 gap-0.5 rounded bg-base-100 p-0.5 ring-1 ring-base-300"
        >
          <span className="size-2 rounded-full bg-primary" />
          <span className="size-2 rounded-full bg-secondary" />
          <span className="size-2 rounded-full bg-base-content/40" />
        </span>
      ) : (
        <span className="grid size-[18px] shrink-0 place-items-center text-base-content/60">
          {icon}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      <span className="font-mono text-[9px] text-base-content/40">{hint}</span>
      {(selected || following) && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}
