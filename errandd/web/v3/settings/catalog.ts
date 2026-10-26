import { BookOpen, Bot, Clock3, Radio, Shield, Wrench } from "lucide-react";
export const SETTINGS_GROUPS = [
  { id: "agent", label: "Agent", hint: "Runtime, model, fallback, permissions, ticket project", icon: Bot },
  {
    id: "events",
    label: "Event sources",
    hint: "Webhook, poll, RSS, CVE, GitHub, Sentry, Datadog, Linear, security tickets",
    icon: Radio,
  },
  {
    id: "libraries",
    label: "Errand libraries",
    hint: "Repositories, definitions and references",
    icon: BookOpen,
  },
  { id: "tools", label: "Tools & plugins", hint: "MCP, plugins, extensions", icon: Wrench },
  {
    id: "timing",
    label: "Timing & notifications",
    hint: "Timezone, heartbeat, quiet hours, Telegram, Discord",
    icon: Clock3,
  },
  {
    id: "access",
    label: "Access & appearance",
    hint: "Tailnet, Git identity and theme",
    icon: Shield,
  },
] as const;
export function settingsGroup(segment: string | undefined): string {
  const aliases: Record<string, string> = {
    model: "agent",
    sources: "libraries",
    mcp: "tools",
    hooks: "events",
    git: "access",
    heartbeat: "timing",
    appearance: "access",
  };
  const group = segment ? (aliases[segment] ?? segment) : "events";
  return SETTINGS_GROUPS.some((item) => item.id === group) ? group : "events";
}
