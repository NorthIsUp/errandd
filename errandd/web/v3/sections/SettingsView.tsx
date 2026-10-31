import { TicketingPanel } from "../settings/TicketingPanel";
import { ArrowRight, Check, Search, Settings, Shield, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { defaultCveConnection, type CveConnection } from "../../../shared/eventSources";
import { getEventSources, saveCveSource } from "../../api/eventSources";
import {
  getHeartbeatSettings,
  updateHeartbeatSettings,
  updateSettings,
  type HeartbeatSettings,
} from "../../api/settings";
import { getState } from "../../api/state";
import { ReposPanel } from "../../ui/sections/SettingsSection";
import { useAsync } from "../../ui/useAsync";
import type { MainPaneProps } from "../App";
import { ThemePicker } from "../components/ThemePicker";
import { useRoute } from "../router";
import { SETTINGS_GROUPS, settingsGroup } from "../settings/catalog";
import { EventSourcesPanel } from "../settings/EventSourcesPanel";
import { ToolsPanel } from "../settings/ToolsPanel";
import { SettingsBadge, SettingsField, SettingsPanel, SettingsRow } from "../settings/parts";
import "../settings/settings.css";

interface GeneralPatch {
  model?: string;
  fallback?: string;
  ultracode?: boolean;
  migrateLegacyClawLabels?: boolean;
  timezone?: string;
  securityIssueTrackerUrl?: string;
  security?: { level: string };
  git?: { name: string; email: string };
}
let preservedDraft: {
  general: GeneralPatch;
  heartbeat: Partial<HeartbeatSettings>;
  cve: CveConnection | null;
} = { general: {}, heartbeat: {}, cve: null };
export function SettingsView(_props: MainPaneProps) {
  const { route, goto } = useRoute();
  const group = settingsGroup(route.segments[0]);
  const state = useAsync(getState),
    sources = useAsync(getEventSources),
    heartbeat = useAsync(getHeartbeatSettings);
  const [search, setSearch] = useState("");
  const [general, setGeneral] = useState<GeneralPatch>(preservedDraft.general),
    [heartbeatPatch, setHeartbeatPatch] = useState<Partial<HeartbeatSettings>>(
      preservedDraft.heartbeat,
    ),
    [cveDraft, setCveDraft] = useState<CveConnection | null>(preservedDraft.cve);
  const [review, setReview] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    preservedDraft = { general, heartbeat: heartbeatPatch, cve: cveDraft };
  }, [general, heartbeatPatch, cveDraft]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (review) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [review]);
  const dirty =
    Object.keys(general).length + Object.keys(heartbeatPatch).length + (cveDraft ? 1 : 0);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);
  const current = state.data;
  function navigate(id: string, sub?: string) {
    goto("settings", [id, ...(sub ? [sub] : [])]);
    setSearch("");
  }
  function edit<K extends keyof GeneralPatch>(key: K, value: GeneralPatch[K]) {
    if (!current) return;
    const baseline =
      key === "fallback"
        ? typeof current.fallback === "string"
          ? current.fallback
          : current.fallback.model
        : key === "git"
          ? { name: current.git.name, email: current.git.email }
          : key === "security"
            ? { level: current.security.level }
            : current[key];
    setGeneral((previous) => {
      const next = { ...previous };
      if (JSON.stringify(value) === JSON.stringify(baseline)) delete next[key];
      else next[key] = value;
      return next;
    });
    setSaved(false);
  }
  function editHeartbeat<K extends keyof HeartbeatSettings>(key: K, value: HeartbeatSettings[K]) {
    setHeartbeatPatch((previous) => {
      const next = { ...previous };
      if (JSON.stringify(value) === JSON.stringify(heartbeat.data?.heartbeat[key]))
        delete next[key];
      else next[key] = value;
      return next;
    });
    setSaved(false);
  }
  const savedConnection =
    sources.data?.sources.find((source) => source.id === "cve")?.connection ??
    defaultCveConnection();
  const connection = cveDraft ?? savedConnection;
  function editConnection(next: CveConnection) {
    setCveDraft(JSON.stringify(next) === JSON.stringify(savedConnection) ? null : next);
    setSaved(false);
  }
  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (Object.keys(general).length) {
        await updateSettings({ ...general });
        setGeneral({});
        state.reload();
      }
      if (Object.keys(heartbeatPatch).length) {
        await updateHeartbeatSettings(heartbeatPatch);
        setHeartbeatPatch({});
        heartbeat.reload();
      }
      if (cveDraft) {
        await saveCveSource(cveDraft);
        setCveDraft(null);
        sources.reload();
      }
      setReview(false);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }
  const matches = SETTINGS_GROUPS.filter((item) =>
    `${item.label} ${item.hint}`.toLowerCase().includes(search.toLowerCase()),
  );
  const hb = heartbeat.data ? { ...heartbeat.data.heartbeat, ...heartbeatPatch } : null;
  const timezone = general.timezone ?? current?.timezone ?? "";
  const git =
    general.git ??
    (current ? { name: current.git.name, email: current.git.email } : { name: "", email: "" });
  const pending = [
    ...Object.entries(general).map(([key, value]: [string, unknown]) => ({ label: key, value })),
    ...Object.entries(heartbeatPatch).map(([key, value]: [string, unknown]) => ({
      label: `Heartbeat · ${key}`,
      value,
    })),
    ...(cveDraft ? [{ label: "CVE connection", value: cveDraft }] : []),
  ];
  return (
    <div className="settings-workspace">
      <header className="settings-topbar">
        <Settings size={16} />
        <span>Settings</span>
        <span className="settings-topbar-group">
          / {SETTINGS_GROUPS.find((item) => item.id === group)?.label}
        </span>
        <button type="button" className="settings-link" onClick={() => goto("about")}>
          About & deployment <ArrowRight size={13} />
        </button>
      </header>
      <div className="settings-layout">
        <aside className="settings-navigation">
          <div className="settings-category-search">
            <Search size={14} />
            <input
              aria-label="Find a setting"
              placeholder="Find a setting…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <nav aria-label="Settings categories">
            {matches.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-current={group === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={17} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          {!matches.length && <p className="settings-hint">No matching category</p>}
          <p className="settings-nav-note">
            Connection setup lives here. Filters, target repositories and prompts stay in Errands.
          </p>
        </aside>
        <div className="settings-main">
          <div className="settings-mobile-nav">
            <label>
              Settings category
              <select value={group} onChange={(e) => navigate(e.target.value)}>
                {SETTINGS_GROUPS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="settings-content" disabled={saving}>
            {state.loading && !current && <p>Loading settings…</p>}
            {state.error != null && (
              <p role="alert" className="settings-error">
                {state.error instanceof Error ? state.error.message : "Could not load settings"}
              </p>
            )}
            {current && group === "agent" && (
              <>
                <div className="settings-page-title">
                  <h1>Agent</h1>
                  <p>Who does the work, which model it uses, and what it may change.</p>
                </div>
                <SettingsPanel title="Runtime & model">
                  <SettingsRow
                    title={current.runtime.id ?? "Coding agent"}
                    description={`CLI ${current.runtime.cliVersion ?? "version not reported"} · runtime selection is configured by the deployment`}
                  >
                    <SettingsBadge tone={current.cli?.ok ? "good" : "neutral"}>
                      {current.cli?.ok ? "Healthy" : "See diagnostics"}
                    </SettingsBadge>
                  </SettingsRow>
                  <div className="settings-two-fields">
                    <SettingsField
                      label="Default model"
                      hint={
                        current.managedSettings?.model
                          ? "Configured by ERRANDD_MODEL in the deployment."
                          : "Use a model alias or ID supported by the active runtime."
                      }
                    >
                      {(id) => (
                        <input
                          id={id}
                          list={
                            current.runtime.id === "claude" ? "settings-model-aliases" : undefined
                          }
                          disabled={current.managedSettings?.model}
                          value={general.model ?? current.model}
                          onChange={(e) => edit("model", e.target.value)}
                        />
                      )}
                    </SettingsField>
                    <SettingsField
                      label="Fallback model"
                      hint={
                        current.managedSettings?.fallback
                          ? "Configured by ERRANDD_FALLBACK_MODEL in the deployment."
                          : undefined
                      }
                    >
                      {(id) => (
                        <input
                          id={id}
                          disabled={current.managedSettings?.fallback}
                          placeholder="No fallback configured"
                          value={
                            general.fallback ??
                            (typeof current.fallback === "string"
                              ? current.fallback
                              : current.fallback.model)
                          }
                          onChange={(e) => edit("fallback", e.target.value)}
                        />
                      )}
                    </SettingsField>
                  </div>
                  {current.runtime.id === "claude" && (
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={general.ultracode ?? current.ultracode}
                        onChange={(e) => edit("ultracode", e.target.checked)}
                      />
                      Multi-agent orchestration (ultracode)
                    </label>
                  )}
                  <p className="settings-hint">
                    An errand can override its model and session limits.
                  </p>
                </SettingsPanel>
                {current.runtime.id === "claude" && (
                  <datalist id="settings-model-aliases">
                    <option value="opus" />
                    <option value="sonnet" />
                    <option value="haiku" />
                    <option value="fable" />
                  </datalist>
                )}
                <TicketingPanel url={general.securityIssueTrackerUrl ?? current.securityIssueTrackerUrl ?? ""} onChange={value => edit("securityIssueTrackerUrl", value)} legacyConfigured={current.securityIssueTrackerUrl === undefined && Boolean(current.ticketProject || current.ticketTeam)} />
                <SettingsPanel title="Execution permissions">
                  <SettingsField
                    label="Security level"
                    hint={
                      current.managedSettings?.security
                        ? "Configured by ERRANDD_SECURITY_LEVEL in the deployment."
                        : undefined
                    }
                  >
                    {(id) => (
                      <select
                        id={id}
                        disabled={current.managedSettings?.security}
                        value={general.security?.level ?? current.security.level}
                        onChange={(e) => edit("security", { level: e.target.value })}
                      >
                        <option value="locked">Locked</option>
                        <option value="strict">Strict</option>
                        <option value="moderate">Moderate</option>
                        <option value="unrestricted">Unrestricted</option>
                      </select>
                    )}
                  </SettingsField>
                </SettingsPanel>
              </>
            )}
            {group === "events" && (
              <>
                {sources.error != null && (
                  <p role="alert" className="settings-error">
                    Could not load event sources.
                  </p>
                )}
                {sources.data ? (
                  <EventSourcesPanel
                    sources={sources.data.sources}
                    legacyLabels={current ? { enabled: general.migrateLegacyClawLabels ?? current.migrateLegacyClawLabels, onChange: value => edit("migrateLegacyClawLabels", value) } : undefined}
                    selected={route.segments[1]}
                    connection={connection}
                    onChange={editConnection}
                    navigate={(id) => navigate("events", id)}
                    ticketing={current ? <TicketingPanel url={general.securityIssueTrackerUrl ?? current.securityIssueTrackerUrl ?? ""} onChange={value => edit("securityIssueTrackerUrl", value)} legacyConfigured={current.securityIssueTrackerUrl === undefined && Boolean(current.ticketProject || current.ticketTeam)} /> : undefined}
                    openErrands={() => goto("routines")}
                  />
                ) : (
                  <p>Loading event sources…</p>
                )}
              </>
            )}
            {group === "libraries" && (
              <>
                <div className="settings-page-title">
                  <h1>Errand libraries</h1>
                  <p>
                    Repositories and reusable material that supply errand definitions. Library
                    changes save automatically; sync actions run when selected.
                  </p>
                </div>
                <ReposPanel librariesOnly />
              </>
            )}
            {current && group === "tools" && (
              <ToolsPanel
                state={current}
                tab={route.segments[1] ?? "mcp"}
                onTab={(tab) => navigate("tools", tab)}
              />
            )}
            {current && group === "timing" && (
              <>
                <div className="settings-page-title">
                  <h1>Timing & notifications</h1>
                  <p>Global timing preferences, periodic check-ins and chat delivery.</p>
                </div>
                <SettingsPanel title="Time & quiet hours">
                  <SettingsField
                    label="Schedule timezone"
                    hint={
                      current.managedSettings?.timezone
                        ? "Configured by ERRANDD_TIMEZONE in the deployment."
                        : "Use an IANA timezone name or UTC."
                    }
                  >
                    {(id) => (
                      <input
                        id={id}
                        disabled={current.managedSettings?.timezone}
                        value={timezone}
                        placeholder="America/Los_Angeles"
                        onChange={(e) => edit("timezone", e.target.value)}
                      />
                    )}
                  </SettingsField>
                  {hb && (
                    <>
                      <h3>Heartbeat quiet hours</h3>
                      {hb.excludeWindows.map((window, i) => (
                        <div className="settings-quiet-window" key={i}>
                          <SettingsField label={`Quiet window ${i + 1} start`}>
                            {(id) => (
                              <input
                                id={id}
                                type="time"
                                value={window.start}
                                onChange={(e) =>
                                  editHeartbeat(
                                    "excludeWindows",
                                    hb.excludeWindows.map((entry, n) =>
                                      n === i ? { ...entry, start: e.target.value } : entry,
                                    ),
                                  )
                                }
                              />
                            )}
                          </SettingsField>
                          <SettingsField label={`Quiet window ${i + 1} end`}>
                            {(id) => (
                              <input
                                id={id}
                                type="time"
                                value={window.end}
                                onChange={(e) =>
                                  editHeartbeat(
                                    "excludeWindows",
                                    hb.excludeWindows.map((entry, n) =>
                                      n === i ? { ...entry, end: e.target.value } : entry,
                                    ),
                                  )
                                }
                              />
                            )}
                          </SettingsField>
                          <button
                            type="button"
                            className="settings-link"
                            onClick={() =>
                              editHeartbeat(
                                "excludeWindows",
                                hb.excludeWindows.filter((_, n) => n !== i),
                              )
                            }
                          >
                            Remove
                          </button>
                          {window.days?.length ? (
                            <small>Applies on days {window.days.join(", ")} (0 = Sunday)</small>
                          ) : null}
                        </div>
                      ))}
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={() =>
                          editHeartbeat("excludeWindows", [
                            ...hb.excludeWindows,
                            { start: "22:00", end: "07:00" },
                          ])
                        }
                      >
                        Add quiet window
                      </button>
                    </>
                  )}
                </SettingsPanel>
                <SettingsPanel
                  title="Heartbeat"
                  description="Periodic agent check-ins are separate from source polling and individual errand cron schedules."
                >
                  {heartbeat.error != null && (
                    <p role="alert" className="settings-error">
                      Could not load heartbeat settings.
                    </p>
                  )}
                  {hb && (
                    <>
                      <label className="settings-checkbox">
                        <input
                          type="checkbox"
                          checked={hb.enabled}
                          onChange={(e) => editHeartbeat("enabled", e.target.checked)}
                        />
                        Enable heartbeat
                      </label>
                      <SettingsField label="Heartbeat interval (minutes)">
                        {(id) => (
                          <input
                            id={id}
                            type="number"
                            min={1}
                            value={hb.interval}
                            onChange={(e) => editHeartbeat("interval", e.target.valueAsNumber)}
                          />
                        )}
                      </SettingsField>
                      <SettingsField label="Heartbeat prompt">
                        {(id) => (
                          <textarea
                            id={id}
                            rows={5}
                            value={hb.prompt}
                            onChange={(e) => editHeartbeat("prompt", e.target.value)}
                          />
                        )}
                      </SettingsField>
                    </>
                  )}
                </SettingsPanel>
                <SettingsPanel title="Chat & notifications">
                  {[
                    { name: "Telegram", configured: current.telegram.configured },
                    { name: "Discord", configured: current.discord.configured },
                  ].map((channel) => (
                    <SettingsRow
                      key={channel.name}
                      title={channel.name}
                      description="Connection credentials are configured by the deployment."
                    >
                      <SettingsBadge tone={channel.configured ? "good" : "neutral"}>
                        {channel.configured ? "Configured" : "Not configured"}
                      </SettingsBadge>
                    </SettingsRow>
                  ))}
                  <p className="settings-hint">
                    Notification preferences and cron schedules for an individual errand stay in its
                    editor.
                  </p>
                </SettingsPanel>
              </>
            )}
            {current && group === "access" && (
              <>
                <div className="settings-page-title">
                  <h1>Access & appearance</h1>
                  <p>Dashboard sign-in, Git commit identity and local appearance.</p>
                </div>
                <SettingsPanel title="Dashboard access">
                  <SettingsRow
                    title={current.tailnet ? "Tailnet sign-in" : "Dashboard authentication"}
                    description={
                      current.tailnet
                        ? `${current.tailnet.displayName ?? current.tailnet.login} · ${current.tailnet.login}`
                        : "Authenticated dashboard session"
                    }
                  >
                    <Shield size={16} />
                  </SettingsRow>
                </SettingsPanel>
                <SettingsPanel
                  title="Git commit identity"
                  description={
                    current.git.managed
                      ? "Managed by the deployment; changes must be made through GitOps."
                      : "The identity used when Errandd commits changes."
                  }
                >
                  <div className="settings-two-fields">
                    <SettingsField label="Name">
                      {(id) => (
                        <input
                          id={id}
                          disabled={current.git.managed}
                          value={git.name}
                          onChange={(e) => edit("git", { ...git, name: e.target.value })}
                        />
                      )}
                    </SettingsField>
                    <SettingsField label="Email">
                      {(id) => (
                        <input
                          id={id}
                          type="email"
                          disabled={current.git.managed}
                          value={git.email}
                          onChange={(e) => edit("git", { ...git, email: e.target.value })}
                        />
                      )}
                    </SettingsField>
                  </div>
                </SettingsPanel>
                <SettingsPanel title="Appearance">
                  <SettingsRow
                    title="Theme"
                    description="Saved on this device and applied immediately."
                  >
                    <ThemePicker />
                  </SettingsRow>
                </SettingsPanel>
              </>
            )}
          </fieldset>
        </div>
      </div>
      <footer className="settings-savebar">
        <span>
          {dirty ? (
            `${dirty} pending setting${dirty === 1 ? "" : "s"}`
          ) : saved ? (
            <>
              <Check size={14} />
              Saved
            </>
          ) : (
            "Settings"
          )}
          <small>
            Library and plugin actions save when selected. Other edits are reviewed here.
          </small>
        </span>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!dirty || saving}
          onClick={() => {
            setError(null);
            setReview(true);
          }}
        >
          Review changes{dirty ? ` (${dirty})` : ""}
        </button>
      </footer>
      <dialog
        ref={dialogRef}
        className="settings-review"
        aria-label="Review settings changes"
        onCancel={(event) => {
          if (saving) event.preventDefault();
          else setReview(false);
        }}
      >
        <header>
          <h2>Review changes</h2>
          <button
            type="button"
            className="settings-link"
            aria-label="Close review"
            disabled={saving}
            onClick={() => setReview(false)}
          >
            <X size={18} />
          </button>
        </header>
        <p className="settings-hint">Apply these settings to this Errandd instance.</p>
        {pending.map((item) => (
          <SettingsRow key={item.label} title={item.label}>
            <pre>
              {typeof item.value === "string" ? item.value : JSON.stringify(item.value, null, 2)}
            </pre>
          </SettingsRow>
        ))}
        {error && (
          <p role="alert" className="settings-error">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={saving}
            onClick={() => setReview(false)}
          >
            Keep editing
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </footer>
      </dialog>
    </div>
  );
}
