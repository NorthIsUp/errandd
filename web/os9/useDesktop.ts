import { useCallback, useEffect, useState } from "react";

const BG_KEY = "clawd.desktop.v2";
const FALLBACK_BG = "#999";

// ---------------------------------------------------------------------------
// Background model
// ---------------------------------------------------------------------------

export type VantaEffect =
  | "fog"
  | "net"
  | "rings"
  | "waves"
  | "trunk"
  | "halo"
  | "topology";

// Vanta accepts a grab-bag of effect-specific options. Keep this loose; the
// preset catalog hard-codes valid combinations.
export type VantaOptions = Record<string, unknown>;

export type Background =
  | { kind: "image"; url: string; tile: boolean }
  | { kind: "vanta"; effect: VantaEffect; options: VantaOptions };

interface VantaInstance {
  destroy: () => void;
}

type VantaFactory = (opts: Record<string, unknown>) => VantaInstance;

function getVantaFactory(effect: string): VantaFactory | undefined {
  const vanta = (window as unknown as { VANTA?: Record<string, VantaFactory> })
    .VANTA;
  if (!vanta) return undefined;
  const effectKey = effect.charAt(0).toUpperCase() + effect.slice(1);
  return vanta[effectKey] ?? vanta[effect];
}

// ---------------------------------------------------------------------------
// Preset catalog
// ---------------------------------------------------------------------------

export interface BackgroundPreset {
  label: string;
  bg: Background;
  /** Optional swatch hint for CSS-pattern previews. */
  swatchBg?: string;
}

// Tiny CSS patterns drawn from scratch — no copyrighted artwork. URL-encoded
// because modern browsers (Safari/Chrome) reject SVG data URIs with raw `<`,
// `"`, and `#` characters — the result is a "white tile" with no image.
const svgUri = (svg: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const checkerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16" fill="#999"/><rect width="8" height="8" fill="#888"/><rect x="8" y="8" width="8" height="8" fill="#888"/></svg>`;
const dotsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" fill="#999"/><circle cx="6" cy="6" r="1.5" fill="#777"/></svg>`;
const stippleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" viewBox="0 0 4 4"><rect width="4" height="4" fill="#a0a0a0"/><rect width="1" height="1" fill="#808080"/><rect x="2" y="2" width="1" height="1" fill="#808080"/></svg>`;
const linesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><rect width="8" height="8" fill="#999"/><path d="M 0 8 L 8 0" stroke="#777" stroke-width="1"/></svg>`;

// Classic Mac OS wallpapers — linked, not bundled. Apple's images.
const OSXDAILY_BASE =
  "https://cdn.osxdaily.com/wp-content/uploads/2017/12/classic-mac-os-tile-wallpapers";

function img(label: string, url: string, tile = true): BackgroundPreset {
  return { label, bg: { kind: "image", url, tile } };
}

/**
 * Build a preset from a classic-Mac PAT (8×8 monochrome pattern). Input is
 * 16 hex chars = 8 bytes, one per row, MSB = leftmost pixel.
 *
 * Pattern bytes are sourced from the Mac OS 9 system PAT# resource — see
 * https://www.pauladamsmith.com/blog/2025/09/classic-mac-patterns.html
 */
function pat(label: string, hex: string): BackgroundPreset {
  // Scale up 4× so the pattern is visible on hi-DPI displays — classic Mac
  // PAT was native 8×8 at 72dpi, which is microscopic on modern screens.
  const S = 4;
  const rects: string[] = [];
  for (let y = 0; y < 8; y++) {
    const b = parseInt(hex.slice(y * 2, y * 2 + 2), 16);
    for (let x = 0; x < 8; x++) {
      if (b & (0x80 >> x))
        rects.push(`<rect x="${x * S}" y="${y * S}" width="${S}" height="${S}"/>`);
    }
  }
  const D = 8 * S;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${D}" height="${D}" shape-rendering="crispEdges">` +
    `<rect width="${D}" height="${D}" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
  return img(label, `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, true);
}

