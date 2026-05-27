import { type CSSProperties, useState } from "react";

interface IconProps {
  /** Filename under /os9/icons/ — e.g. "folder.png". */
  src: string;
  /** Unicode/emoji to render if the file is missing. */
  fallback: string;
  /** Pixel size (square). Defaults to 16. */
  size?: number;
}

/**
 * Renders a small image from /os9/icons/<src> (user-supplied, gitignored).
 * If the file isn't present the browser fires onError and we swap to a
 * unicode/emoji fallback so the row still has a glyph.
 */
export function Icon({ src, fallback, size = 16 }: IconProps) {
  const [broken, setBroken] = useState(false);
  const style: CSSProperties = {
    width: size,
    height: size,
    display: "inline-block",
    verticalAlign: "middle",
    objectFit: "contain",
  };
  if (broken) {
    return (
      <span
        style={{ fontSize: size - 2, lineHeight: `${size}px` }}
        aria-hidden
      >
        {fallback}
      </span>
    );
  }
  return (
    <img
      src={`/os9/icons/${src}`}
      alt=""
      aria-hidden
      style={style}
      onError={() => setBroken(true)}
    />
  );
}
