import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useMediaQuery,
} from "@pikoloo/darwin-ui";
import { FolderOpen, Puzzle, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { JobFileEntry } from "../../api/jobs";
import { createJobFile, listJobFiles } from "../../api/jobs";
import type { RepoStatus } from "../../api/repos";
import { listRepos } from "../../api/repos";
import { SectionFrame } from "../../components/SectionFrame";
import { JobEditor } from "../../features/jobs/JobEditor";
import type { FileKey } from "../../features/jobs/JobFileList";
import { makeDateFilename } from "../../features/jobs/makeDateFilename";
import { RepoStatusList } from "../../features/jobs/RepoStatusList";
import { parseJobFrontmatter } from "../../features/jobs/jobFrontmatter";
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

interface GroupEntry {
  label: string;
  slug: string | null;
  files: JobFileEntry[];
  plugins: number;
}

export function JobsSection({ initialFile, initialRepo }: Props) {
  const isMobile = useMediaQuery("(max-width: 760px)");

  const [activeFile, setActiveFile] = useState<FileKey | null>(
    initialFile ? { path: initialFile, repo: initialRepo } : null,
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const [status, setStatus] = useState<string>("");
  // Desktop: show editor pane alongside list
  const [showDetail, setShowDetail] = useState<boolean>(!!initialFile);
  // Mobile: editor is shown in a Dialog
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  // File groups (loaded here so we can render the accordion)
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);

  // File content cache — for accordion preview
  const [contentCache, setContentCache] = useState<Map<string, string>>(new Map());

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    try {
      let repos: RepoStatus[] = [];
      try {
        repos = await listRepos();
        if (!Array.isArray(repos)) repos = [];
      } catch {
        repos = [];
      }

      if (repos.length === 0) {
        const files = await listJobFiles();
        setGroups([{ label: "Local", slug: null, files: Array.isArray(files) ? files : [], plugins: 0 }]);
      } else {
        const result: GroupEntry[] = [];
        for (const repo of repos) {
          let files: JobFileEntry[] = [];
          try {
            files = await listJobFiles(repo.slug);
            if (!Array.isArray(files)) files = [];
          } catch { files = []; }
          result.push({
            label: repo.slug || repo.url || "repo",
            slug: repo.slug,
            files,
            plugins: Array.isArray(repo.plugins) ? repo.plugins.length : 0,
          });
        }
        let localFiles: JobFileEntry[] = [];
        try {
          localFiles = await listJobFiles("__local__");
          if (!Array.isArray(localFiles)) localFiles = [];
        } catch { localFiles = []; }
        result.push({ label: "Local", slug: "__local__", files: localFiles, plugins: 0 });
        setGroups(result);
      }
    } catch { /* keep previous */ }
    finally { setLoadingGroups(false); }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is the intentional refresh trigger
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGroups();
  }, [loadGroups, refreshTick]);

  // When initialFile / initialRepo change (e.g. user navigates via hash),
  // pick up the new selection.
  useEffect(() => {
    if (initialFile) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setActiveFile({ path: initialFile, repo: initialRepo });
      setShowDetail(true);
      if (isMobile) setDialogOpen(true);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [initialFile, initialRepo, isMobile]);

  const handleSelect = useCallback(
    (key: FileKey) => {
      setActiveFile(key);
      setStatus("");
      if (isMobile) {
        setDialogOpen(true);
      } else {
        setShowDetail(true);
      }
    },
    [isMobile],
  );

  const handleNew = useCallback(async () => {
    const name = makeDateFilename(false);
    try {
      let res = await createJobFile(name);
      if (!res.ok) {
        const nameWithSecs = makeDateFilename(true);
        res = await createJobFile(nameWithSecs);
        if (!res.ok) throw new Error("create failed");
        const key: FileKey = { path: nameWithSecs, repo: null };
        setActiveFile(key);
        setRefreshTick((t) => t + 1);
        setShowDetail(true);
        if (isMobile) setDialogOpen(true);
        setStatus("");
        return;
      }
      const key: FileKey = { path: name, repo: null };
      setActiveFile(key);
      setRefreshTick((t) => t + 1);
      setShowDetail(true);
      if (isMobile) setDialogOpen(true);
      setStatus("");
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [isMobile]);

  const handleSaved = useCallback((newKey: FileKey) => {
    setActiveFile(newKey);
    setRefreshTick((t) => t + 1);
  }, []);

  const handleDeleted = useCallback(() => {
    setActiveFile(null);
    setRefreshTick((t) => t + 1);
    setShowDetail(false);
    setDialogOpen(false);
    setStatus("");
  }, []);

  const handleBack = useCallback(() => {
    setShowDetail(false);
    setDialogOpen(false);
  }, []);

  const actions = (
    <Button size="sm" variant="primary" onClick={() => void handleNew()}>
      + New
    </Button>
  );

  // For accordion preview: extract schedule from file path (no content loading needed)
  // We show the path + job badge + a "Load" button to open editor

  const defaultGroupOpen = groups[0]?.slug ?? "local";

  return (
    <SectionFrame
      title="Jobs"
      actions={actions}
      bodyClassName={styles.body as string}
    >
      {/* ── Desktop split-pane layout ─────────────────────────────────────── */}
      {!isMobile ? (
        <div
          className={[styles.layout, showDetail ? styles.detail : undefined]
            .filter(Boolean)
            .join(" ")}
        >
          {/* Left: two-level accordion */}
          <div className={styles.sidebar}>
            <JobAccordionList
              groups={groups}
              loading={loadingGroups}
              activeFile={activeFile}
              defaultGroupOpen={defaultGroupOpen}
              onSelect={handleSelect}
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
      ) : (
        /* ── Mobile: accordion list + Dialog editor ────────────────────── */
        <div className={styles.mobileFull}>
          <JobAccordionList
            groups={groups}
            loading={loadingGroups}
            activeFile={activeFile}
            defaultGroupOpen={defaultGroupOpen}
            onSelect={handleSelect}
          />
          <RepoStatusList onStatus={setStatus} />

          <Dialog open={dialogOpen} onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) handleBack();
          }}>
            <DialogContent size="lg" className={styles.mobileDialog as string}>
              <DialogHeader>
                <DialogTitle>{activeFile?.path ?? "Editor"}</DialogTitle>
              </DialogHeader>
              <div className={styles.mobileEditorBody}>
                <JobEditor
                  fileKey={activeFile}
                  onSaved={(k) => { handleSaved(k); setDialogOpen(false); }}
                  onDeleted={() => { handleDeleted(); }}
                  onStatus={setStatus}
                  onBack={handleBack}
                  showBack={false}
                />
              </div>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* Status bar */}
      {status && <div className={styles.statusBar}>{status}</div>}
    </SectionFrame>
  );
}

