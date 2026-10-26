import { SettingsField, SettingsPanel } from "./parts";
export function TicketingPanel({ team, project, onTeamChange, onProjectChange }: {
  team: string; project: string; onTeamChange: (value: string) => void; onProjectChange: (value: string) => void;
}) {
  return <SettingsPanel title="Security ticket destination" description="Where CVE errands create and update tracking issues. This is separate from receiving Linear webhook events.">
    <SettingsField label="Linear team / group" hint="Team key, name or UUID, such as CLA. Enter the security team's identifier if your workspace has one.">
      {id => <input id={id} value={team} maxLength={200} placeholder="Team key, name or UUID" onChange={event => onTeamChange(event.target.value)} />}
    </SettingsField>
    <SettingsField label="Ticket project ID or slug" hint="Optional project within that team, such as Security. Leave blank to create issues directly in the configured team.">
      {id => <input id={id} value={project} maxLength={200} placeholder="Optional project ID or slug" onChange={event => onProjectChange(event.target.value)} />}
    </SettingsField>
  </SettingsPanel>;
}
