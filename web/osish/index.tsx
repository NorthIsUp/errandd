import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@liiift-studio/mac-os9-ui/base";
import "@liiift-studio/mac-os9-ui/styles";
import App from "./App";
// Reuse the classic-os9 wallpaper applier so both UIs share the same
// preset/Vanta library and the same persisted background.
import { applyDesktopFromStorage } from "../os9/useDesktop";

applyDesktopFromStorage();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
