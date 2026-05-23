import { Button, Input, Select } from "@pikoloo/darwin-ui";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { addMcpServer } from "../../api/mcp";
import { Field } from "../../components/Field";
import styles from "./McpAddForm.module.css";

const NAME_RE = /^[a-zA-Z0-9_:.-]{1,128}$/;

interface Props {
  onAdded: (name: string) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
  onClearError: () => void;
}

interface HeaderRow {
  id: number;
  value: string;
}

export function McpAddForm({
  onAdded,
  onCancel,
  onError,
  onClearError,
}: Props) {
  const baseId = useId();
  const nameId = `${baseId}-name`;
  const targetId = `${baseId}-target`;

  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [target, setTarget] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const nextHeaderId = useRef(0);
  const formRef = useRef<HTMLDivElement>(null);

  // Focus the name input on mount without using the autoFocus prop
  useEffect(() => {
    const el = formRef.current?.querySelector<HTMLInputElement>(
      `#${CSS.escape(nameId)}`,
    );
    el?.focus();
  }, [nameId]);

  const isHttpy = transport === "http" || transport === "sse";

  function addHeaderRow() {
    const id = nextHeaderId.current++;
    setHeaders((prev) => [...prev, { id, value: "" }]);
  }

  function removeHeaderRow(id: number) {
    setHeaders((prev) => prev.filter((h) => h.id !== id));
  }

  function updateHeader(id: number, value: string) {
    setHeaders((prev) => prev.map((h) => (h.id === id ? { ...h, value } : h)));
  }

  const handleSubmit = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedTarget = target.trim();

    if (!trimmedName) {
      onError("Name is required.");
      return;
    }
    if (!NAME_RE.test(trimmedName)) {
      onError("Invalid name — use letters, digits, _, :, ., - only.");
      return;
    }
    if (!trimmedTarget) {
      onError("Target is required.");
      return;
    }

    const collectedHeaders = headers.map((h) => h.value.trim()).filter(Boolean);

    setSubmitting(true);
    try {
      const serverPayload =
        collectedHeaders.length > 0
          ? {
              name: trimmedName,
              scope: "user" as const,
              transport,
              target: trimmedTarget,
              headers: collectedHeaders,
            }
          : {
              name: trimmedName,
              scope: "user" as const,
              transport,
              target: trimmedTarget,
            };
      await addMcpServer(serverPayload);
      onClearError();
      onAdded(trimmedName);
    } catch (err) {
      onError(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  }, [name, target, transport, headers, onAdded, onError, onClearError]);

  return (
    <div ref={formRef} className={styles.form}>
      <Field label="Name" htmlFor={nameId}>
        <Input
          id={nameId}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          placeholder="my-server"
        />
      </Field>

      <Field label="Transport">
        <Select
          value={transport}
          onChange={(e) => {
            setTransport(e.target.value as "stdio" | "http" | "sse");
          }}
        >
          <Select.Option value="stdio">stdio</Select.Option>
          <Select.Option value="http">http</Select.Option>
          <Select.Option value="sse">sse</Select.Option>
        </Select>
      </Field>

      <Field label="Target" htmlFor={targetId}>
        <Input
          id={targetId}
          type="text"
          value={target}
          onChange={(e) => {
            setTarget(e.target.value);
          }}
          placeholder={
            isHttpy ? "https://example.com/mcp" : "npx -y @your/mcp-server"
          }
        />
      </Field>

      {isHttpy && (
        <Field label="Headers" layout="col">
          <div className={styles.headersList}>
            {headers.map((h) => (
              <div key={h.id} className={styles.headerRow}>
                <Input
                  type="text"
                  value={h.value}
                  onChange={(e) => {
                    updateHeader(h.id, e.target.value);
                  }}
                  placeholder="Authorization: Bearer …"
                />
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={() => {
                    removeHeaderRow(h.id);
                  }}
                  aria-label="Remove header"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <Button variant="primary" size="sm" onClick={addHeaderRow}>
            <Plus className="h-4 w-4" />
            Add Header
          </Button>
        </Field>
      )}

      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={submitting}
        >
          {submitting ? "Adding…" : "Add server"}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
