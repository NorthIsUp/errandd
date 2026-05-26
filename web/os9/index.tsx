import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@liiift-studio/mac-os9-ui/base";
import "@liiift-studio/mac-os9-ui/styles";
import App from "./App";
import { applyDesktopFromStorage } from "./useDesktop";

// Paint persisted wallpaper before React mounts so there's no default flash.
applyDesktopFromStorage();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
