import { Window } from "@liiift-studio/mac-os9-ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { LibScroll } from "./LibScroll";
import { useOs } from "./store";

const TITLE_BAR_H = 22;
/** Minimum strip of the titlebar that must remain inside the desktop on every
 *  edge — guarantees the window can always be grabbed back. */
const MIN_GRAB = 80;

function desktopBounds(): { width: number; height: number } {
  const el = document.querySelector(".osish-desktop");
  if (el) {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function clamp(x: number, y: number, width: number): { x: number; y: number } {
  // Coordinates are relative to .osish-desktop (the layer below the menu bar),
  // so y=0 means flush against the menu bar.
  const { width: dw, height: dh } = desktopBounds();
  const minX = -(width - MIN_GRAB);
  const maxX = dw - MIN_GRAB;
  const minY = 0;
  const maxY = Math.max(0, dh - TITLE_BAR_H);
  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}

interface Props {
  id: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  active: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function DraggableWindow({
  id,
  title,
  x,
  y,
  width,
  height,
  z,
  active,
  onClose,
  children,
}: Props) {
  const { moveWindow, focusWindow } = useOs();
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    setPos({ x, y });
  }, [x, y]);

  useEffect(() => {
    const onResize = () => {
      const c = clamp(pos.x, pos.y, width);
      if (c.x !== pos.x || c.y !== pos.y) moveWindow(id, c.x, c.y);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [id, pos.x, pos.y, width, moveWindow]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;
      // Drag only from the Window's own titlebar; ignore close/min/max controls.
      if (!t.closest(".osish-drag")) return;
      if (t.closest("button")) return;
      e.preventDefault();
      focusWindow(id);
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [id, pos.x, pos.y, focusWindow],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      setPos(clamp(e.clientX - d.dx, e.clientY - d.dy, width));
    },
    [width],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      moveWindow(id, pos.x, pos.y);
    },
    [id, pos.x, pos.y, moveWindow],
  );

  return (
    <div
      className="osish-win"
      style={{ left: pos.x, top: pos.y, width, zIndex: z }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseDown={() => focusWindow(id)}
    >
      <Window
        title={title}
        active={active}
        width={width}
        height={height}
        showControls
        onClose={onClose}
        classes={{ titleBar: "osish-drag", content: "osish-content" }}
      >
        <LibScroll>{children}</LibScroll>
      </Window>
    </div>
  );
}