// ---------------------------------------------------------------------------
// JobAccordionList — two-level accordion: outer=repo, inner=job files
// ---------------------------------------------------------------------------

interface AccordionListProps {
  groups: GroupEntry[];
  loading: boolean;
  activeFile: FileKey | null;
  defaultGroupOpen: string;
  onSelect: (key: FileKey) => void;
}

function JobAccordionList({
  groups,
  loading,
  activeFile,
  defaultGroupOpen,
  onSelect,
}: AccordionListProps) {
  if (loading) {
    return <div className={styles.loadingMsg}>Loading…</div>;
  }

  const totalFiles = groups.reduce((n, g) => n + g.files.length, 0);
  if (totalFiles === 0) {
    return <div className={styles.emptyMsg}>No job files yet. Click + New to create one.</div>;
  }

  return (
    <div className={styles.accordionWrap}>
      {/* Outer accordion: one item per repo group */}
      <Accordion type="single" defaultValue={defaultGroupOpen}>
        {groups.map((group) => {
          const groupKey = group.slug ?? "local";
          return (
            <AccordionItem key={groupKey} value={groupKey}>
              {/* Outer trigger: repo label */}
              <AccordionTrigger itemValue={groupKey} className={styles.groupTrigger ?? ""}>
                <span className={styles.groupTriggerInner}>
                  {group.plugins > 0 ? (
                    <Puzzle size={13} className={styles.groupIcon} />
                  ) : (
                    <FolderOpen size={13} className={styles.groupIcon} />
                  )}
                  <span className={styles.groupLabel}>{group.label}</span>
                  <Badge variant="secondary" className="text-[10px] px-[5px] py-0 ml-1">
                    {group.files.length}
                  </Badge>
                </span>
              </AccordionTrigger>

              <AccordionContent itemValue={groupKey}>
                {group.files.length === 0 ? (
                  <div className={styles.groupEmpty}>No files</div>
                ) : (
                  /* Inner accordion: one item per job file */
                  <Accordion type="single" className={styles.innerAccordion ?? ""}>
                    {group.files.map((f) => {
                      const fileKey: FileKey = { path: f.path, repo: group.slug ?? null };
                      const isActive =
                        activeFile !== null &&
                        f.path === activeFile.path &&
                        (group.slug ?? null) === activeFile.repo;
                      const jobItemKey = `${groupKey}::${f.path}`;

                      return (
                        <AccordionItem key={f.path} value={jobItemKey} className={styles.jobItem ?? ""}>
                          <AccordionTrigger
                            itemValue={jobItemKey}
                            className={[styles.jobTrigger, isActive ? styles.jobTriggerActive : undefined]
                              .filter(Boolean)
                              .join(" ")}
                          >
                            <span className={styles.jobTriggerInner}>
                              <span className={styles.jobFileName}>{f.path}</span>
                              {f.isJob && (
                                <Badge
                                  variant="success"
                                  className="text-[9px] px-[5px] py-[1px] font-mono uppercase tracking-widest border border-current"
                                >
                                  job
                                </Badge>
                              )}
                            </span>
                          </AccordionTrigger>

                          <AccordionContent itemValue={jobItemKey} className={styles.jobContent ?? ""}>
                            <JobFileActions
                              fileKey={fileKey}
                              onSelect={onSelect}
                            />
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                )}
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobFileActions — rendered inside the inner AccordionContent
// Shows: prompt preview + action buttons
// ---------------------------------------------------------------------------

interface JobFileActionsProps {
  fileKey: FileKey;
  onSelect: (key: FileKey) => void;
}

function JobFileActions({ fileKey, onSelect }: JobFileActionsProps) {
  return (
    <div className={styles.jobActions}>
      <div className={styles.jobMeta}>
        <span className={styles.jobPath}>{fileKey.path}</span>
      </div>
      <div className={styles.jobButtons}>
        <Button
          size="sm"
          variant="primary"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(fileKey);
          }}
        >
          <Save size={12} />
          Edit
        </Button>
      </div>
    </div>
  );
}
