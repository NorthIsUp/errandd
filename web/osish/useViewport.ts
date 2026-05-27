import { useEffect, useState } from "react";

const NARROW_BREAKPOINT = 640;

export interface Viewport {
  width: number;
  height: number;
  narrow: boolean;
}

function read(): Viewport {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return { width, height, narrow: width < NARROW_BREAKPOINT };
}

/** Reactive viewport size. Updates on resize. */
export function useViewport(): Viewport {
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const onResize = () => setVp(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vp;
}
