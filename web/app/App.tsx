import {
  AlertProvider,
  OverlayProvider,
  ToastProvider,
} from "@pikoloo/darwin-ui";
import { AppShell } from "../components/AppShell";
import Router from "./Router";

export default function App() {
  return (
    <OverlayProvider>
      <AlertProvider>
        <ToastProvider>
          <AppShell>
            <Router />
          </AppShell>
        </ToastProvider>
      </AlertProvider>
    </OverlayProvider>
  );
}
