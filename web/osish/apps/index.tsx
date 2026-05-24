import type { AppDef, SettingSpec } from "../store";
import { AboutApp } from "./AboutApp";
import { ChatsAppHost } from "./ChatsAppHost";
import { FilesApp } from "./FilesApp";
import { JobsAppHost } from "./JobsAppHost";
import { SettingsAppHost } from "./SettingsAppHost";

export const APPS: AppDef[] = [
  {
    id: "settings",
    title: "Settings",
    defaultWidth: 520,
    defaultHeight: 560,
    render: () => <SettingsAppHost />,
  },
  {
    id: "chats",
    title: "Chats",
    defaultWidth: 520,
    defaultHeight: 560,
    render: () => <ChatsAppHost />,
  },
  {
    id: "jobs",
    title: "Jobs",
    defaultWidth: 640,
    defaultHeight: 560,
    render: () => <JobsAppHost />,
  },
  {
    id: "files",
    title: "Files",
    defaultWidth: 380,
    defaultHeight: 280,
    render: () => <FilesApp />,
  },
  {
    id: "about",
    title: "About osish",
    defaultWidth: 320,
    defaultHeight: 200,
    render: () => <AboutApp />,
  },
];

export const SETTING_SPECS: SettingSpec[] = [
  { key: "username", label: "Display name", type: "string", default: "Adam" },
  { key: "showClock", label: "Show clock", type: "boolean", default: true },
  {
    key: "accent",
    label: "Accent",
    type: "select",
    default: "blue",
    options: [
      { value: "blue", label: "Blue" },
      { value: "graphite", label: "Graphite" },
      { value: "platinum", label: "Platinum" },
    ],
  },
];
