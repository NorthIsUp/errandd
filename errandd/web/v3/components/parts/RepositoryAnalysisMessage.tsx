import { Bot } from "lucide-react";
import { CopyButton } from "../../../components/CopyButton";
import { InfoCard, SYSTEM_PALETTE } from "./InfoCard";

/** In-context evidence uses the same system-card shell as hook notifications. */
export function RepositoryAnalysisMessage({ text, at }: { text: string; at?: number }) {
  return <InfoCard text={text} {...(at == null ? {} : { at })} presentation="document"
    label="Repository pre-analysis" header="Errandd · system context · preliminary lockfile analysis"
    palette={SYSTEM_PALETTE} icon={<Bot className="size-4" aria-hidden="true" />}
    actions={<CopyButton text={text} label="repository pre-analysis" />} />;
}
