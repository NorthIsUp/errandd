import { useEffect, useRef } from "react";
import type { VantaEffect, VantaOptions } from "../useDesktop";

interface Props {
  effect: VantaEffect;
  options: VantaOptions;
  width: number;
  height: number;
}

/**
 * A tiny Vanta canvas, mounted only while the picker is visible. Each preview
 * spins up its own WebGL context — keep the count and size small.
 */
export function VantaPreview({ effect, options, width, height }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vanta = (
      window as unknown as {
        VANTA?: Record<
          string,
          (o: Record<string, unknown>) => { destroy: () => void }
        >;
      }
    ).VANTA;
    if (!vanta) return;
    const effectKey = effect.charAt(0).toUpperCase() + effect.slice(1);
    const factory = vanta[effectKey] ?? vanta[effect];
    if (!factory) return;
    let instance: { destroy: () => void } | null = null;
    try {
      instance = factory({
        el,
        mouseControls: false,
        touchControls: false,
        gyroControls: false,
        minHeight: 1,
        minWidth: 1,
        ...options,
      });
    } catch {
      // ignore — preview just renders empty
    }
    return () => {
      try {
        instance?.destroy();
      } catch {
        // ignore
      }
    };
  }, [effect, options]);

  return (
    <div
      ref={ref}
      style={{
        width,
        height,
        overflow: "hidden",
        position: "relative",
      }}
    />
  );
}
