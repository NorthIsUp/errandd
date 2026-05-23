import { Textarea } from "@pikoloo/darwin-ui";
import * as RadixPopover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatAttachment } from "../../api/chat";
import type { SlashEntry } from "../../api/slash";
import styles from "./ChatInput.module.css";
import { fuzzyFilter } from "./fuzzyMatch";
import { SlashPopoverContent } from "./SlashPopover";

interface Props {
  busy: boolean;
  slashEntries: SlashEntry[];
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onCancel: () => void;
}

/**
 * Chat textarea + attach button + send/cancel + slash popover.
 * Ported from src/ui/page/script.ts chat form, attachment, slash autocomplete.
 */
export function ChatInput({ busy, slashEntries, onSend, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachWarn, setAttachWarn] = useState<string | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFiltered, setSlashFiltered] = useState<SlashEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize the textarea
  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }

  // Slash autocomplete
  const updateSlash = useCallback(
    (val: string) => {
      if (!val.startsWith("/") || /\s/.test(val)) {
        setSlashOpen(false);
        setSlashFiltered([]);
        setSelectedIdx(-1);
        return;
      }
      const query = val.slice(1).toLowerCase();
      const filtered = fuzzyFilter(slashEntries, query, (e) => e.name);
      setSlashFiltered(filtered);
      setSlashOpen(true);
      setSelectedIdx(-1);
    },
    [slashEntries],
  );

  function handleInput(e: React.FormEvent<HTMLTextAreaElement>) {
    const newVal = e.currentTarget.value;
    setValue(newVal);
    autoResize();
    updateSlash(newVal);
  }

  function applySlash(entry: SlashEntry) {
    const newVal = `/${entry.name}`;
    setValue(newVal);
    setSlashOpen(false);
    setSelectedIdx(-1);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashOpen) {
      const count = slashFiltered.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => (count > 0 ? (i + 1) % count : -1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => (count > 0 ? (i - 1 + count) % count : -1));
        return;
      }
      if (e.key === "Enter" && selectedIdx >= 0) {
        e.preventDefault();
        const selected = slashFiltered[selectedIdx];
        if (selected) applySlash(selected);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        setSelectedIdx(-1);
        return;
      }
    }

    // Enter (without Shift) = send
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (busy) return;
    const text = value.trim();
    const toSend = [...attachments];
    if (!text && toSend.length === 0) return;
    setValue("");
    setAttachments([]);
    setAttachWarn(null);
    setSlashOpen(false);
    setSelectedIdx(-1);
    // reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    onSend(text, toSend);
  }

  function handleBlur() {
    // Small delay so mousedown on popover option fires before blur hides it
    setTimeout(() => {
      setSlashOpen(false);
      setSelectedIdx(-1);
    }, 150);
  }

  // File attach
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setAttachWarn(null);
    const newAtts = [...attachments];
    for (const file of files) {
      if (newAtts.length >= 5) {
        setAttachWarn("Max 5 attachments allowed.");
        break;
      }
      if (file.size > 10 * 1024 * 1024) {
        setAttachWarn(`"${file.name}" exceeds 10 MB limit.`);
        continue;
      }
      try {
        const data = await readFileAsBase64(file);
        newAtts.push({
          name: file.name,
          type: file.type || "application/octet-stream",
          data,
        });
      } catch {
        // ignore
      }
    }
    e.target.value = "";
    setAttachments(newAtts);
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Re-focus after busy clears
  useEffect(() => {
    if (!busy) textareaRef.current?.focus();
  }, [busy]);

  const showPopover = slashOpen;

  return (
    <div className={styles.inputArea}>
      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className={styles.attachments}>
          {attachments.map((att, idx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: attachment order can't shift mid-render
            <span key={idx} className={styles.chip}>
              <span className={styles.chipName} title={att.name}>
                {att.name}
              </span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${att.name}`}
                onClick={() => {
                  removeAttachment(idx);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {attachWarn && <div className={styles.attachWarn}>{attachWarn}</div>}

      {/* The Radix Popover anchored to the textarea row */}
      <RadixPopover.Root open={showPopover} onOpenChange={setSlashOpen}>
        <div className={styles.inputRow}>
          {/* Attach button */}
          <button
            type="button"
            className={styles.iconBtn}
            disabled={busy}
            title="Attach file"
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            📎
          </button>

          {/* Textarea — the popover trigger is a zero-size span next to it */}
          <RadixPopover.Anchor asChild>
            <Textarea
              ref={textareaRef}
              className={styles.textarea}
              value={value}
              placeholder={busy ? "Claude is responding…" : "Message…"}
              disabled={busy}
              rows={1}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              aria-label="Chat message"
              aria-haspopup="listbox"
            />
          </RadixPopover.Anchor>

          {/* Cancel button (visible while busy) */}
          {busy && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.cancelBtn}`}
              onClick={onCancel}
              title="Cancel"
            >
              ✕
            </button>
          )}

          {/* Send button */}
          {!busy && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.sendBtn}`}
              disabled={busy || (!value.trim() && attachments.length === 0)}
              onClick={submit}
              title="Send (Enter)"
            >
              ↑
            </button>
          )}
        </div>

        {/* Slash popover content */}
        <RadixPopover.Portal>
          <RadixPopover.Content
            side="top"
            align="start"
            sideOffset={4}
            style={{
              background: "#0d1929",
              border: "1px solid rgba(125,197,255,0.27)",
              borderRadius: "6px",
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              zIndex: 200,
              outline: "none",
            }}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
            }}
          >
            <SlashPopoverContent
              entries={slashFiltered}
              selectedIdx={selectedIdx}
              onSelect={applySlash}
            />
          </RadixPopover.Content>
        </RadixPopover.Portal>
      </RadixPopover.Root>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className={styles.hiddenFileInput}
        onChange={(e) => {
          void handleFileChange(e);
        }}
      />
    </div>
  );
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result;
      const base64 =
        typeof result === "string" ? (result.split(",")[1] ?? "") : "";
      resolve(base64);
    };
    reader.onerror = () => {
      reject(new Error("Failed to read file"));
    };
    reader.readAsDataURL(file);
  });
}
