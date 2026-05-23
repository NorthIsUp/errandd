import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Switch,
  Textarea,
} from "@pikoloo/darwin-ui";
import { useId, useState } from "react";
import type { HeartbeatSettings } from "../../api/settings";
import { updateHeartbeatSettings } from "../../api/settings";
import { Field } from "../../components/Field";
import styles from "./HeartbeatFieldset.module.css";

interface Props {
  enabled: boolean;
  interval: number;
  prompt: string;
  onEnabledChange: (v: boolean) => void;
  onIntervalChange: (v: number) => void;
  onPromptChange: (v: string) => void;
}

export function HeartbeatFieldset({
  enabled,
  interval,
  prompt,
  onEnabledChange,
  onIntervalChange,
  onPromptChange,
}: Props) {
  const baseId = useId();
  const enabledId = `${baseId}-enabled`;
  const intervalId = `${baseId}-interval`;
  const promptId = `${baseId}-prompt`;

  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{
    msg: string;
    kind: "ok" | "err";
  } | null>(null);

  async function saveHeartbeat() {
    setSaving(true);
    setStatus(null);
    const patch: Partial<HeartbeatSettings> = {
      enabled,
      interval,
      prompt,
    };
    try {
      await updateHeartbeatSettings(patch);
      setStatus({ msg: "Saved.", kind: "ok" });
      setTimeout(() => {
        setStatus(null);
      }, 2000);
    } catch (err) {
      setStatus({
        msg: `Error: ${err instanceof Error ? err.message : String(err)}`,
        kind: "err",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card glass>
      <CardHeader>
        <CardTitle>Heartbeat</CardTitle>
      </CardHeader>
      <CardContent>
        {status !== null && (
          <p
            className={
              status.kind === "err" ? styles.statusErr : styles.statusOk
            }
          >
            {status.msg}
          </p>
        )}
        <Field label="Enabled" htmlFor={enabledId}>
          <Switch id={enabledId} checked={enabled} onChange={onEnabledChange} />
        </Field>
        <Field label="Interval (minutes)" htmlFor={intervalId}>
          <Input
            id={intervalId}
            type="number"
            className="max-w-[160px]"
            min={1}
            max={1440}
            step={1}
            value={interval}
            onChange={(e) => {
              onIntervalChange(Number(e.target.value) || 15);
            }}
          />
        </Field>
        <Field label="Prompt" htmlFor={promptId} layout="col">
          <Textarea
            id={promptId}
            rows={4}
            value={prompt}
            onChange={(e) => {
              onPromptChange(e.target.value);
            }}
            placeholder="What should the heartbeat run?"
          />
        </Field>
        <div className={styles.saveRow}>
          <Button
            variant="secondary"
            size="sm"
            disabled={saving}
            onClick={() => {
              void saveHeartbeat();
            }}
          >
            {saving ? "Saving…" : "Save Heartbeat"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
