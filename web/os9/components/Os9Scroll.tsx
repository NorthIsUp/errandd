import { Scrollbar } from "@liiift-studio/mac-os9-ui";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface Os9ScrollProps {
  children: ReactNode;
  /** Container height (CSS string). Required so we know when content overflows. */
  height?: CSSProperties["height"];
  /** Max height (alternative to fixed height). */
  maxHeight?: CSSProperties["maxHeight"];
  className?: string;
  style?: CSSProperties;
}

/**
 * Wraps a scrollable region with an authentic Mac OS 9 vertical scrollbar.
 * The native browser scrollbar is hidden and replaced with the library's
 * Scrollbar, kept in sync via scroll events.
 */
export function Os9Scroll({
  children,
  height,
  maxHeight,
  className,
  style,
}: Os9ScrollProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);

  const recalc = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    setViewportRatio(
      el.scrollHeight > 0 ? Math.min(1, el.clientHeight / el.scrollHeight) : 1,
    );
    setPosition(scrollable > 0 ? el.scrollTop / scrollable : 0);
  }, []);

  useEffect(() => {
    recalc();
    const el = contentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    // Observe children too so dynamically-loaded content updates the ratio.
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [recalc]);

  const onScroll = useCallback(() => recalc(), [recalc]);

  const onScrollbarChange = useCallback((next: number) => {
    const el = contentRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    el.scrollTop = scrollable * next;
  }, []);

  const showScrollbar = viewportRatio < 1;

  return (
    <div
      className={className}
      style={{
        display: "flex",
        height,
        maxHeight,
        ...style,
      }}
    >
      <div
        ref={contentRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          // Hide native scrollbars in WebKit/Firefox so only the OS9 one shows.
          scrollbarWidth: "none",
        }}
      >
        <style>
          {`.os9-scroll-content::-webkit-scrollbar { display: none; }`}
        </style>
        <div className="os9-scroll-content">{children}</div>
      </div>
      {showScrollbar ? (
        <div style={{ width: 16, flexShrink: 0 }}>
          <Scrollbar
            orientation="vertical"
            value={position}
            viewportRatio={viewportRatio}
            onChange={onScrollbarChange}
          />
        </div>
      ) : null}
    </div>
  );
}
