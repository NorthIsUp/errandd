import { Scrollbar } from "@liiift-studio/mac-os9-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Scrollable container that uses the lib's Scrollbar component instead of
 * native browser scrollbars. Fills its parent.
 */
export function LibScroll({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [contentH, setContentH] = useState(0);

  useEffect(() => {
    if (!viewportRef.current || !contentRef.current) return;
    const ro = new ResizeObserver(() => {
      if (viewportRef.current) setViewportH(viewportRef.current.clientHeight);
      if (contentRef.current) setContentH(contentRef.current.scrollHeight);
    });
    ro.observe(viewportRef.current);
    ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, []);

  const maxScroll = Math.max(0, contentH - viewportH);
  // Clamp scrollTop if content shrinks.
  useEffect(() => {
    if (scrollTop > maxScroll) setScrollTop(maxScroll);
  }, [scrollTop, maxScroll]);

  const value = maxScroll === 0 ? 0 : scrollTop / maxScroll;
  const viewportRatio = contentH === 0 ? 1 : Math.min(1, viewportH / contentH);
  const needsBar = viewportRatio < 1;

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", overflow: "hidden" }}>
      <div
        ref={viewportRef}
        style={{ flex: 1, overflow: "hidden", position: "relative" }}
        onWheel={(e) => {
          if (!needsBar) return;
          setScrollTop((s) => Math.max(0, Math.min(maxScroll, s + e.deltaY)));
        }}
      >
        <div
          ref={contentRef}
          style={{ transform: `translateY(${-scrollTop}px)`, willChange: "transform" }}
        >
          {children}
        </div>
      </div>
      {needsBar ? (
        <div style={{ width: 16, flexShrink: 0, height: "100%" }}>
          <Scrollbar
            orientation="vertical"
            value={value}
            viewportRatio={viewportRatio}
            onChange={(v) => setScrollTop(v * maxScroll)}
            className="osish-scrollbar"
          />
        </div>
      ) : null}
    </div>
  );
}
