import { useCallback, useEffect, useState } from "react";
import { listRepos } from "../../api/repos";
import { getHeartbeatSettings, updateSettings } from "../../api/settings";
import { getState } from "../../api/state";
import { Button } from "../../components/Button";
import { SectionFrame } from "../../components/SectionFrame";
import { Spinner } from "../../components/Spinner";
import { McpFieldset } from "../../features/mcp/McpFieldset";
import { ClockFieldset } from "../../features/settings/ClockFieldset";
import { HeartbeatFieldset } from "../../features/settings/HeartbeatFieldset";
import {
  collectJobsRepos,
  JobsReposFieldset,
  mergeRepoStatus,
  type RepoRow,
} from "../../features/settings/JobsReposFieldset";
import { ModelFieldset } from "../../features/settings/ModelFieldset";
import { SecurityFieldset } from "../../features/settings/SecurityFieldset";
import styles from "./SettingsSection.module.css";

/** Read clock format from localStorage (matching the legacy claudeclaw.clock key). */
function readClockFormat(): "12" | "24" {
  try {
    const v = localStorage.getItem("clock.format");
    return v === "12" ? "12" : "24";
  } catch {
    return "24";
  }
}

interface FormState {
  model: string;
  fallback: string;
  hbEnabled: boolean;
  hbInterval: number;
  hbPrompt: string;
  securityLevel: string;
  clockFormat: "12" | "24";
  timezone: string;
  repos: RepoRow[];
}

const DEFAULT_FORM: FormState = {
  model: "",
  fallback: "",
  hbEnabled: false,
  hbInterval: 15,
  hbPrompt: "",
  securityLevel: "moderate",
  clockFormat: "24",
  timezone: "UTC",
  repos: [],
};

export function SettingsSection() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<{
    msg: string;
    kind: "ok" | "err";
  } | null>(null);

  function patch(updates: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...updates }));
    setDirty(true);
  }

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [state, hbRes, repoStatuses] = await Promise.all([
        getState(),
        getHeartbeatSettings(),
        listRepos().catch(() => []),
      ]);

      const hb = hbRes.heartbeat;

      // Back-compat: prefer jobsRepos array; fall back to single jobsRepo
      const configRepos =
        Array.isArray(state.jobsRepos) && state.jobsRepos.length > 0
          ? state.jobsRepos
          : state.jobsRepo?.url
            ? [state.jobsRepo]
            : [];

      const mergedRepos = mergeRepoStatus(configRepos, repoStatuses);

      setForm({
        model: state.model ?? "",
        fallback:
          typeof (state as unknown as { fallback: { model?: string } })
            .fallback === "object" &&
          (state as unknown as { fallback: { model?: string } }).fallback !==
            null
            ? ((state as unknown as { fallback: { model?: string } }).fallback
                .model ?? "")
            : "",
        hbEnabled: Boolean(hb.enabled),
        hbInterval: Number(hb.interval) || 15,
        hbPrompt: typeof hb.prompt === "string" ? hb.prompt : "",
        securityLevel: state.security?.level ?? "moderate",
        clockFormat: readClockFormat(),
        timezone: state.timezone ?? "UTC",
        repos: mergedRepos,
      });
      setDirty(false);
    } catch (err) {
      setLoadError(
        `Failed to load settings: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function saveChanges() {
    setSaving(true);
    setSaveStatus(null);

    // Clock format is localStorage-only
    try {
      localStorage.setItem("clock.format", form.clockFormat);
    } catch {
      // ignore
    }

    const payload: Record<string, unknown> = {
      model: form.model.trim(),
      fallback: { model: form.fallback.trim() },
      security: { level: form.securityLevel },
      timezone: form.timezone,
      jobsRepos: collectJobsRepos(form.repos),
    };

    try {
      await updateSettings(payload);
      setSaveStatus({ msg: "Saved.", kind: "ok" });
      setDirty(false);
      setTimeout(() => {
        setSaveStatus(null);
      }, 2000);
    } catch (err) {
      setSaveStatus({
        msg: `Error: ${err instanceof Error ? err.message : String(err)}`,
        kind: "err",
      });
    } finally {
      setSaving(false);
    }
  }

  const actions = (
    <Button
      variant="primary"
      disabled={!dirty || saving}
      onClick={() => {
        void saveChanges();
      }}
    >
      {saving ? "Saving…" : "Save Changes"}
    </Button>
  );

  return (
    <SectionFrame title="Settings" actions={actions}>
      {loading ? (
        <div className={styles.center}>
          <Spinner size="lg" label="Loading settings…" />
        </div>
      ) : loadError !== null ? (
        <div className={styles.center}>
          <p className={styles.loadError}>{loadError}</p>
        </div>
      ) : (
        <div className={styles.content}>
          {saveStatus !== null && (
            <p
              className={
                saveStatus.kind === "err" ? styles.statusErr : styles.statusOk
              }
            >
              {saveStatus.msg}
            </p>
          )}

          <div className={styles.fieldsets}>
            <ModelFieldset
              model={form.model}
              fallback={form.fallback}
              onModelChange={(v) => {
                patch({ model: v });
              }}
              onFallbackChange={(v) => {
                patch({ fallback: v });
              }}
            />

            <HeartbeatFieldset
              enabled={form.hbEnabled}
              interval={form.hbInterval}
              prompt={form.hbPrompt}
              onEnabledChange={(v) => {
                patch({ hbEnabled: v });
              }}
              onIntervalChange={(v) => {
                patch({ hbInterval: v });
              }}
              onPromptChange={(v) => {
                patch({ hbPrompt: v });
              }}
            />

            <SecurityFieldset
              level={form.securityLevel}
              onChange={(v) => {
                patch({ securityLevel: v });
              }}
            />

            <ClockFieldset
              clockFormat={form.clockFormat}
              timezone={form.timezone}
              onClockFormatChange={(v) => {
                patch({ clockFormat: v });
              }}
              onTimezoneChange={(v) => {
                patch({ timezone: v });
              }}
            />

            <JobsReposFieldset
              repos={form.repos}
              onChange={(repos) => {
                patch({ repos });
              }}
            />

            <McpFieldset />
          </div>
        </div>
      )}
    </SectionFrame>
  );
}
