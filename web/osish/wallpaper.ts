const KEY = "osish.wallpaper";
const TILE_KEY = "osish.wallpaper.tile";
const FALLBACK = "#6a7a8a";

export interface Wallpaper {
  url: string;
  tile: boolean;
}

export const WALLPAPER_PRESETS: { label: string; url: string; tile: boolean }[] = [
  { label: "Default", url: "", tile: false },
  {
    label: "Checker",
    url: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#6a7a8a"/><rect width="8" height="8" fill="#5a6a7a"/><rect x="8" y="8" width="8" height="8" fill="#5a6a7a"/></svg>`,
    )}`,
    tile: true,
  },
  {
    label: "Dots",
    url: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" fill="#7a8a9a"/><circle cx="6" cy="6" r="1.5" fill="#566876"/></svg>`,
    )}`,
    tile: true,
  },
  {
    label: "Stipple",
    url: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#909c9c"/><rect width="1" height="1" fill="#707878"/><rect x="2" y="2" width="1" height="1" fill="#707878"/></svg>`,
    )}`,
    tile: true,
  },
];

export function apply({ url, tile }: Wallpaper): void {
  const body = document.body;
  if (!url) {
    body.style.background = FALLBACK;
    return;
  }
  body.style.background = `${FALLBACK} url("${url}") ${tile ? "repeat" : "center / cover no-repeat"}`;
}

export function read(): Wallpaper {
  try {
    return {
      url: localStorage.getItem(KEY) ?? "",
      tile: (localStorage.getItem(TILE_KEY) ?? "1") !== "0",
    };
  } catch {
    return { url: "", tile: true };
  }
}

export function write(w: Wallpaper): void {
  try {
    localStorage.setItem(KEY, w.url);
    localStorage.setItem(TILE_KEY, w.tile ? "1" : "0");
  } catch {
    // ignore
  }
}

export function applyWallpaperFromStorage(): void {
  apply(read());
}
