import { EmptyState } from "../components/EmptyState";
import { SectionFrame } from "../components/SectionFrame";
import { useHash } from "../hooks/useHash";
import { HomeSection } from "./sections/HomeSection";

function Placeholder({ name }: { name: string }) {
  return (
    <SectionFrame title={name}>
      <EmptyState message={`${name} — Phase N will fill this in.`} />
    </SectionFrame>
  );
}

/**
 * Router reads the URL hash via useHash() and renders the matching section
 * inside a SectionFrame. Phases 5–8 will replace the placeholder bodies with
 * real section components.
 */
export default function Router() {
  const { section } = useHash();

  switch (section) {
    case "home":
      return <HomeSection />;
    case "chats":
      return <Placeholder name="Chats" />;
    case "jobs":
      return <Placeholder name="Jobs" />;
    case "settings":
      return <Placeholder name="Settings" />;
    default:
      return <HomeSection />;
  }
}