// 38 patterns from the system PAT# resource (id 0).
const SYSTEM_PATTERNS: BackgroundPreset[] = [
  ["Solid Black", "FFFFFFFFFFFFFFFF"],
  ["Dark Gray", "DDFF77FFDDFF77FF"],
  ["Medium Gray", "DD77DD77DD77DD77"],
  ["50% Gray", "AA55AA55AA55AA55"],
  ["Light Gray", "55FF55FF55FF55FF"],
  ["50% Diag", "AAAAAAAAAAAAAAAA"],
  ["Hatch", "EEDDBB77EEDDBB77"],
  ["Vert Lines", "8888888888888888"],
  ["Knit", "B130031BD8C00C8D"],
  ["Scatter", "8010022001084004"],
  ["Bricks", "FF888888FF888888"],
  ["Cross", "FF808080FF080808"],
  ["Dot 1", "8000000000000000"],
  ["Sparse", "8040200002040800"],
  ["Triangle", "8244394482010101"],
  ["Stars", "F87422478F172271"],
  ["Confetti", "55A04040550A0404"],
  ["Pop", "2050888888880502"],
  ["Stipple", "BF00BFBFB0B0B0B0"],
  ["Solid White", "0000000000000000"],
  ["Mini Dots", "8000080080000800"],
  ["Big Dots", "8800220088002200"],
  ["Diag Dots", "8822882288228822"],
  ["Horizontal", "AA00AA00AA00AA00"],
  ["H Lines", "FF00FF00FF00FF00"],
  ["Bricks 2", "1122448811224488"],
  ["Thin H", "FF000000FF000000"],
  ["Diag Lines", "0102040810204080"],
  ["Dot Lines", "AA00800088008000"],
  ["L Pattern", "FF80808080808080"],
  ["Diamond", "081C22C180010204"],
  ["Snake", "8814224188002200"],
  ["Sparse Dot", "40A00000040A0000"],
  ["Tiny Hatch", "0384483030020101"],
  ["Bee", "8080413E080814E3"],
  ["Web", "102054AAFF020408"],
  ["Plaid", "77898F8F7798F8F8"],
  ["Star Field", "0008142A552A1408"],
].map(([label, hex]) => pat(label as string, hex as string));
function vanta(
  label: string,
  effect: VantaEffect,
  options: VantaOptions,
): BackgroundPreset {
  return { label, bg: { kind: "vanta", effect, options } };
}

export const DESKTOP_PRESETS: BackgroundPreset[] = [
  img("Default Grey", "", false),
  // CSS patterns
  img("Checker", svgUri(checkerSvg), true),
  img("Dots", svgUri(dotsSvg), true),
  img("Stipple", svgUri(stippleSvg), true),
  img("Diagonal Lines", svgUri(linesSvg), true),
  // Classic Mac OS system patterns (PAT# resource).
  ...SYSTEM_PATTERNS,
  // Classic Mac wallpapers
  img("Classic 1", `${OSXDAILY_BASE}-1.png`),
  img("Classic 2", `${OSXDAILY_BASE}-2.png`),
  img("Classic 3", `${OSXDAILY_BASE}-3.png`),
  img("Classic 4", `${OSXDAILY_BASE}-4.png`),
  img("Classic 5", `${OSXDAILY_BASE}-5.png`),
  img("Classic 6", `${OSXDAILY_BASE}-6.png`),
  img("Classic 7", `${OSXDAILY_BASE}-7.png`),
  img("Classic 8", `${OSXDAILY_BASE}-8.png`),
  img("Classic 9", `${OSXDAILY_BASE}-9.png`),
  // Vanta animated backgrounds — one per effect from the user's list.
  vanta("Fog", "fog", {
    highlightColor: 0xffd700,
    midtoneColor: 0xff2d00,
    lowlightColor: 0x2d00ff,
    baseColor: 0xffe6eb,
    blurFactor: 0.57,
    speed: 1,
    zoom: 0.7,
  }),
  vanta("Net", "net", {
    color: 0x3b82f6,
    backgroundColor: 0x0a0a1a,
    speed: 1.2,
  }),
  vanta("Rings", "rings", {
    color: 0x88ccff,
    backgroundColor: 0x101020,
  }),
  vanta("Waves", "waves", {
    color: 0x205080,
    shininess: 35,
    waveHeight: 14,
    waveSpeed: 0.6,
  } as VantaOptions),
  vanta("Trunk", "trunk", {
    color: 0x9b59b6,
    backgroundColor: 0x101020,
    spacing: 0,
    chaos: 1,
  } as VantaOptions),
  vanta("Halo", "halo", {
    baseColor: 0x1e1bd1,
    backgroundColor: 0x131a43,
    amplitudeFactor: 1.2,
    size: 1.5,
  } as VantaOptions),
  vanta("Topology", "topology", {
    color: 0x39ff14,
    backgroundColor: 0x002200,
  }),
];

