import { TabPanel, Tabs } from "@liiift-studio/mac-os9-ui";
import { SettingsSection } from "../../os9/sections/SettingsSection";
import { SettingsApp } from "./SettingsApp";

/**
 * Settings is two tabs:
 *   - System: OS chrome (background, menu bar, UI prefs)
 *   - App:    ClawdCode configuration (model, security, timezone, repos, MCPs, user identity)
 */
export function SettingsAppHost() {
  return (
    <Tabs fullWidth>
      <TabPanel label="App">
        <SettingsApp sections={["preferences"]} />
        <SettingsSection maxHeight={600} bare panels={["general", "repos", "mcps"]} />
      </TabPanel>
      <TabPanel label="System">
        <SettingsApp hideDesktop sections={["menubar"]} />
        <SettingsSection maxHeight={600} bare panels={["desktop"]} />
      </TabPanel>
    </Tabs>
  );
}
