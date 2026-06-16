import { useCallback, useEffect, useState } from "react";
import {
  getSettings,
  updateSettings,
  type Settings,
} from "../api/settings";
import { getState, type StateResponse } from "../api/state";

export interface UseGeneralSettingsResult {
  loading: boolean;
  saving: boolean;
  settings: Settings | null;
  state: StateResponse | null;
  model: string;
  setModel: (v: string) => void;
  security: string;
  setSecurity: (v: string) => void;
  tz: string;
  setTz: (v: string) => void;
  /** Persist current model/security/tz, then refresh `settings` and `state`. */
  save: () => Promise<{ ok: true } | { error: Error }>;
}

/**
 * Headless hook for the General settings panel: load current settings + state,
 * expose draft model/security/timezone, and persist on save.
 */
export function useGeneralSettings(): UseGeneralSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [model, setModel] = useState("");
  const [security, setSecurity] = useState("default");
  const [tz, setTz] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, st] = await Promise.all([getSettings(), getState()]);
        if (cancelled) return;
        setSettings(s);
        setState(st);
        setModel(st.model);
        setSecurity(s.security.level);
        setTz(s.timezone);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await updateSettings({
        model,
        security: { level: security },
        timezone: tz,
      });
      const [s, st] = await Promise.all([getSettings(), getState()]);
      setSettings(s);
      setState(st);
      return { ok: true as const };
    } catch (err) {
      return {
        error: err instanceof Error ? err : new Error(String(err)),
      };
    } finally {
      setSaving(false);
    }
  }, [model, security, tz]);

  return {
    loading,
    saving,
    settings,
    state,
    model,
    setModel,
    security,
    setSecurity,
    tz,
    setTz,
    save,
  };
}