// ---------------------------------------------------------------------------
// Apply / persist
// ---------------------------------------------------------------------------

let currentVanta: VantaInstance | null = null;

function destroyVanta(): void {
  try {
    currentVanta?.destroy();
  } catch {
    // ignore
  }
  currentVanta = null;
  const bg = document.getElementById("vanta-bg");
  if (bg) bg.style.display = "none";
}

function applyBackground(bg: Background): void {
  destroyVanta();
  const body = document.body;
  if (bg.kind === "image") {
    if (!bg.url) {
      body.style.background = FALLBACK_BG;
      return;
    }
    body.style.background = `${FALLBACK_BG} url("${bg.url}") ${
      bg.tile ? "repeat" : "center / cover no-repeat"
    }`;
    return;
  }
  // Vanta: clear body background so the canvas shows through.
  body.style.background = "transparent";
  const el = document.getElementById("vanta-bg");
  if (!el) return;
  el.style.display = "block";
  const factory = getVantaFactory(bg.effect);
  if (!factory) {
    console.warn(`Vanta.${bg.effect} not loaded`);
    return;
  }
  try {
    currentVanta = factory({
      el: "#vanta-bg",
      mouseControls: true,
      touchControls: true,
      gyroControls: false,
      minHeight: 200,
      minWidth: 200,
      ...bg.options,
    });
  } catch (err) {
    console.warn(`Vanta.${bg.effect} init failed:`, err);
  }
}

function readStored(): Background {
  try {
    const raw = localStorage.getItem(BG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Background;
      if (parsed.kind === "image" || parsed.kind === "vanta") return parsed;
    }
  } catch {
    // ignore
  }
  return { kind: "image", url: "", tile: false };
}

function write(bg: Background): void {
  try {
    localStorage.setItem(BG_KEY, JSON.stringify(bg));
  } catch {
    // ignore
  }
}

export function applyDesktopFromStorage(): void {
  applyBackground(readStored());
}

// ---------------------------------------------------------------------------
// Hook for the Settings UI
// ---------------------------------------------------------------------------

export function useDesktop() {
  const [bg, setBgState] = useState<Background>(readStored);

  useEffect(() => {
    applyBackground(bg);
  }, [bg]);

  const setBg = useCallback((next: Background) => {
    write(next);
    setBgState(next);
  }, []);

  // Helpers for the URL/tile UI bits.
  const url = bg.kind === "image" ? bg.url : "";
  const tile = bg.kind === "image" ? bg.tile : false;
  const setUrl = useCallback(
    (next: string) => {
      setBg({ kind: "image", url: next, tile });
    },
    [setBg, tile],
  );
  const setTile = useCallback(
    (next: boolean) => {
      if (bg.kind === "image") setBg({ kind: "image", url: bg.url, tile: next });
    },
    [bg, setBg],
  );

  function presetMatches(preset: BackgroundPreset): boolean {
    if (preset.bg.kind !== bg.kind) return false;
    if (preset.bg.kind === "image" && bg.kind === "image") {
      return preset.bg.url === bg.url;
    }
    if (preset.bg.kind === "vanta" && bg.kind === "vanta") {
      return preset.bg.effect === bg.effect;
    }
    return false;
  }

  return { bg, setBg, url, tile, setUrl, setTile, presetMatches };
}
