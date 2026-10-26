import { SettingsField, SettingsPanel } from "./parts";
export function TicketingPanel({ url, onChange, legacyConfigured }: {
  url: string; onChange: (value: string) => void; legacyConfigured?: boolean;
}) {
  return <SettingsPanel title="Security issue tracking" description="Where CVE errands create and update tracking issues.">
    <SettingsField label="Project tracker URL for security issues" hint="Paste a project, board or repository issues URL. The agent uses the URL to identify the tracker and destination.">
      {id => <input id={id} type="url" value={url} maxLength={2048} placeholder="https://tracker.example.com/project/security" onChange={event => onChange(event.target.value)} />}
    </SettingsField>
    {legacyConfigured && <p className="settings-hint">Previously saved destination identifiers are preserved. Enter a project tracker URL to replace them.</p>}
  </SettingsPanel>;
}
