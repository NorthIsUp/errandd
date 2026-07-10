import { CircleHelp, Cog, MessagesSquare, Webhook, Workflow } from "lucide-react";
import type { ComponentType } from "react";
import type { V3View } from "./router";

/**
 * Bottom-nav items shown in the sidebar footer. Lives next to its only
 * consumer (`components/Sidebar`) instead of in App.tsx, so Sidebar and App no
 * longer import from each other.
 */
export const BOTTOM_NAV: {
  view: V3View;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}[] = [
  { view: "chat", label: "Chat", Icon: MessagesSquare },
  { view: "deliveries", label: "Hooks", Icon: Webhook },
  { view: "routines", label: "Errands", Icon: Workflow },
  { view: "settings", label: "Settings", Icon: Cog },
  { view: "about", label: "About", Icon: CircleHelp },
];
