import { Button, CircularProgress, MdEditor } from "@pikoloo/darwin-ui";
import { useCallback, useEffect, useState } from "react";
import {
  autoNameJobFile,
  deleteJobFile,
  getJobFile,
  writeJobFile,
} from "../../api/jobs";
import styles from "./JobEditor.module.css";
import type { FileKey } from "./JobFileList";
import { parseJobFrontmatter, summarizeFrontmatter } from "./jobFrontmatter";
import { isDateFilename } from "./makeDateFilename";

interface Props {
  fileKey: FileKey | null;
  /** Called after save (possibly with a new path after auto-rename). */
  onSaved: (newKey: FileKey) => void;
  /** Called after delete. */
  onDeleted: () => void;
  onStatus: (msg: string) => void;
  /** On mobile: go back to the file list. */
  onBack: () => void;
  showBack: boolean;
}

export function JobEditor({
  fileKey,
  onSaved,
  onDeleted,
  onStatus,
  onBack,
  showBack,
}: Props) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load file when fileKey changes
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!fileKey) {
      setContent("");
      setDirty(false);
      return;
    }
    setLoading(true);
    setDirty(false);
    getJobFile(fileKey.path, fileKey.repo)
      .then((data) => {
        setContent(data.content ?? "");
      })
      .catch((e) => {
        onStatus(
          `Failed to load: ${e instanceof Error ? e.message : String(e)}`,
        );
        setContent("");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [fileKey, onStatus]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleChange = useCallback((val: string) => {
    setContent(val);
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!fileKey) return;
    setSaving(true);
    onStatus("Saving…");
    try {
      await writeJobFile(fileKey.path, content, fileKey.repo);
      setDirty(false);
      onStatus("Saved.");

      // Auto-rename if the filename is a date-stamp
      const basename = fileKey.path.split("/").pop() ?? "";
      if (isDateFilename(basename)) {
        onStatus("Auto-naming…");
        try {
          const renameOut = await autoNameJobFile(fileKey.path);
          if (renameOut.ok && renameOut.newPath) {
            const newKey: FileKey = {
              path: renameOut.newPath,
              repo: fileKey.repo,
            };
            onSaved(newKey);
            onStatus(`Saved and renamed to ${renameOut.newPath}`);
          } else {
            onSaved(fileKey);
            onStatus("Saved. (auto-rename failed)");
          }
        } catch (re) {
          onSaved(fileKey);
          onStatus(
            `Saved. (auto-rename error: ${re instanceof Error ? re.message : String(re)})`,
          );
        }
      } else {
        onSaved(fileKey);
      }
    } catch (e) {
      onStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [fileKey, content, onSaved, onStatus]);

  const handleDelete = useCallback(async () => {
    if (!fileKey) return;
    if (!confirm(`Delete ${fileKey.path}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteJobFile(fileKey.path, fileKey.repo);
      onDeleted();
      onStatus("Deleted.");
    } catch (e) {
      onStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDeleting(false);
    }
  }, [fileKey, onDeleted, onStatus]);

  const fm = content ? parseJobFrontmatter(content) : null;
  const fmSummary = fm ? summarizeFrontmatter(fm) : null;

  if (!fileKey) {
    return (
      <div className={styles.panel}>
        <p className={styles.empty}>
          Select a file from the list, or click + New to create one.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        {showBack && (
          <Button size="sm" variant="ghost" onClick={onBack}>
            ← Back
          </Button>
        )}
        <span className={styles.filename} title={fileKey.path}>
          {fileKey.path}
        </span>
        {dirty && <span className={styles.dirtyDot} title="Unsaved changes" />}
        <div className={styles.toolbarActions}>
          <Button
            size="sm"
            variant="destructive"
            disabled={deleting || saving}
            onClick={() => void handleDelete()}
          >
            {deleting ? (
              <CircularProgress indeterminate size={12} strokeWidth={2} />
            ) : (
              "Delete"
            )}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={saving || !dirty}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <>
                <CircularProgress indeterminate size={12} strokeWidth={2} />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>

      {/* Frontmatter summary */}
      {fmSummary && <div className={styles.fmSummary}>{fmSummary}</div>}

      {/* Editor — Darwin MdEditor */}
      <div className={styles.editorWrap}>
        {loading ? (
          <div className={styles.editorLoading}>
            <CircularProgress indeterminate size={14} strokeWidth={2} />
          </div>
        ) : (
          <MdEditor
            key={fileKey.path}
            value={content}
            onChange={handleChange}
            placeholder="Write your job instructions here (Markdown + YAML frontmatter)…"
          />
        )}
      </div>
    </div>
  );
}
