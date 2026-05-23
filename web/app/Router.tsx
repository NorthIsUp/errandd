import { useHash } from "../hooks/useHash";
import { ChatsSection } from "./sections/ChatsSection";
import { HomeSection } from "./sections/HomeSection";
import { JobsSection } from "./sections/JobsSection";
import { SettingsSection } from "./sections/SettingsSection";

/**
 * Router reads the URL hash via useHash() and renders the matching section
 * inside a SectionFrame.
 */
export default function Router() {
  const { section, file, repo } = useHash();

  switch (section) {
    case "home":
      return <HomeSection />;
    case "chats":
      return <ChatsSection />;
    case "jobs":
      return <JobsSection initialFile={file} initialRepo={repo} />;
    case "settings":
      return <SettingsSection />;
    default:
      return <HomeSection />;
  }
}
