import { Button } from "@pikoloo/darwin-ui";
import { useCallback, useEffect, useState } from "react";
import { createJobFile } from "../../api/jobs";
import { SectionFrame } from "../../components/SectionFrame";
import { JobEditor } from "../../features/jobs/JobEditor";
import type { FileKey } from "../../features/jobs/JobFileList";
import { JobFileList } from "../../features/jobs/JobFileList";
import { makeDateFilename } from "../../features/jobs/makeDateFilename";
import { RepoStatusList } from "../../features/jobs/RepoStatusList";
import styles from "./JobsSection.module.css";

interface Props {
  /**
   * Pre-selected file path from URL `#jobs?file=<name>`.
   * Set by ChatsSection when the user clicks a 🗂 job link.
   */
  initialFile: string | null;
  /**
   * Pre-selected repo slug from URL `#jobs?repo=<slug>`.
   */
  initialRepo: string | null;
}

export function JobsSection({ initialFile, initialRepo }: Props) {
  const [activeFile, setActiveFile] = useState<FileKey | null>(
    initialFile ? { path: initialFile, repo: initialRepo } : null,
  );
  // Increment to trigger file-list refresh
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<string>("");
  // Mobile: show editor pane instead of file list
  const [showDetail, setShowDetail] = useState<boolean>(!!initialFile);

  // When initialFile / initialRepo change (e.g. user navigates via hash),
  // pick up the new selection.
  useEffect(() => {
    if (initialFile) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setActiveFile({ path: initialFile, repo: initialRepo });
      setShowDetail(true);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [initialFile, initialRepo]);

  const handleSelect = useCallback((key: FileKey) => {
    setActiveFile(key);
    setShowDetail(true);
    setStatus("");
  }, []);

  const handleNew = useCallback(async () => {
    const name = makeDateFilename(false);
    try {
      let res = await createJobFile(name);
      if (!res.ok) {
        // Same-minute collision: retry with seconds
        const nameWithSecs = makeDateFilename(true);
        res = await createJobFile(nameWithSecs);
        if (!res.ok) throw new Error("create failed");
        setActiveFile({ path: nameWithSecs, repo: null });
        setRefreshTick((t) => t + 1);
        setShowDetail(true);
        setStatus("");
        return;
      }
      setActiveFile({ path: name, repo: null });
      setRefreshTick((t) => t + 1);
      setShowDetail(true);
      setStatus("");
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const handleSaved = useCallback((newKey: FileKey) => {
    setActiveFile(newKey);
    setRefreshTick((t) => t + 1);
  }, []);

  const handleDeleted = useCallback(() => {
    setActiveFile(null);
    setRefreshTick((t) => t + 1);
    setShowDetail(false);
    setStatus("");
  }, []);

  const handleBack = useCallback(() => {
    setShowDetail(false);
  }, []);

  const actions = (
    <Button size="sm" variant="primary" onClick={() => void handleNew()}>
      + New
    </Button>
  );

  return (
    <SectionFrame
      title="Jobs"
      actions={actions}
      bodyClassName={styles.body as string}
    >
      <div
        className={[styles.layout, showDetail ? styles.detail : undefined]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Left: file browser + repo status */}
        <div className={styles.sidebar}>
          <JobFileList
            activeFile={activeFile}
            onSelect={handleSelect}
            refreshTick={refreshTick}
          />
          <RepoStatusList onStatus={setStatus} />
        </div>

        {/* Right: editor */}
        <div className={styles.editorPane}>
          <JobEditor
            fileKey={activeFile}
            onSaved={handleSaved}
            onDeleted={handleDeleted}
            onStatus={setStatus}
            onBack={handleBack}
            showBack={showDetail}
          />
        </div>
      </div>

      {/* Status bar */}
      {status && <div className={styles.statusBar}>{status}</div>}
    </SectionFrame>
  );
}
