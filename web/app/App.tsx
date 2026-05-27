import {
  AlertProvider,
  OverlayProvider,
  ToastProvider,
} from "@pikoloo/darwin-ui";
import { useSystemTheme } from "../hooks/useSystemTheme";
import { useVantaFog } from "../hooks/useVantaFog";
import { Shell } from "./Shell";

export default function App() {
  useSystemTheme();
  useVantaFog();
  return (
    <OverlayProvider>
      <AlertProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </AlertProvider>
    </OverlayProvider>
  );
}
