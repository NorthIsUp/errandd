import { useEffect } from "react";

interface VantaEffect {
  destroy: () => void;
}

interface VantaFogOptions {
  el: HTMLElement | string;
  mouseControls?: boolean;
  touchControls?: boolean;
  gyroControls?: boolean;
  minHeight?: number;
  minWidth?: number;
  highlightColor?: number;
  midtoneColor?: number;
  lowlightColor?: number;
  baseColor?: number;
  blurFactor?: number;
  speed?: number;
  zoom?: number;
}

declare global {
  interface Window {
    VANTA?: {
      FOG: (opts: VantaFogOptions) => VantaEffect;
    };
  }
}

/**
 * Build a randomly-tinted triplet of harmonious colors for a Vanta fog scene.
 * Picks a base hue, then derives complementary highlight / midtone / lowlight.
 */
function randomFogColors(dark: boolean): {
  highlight: number;
  midtone: number;
  lowlight: number;
} {
  const baseHue = Math.floor(Math.random() * 360);
  const sat = 45;
  const highL = dark ? 55 : 78;
  const midL = dark ? 38 : 62;
  const lowL = dark ? 14 : 92;
  return {
    highlight: hslToHex(baseHue, sat, highL),
    midtone: hslToHex((baseHue + 200) % 360, sat, midL),
    lowlight: hslToHex((baseHue + 60) % 360, 20, lowL),
  };
}

function hslToHex(h: number, s: number, l: number): number {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) =>
    Math.round(
      255 * (lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))),
    );
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/**
 * Initialises a Vanta.FOG background on #vanta-bg, with colors that re-randomise
 * on each page load and re-init when the OS color scheme changes.
 */
export function useVantaFog(): void {
  useEffect(() => {
    const el = document.getElementById("vanta-bg");
    if (!el || !window.VANTA?.FOG) return;

    let effect: VantaEffect | null = null;

    function init() {
      try {
        effect?.destroy();
      } catch {
        // ignore
      }
      const dark = document.documentElement.classList.contains("dark");
      const c = randomFogColors(dark);
      try {
        effect = window.VANTA!.FOG({
          el: "#vanta-bg",
          mouseControls: true,
          touchControls: true,
          gyroControls: false,
          minHeight: 200,
          minWidth: 200,
          highlightColor: c.highlight,
          midtoneColor: c.midtone,
          lowlightColor: c.lowlight,
          blurFactor: 0.6,
          speed: 0.5,
          zoom: 0.3,
        });
      } catch (err) {
        // WebGL unavailable (headless browser, blocked GPU) — fail soft.
        console.warn("Vanta fog disabled:", err);
        effect = null;
      }
    }

    init();

    // Re-init when system theme flips so the palette adapts to dark / light.
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    let schemeTimer: ReturnType<typeof setTimeout> | undefined;
    const onSchemeChange = () => {
      // Defer one tick so the `dark` class toggle in useSystemTheme has applied.
      schemeTimer = setTimeout(init, 0);
    };
    mq.addEventListener("change", onSchemeChange);

    return () => {
      clearTimeout(schemeTimer);
      mq.removeEventListener("change", onSchemeChange);
      effect?.destroy();
    };
  }, []);
}
