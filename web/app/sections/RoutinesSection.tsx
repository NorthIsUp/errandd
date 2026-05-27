import {
 Accordion,
 AccordionContent,
 AccordionItem,
 AccordionTrigger,
 Badge,
 Button,
 Card,
 CircularProgress,
 Dialog,
 DialogBody,
 DialogClose,
 DialogContent,
 DialogFooter,
 DialogHeader,
 DialogTitle,
 Input,
 MdEditor,
 Switch,
 useToast,
} from"@pikoloo/darwin-ui";
import cronstrue from"cronstrue";
import { ChevronDown, ChevronRight, Edit2 } from"lucide-react";
import { useCallback, useEffect, useMemo, useState } from"react";

function describeCron(expr: string): string {
 const trimmed = expr.trim();
 if (!trimmed) return"";
 try {
 return cronstrue.toString(trimmed, { verbose: false });
 } catch {
 return"Invalid cron expression";
 }
}
import type { HomeResponse, LogRun } from"../../api/home";
import { getHome } from"../../api/home";
import {
 createJobFile,
 deleteJobFile,
 getJobFile,
 listJobFiles,
 writeJobFile,
 type JobFileEntry,
} from"../../api/jobs";
import { listRepos, type RepoStatus } from"../../api/repos";

interface JobGroup {
 key: string;
 label: string;
 plugin?: string;
 repoSlug: string | null;
 files: JobFileEntry[];
}

export function RoutinesSection() {
 const [repos, setRepos] = useState<RepoStatus[]>([]);
 const [localFiles, setLocalFiles] = useState<JobFileEntry[]>([]);
 const [repoFiles, setRepoFiles] = useState<Record<string, JobFileEntry[]>>({});
 const [home, setHome] = useState<HomeResponse | null>(null);
 const [loading, setLoading] = useState(true);

 const reload = useCallback(async () => {
 try {
 const [r, lf, h] = await Promise.all([
 listRepos().catch(() => [] as RepoStatus[]),
 listJobFiles(null).catch(() => [] as JobFileEntry[]),
 getHome().catch(() => null),
 ]);
 setRepos(r);
 setLocalFiles(lf);
 setHome(h);
 const perRepo: Record<string, JobFileEntry[]> = {};
 await Promise.all(
 r.map(async (repo) => {
 if (!repo.cloned) return;
 try {
 perRepo[repo.slug] = await listJobFiles(repo.slug);
 } catch {
 perRepo[repo.slug] = [];
 }
 }),
 );
 setRepoFiles(perRepo);
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 void reload();
 }, [reload]);

 const groups = useMemo<JobGroup[]>(() => {
 const result: JobGroup[] = [
 {
 key:"__local__",
 label:"Local",
 repoSlug: null,
 files: localFiles.filter((f) => f.isJob),
 },
 ];
 for (const repo of repos) {
 const files = (repoFiles[repo.slug] ?? []).filter((f) => f.isJob);
 if (repo.plugins.length === 0) {
 result.push({
 key: repo.slug,
 label: repo.slug,
 repoSlug: repo.slug,
 files,
 });
 continue;
 }
 for (const plugin of repo.plugins) {
 const pluginFiles = files.filter((f) =>
 f.path.startsWith(`${plugin.dir}/`) || f.path.includes(`/${plugin.name}/`),
 );
 result.push({
 key: `${repo.slug}:${plugin.name}`,
 label: plugin.name,
 plugin: plugin.name,
 repoSlug: repo.slug,
 files: pluginFiles.length > 0 ? pluginFiles : files,
 });
 }
 }
 return result;
 }, [repos, localFiles, repoFiles]);

 if (loading) {
 return (
 <div className="flex justify-center py-16">
 <CircularProgress indeterminate size={32} />
 </div>
 );
 }

 return (
 <div className="px-2 sm:px-0">
 <Accordion type="multiple" defaultValue={["__local__"]}>
 {groups.map((g) => (
 <AccordionItem key={g.key} value={g.key}>
 <AccordionTrigger>
 <span className="flex items-center gap-2">
 <span>{g.label}</span>
 <Badge variant="secondary">{g.files.length}</Badge>
 </span>
 </AccordionTrigger>
 <AccordionContent>
 {g.files.length === 0 ? (
 <p className="text-sm text-muted-foreground py-2">No routines.</p>
 ) : (
 <div className="space-y-1">
 {g.files.map((f) => (
 <JobRow
 key={`${g.key}:${f.path}`}
 file={f}
 repoSlug={g.repoSlug}
 runs={(home?.logs?.runs ?? []).filter((r) =>
 r.file.includes(jobBaseName(f.path)),
 )}
 onSaved={reload}
 />
 ))}
 </div>
 )}
 </AccordionContent>
 </AccordionItem>
 ))}
 </Accordion>
 </div>
 );
}

function jobBaseName(path: string): string {
 const slash = path.lastIndexOf("/");
 const name = slash === -1 ? path : path.slice(slash + 1);
 return name.replace(/\.md$/,"");
}

interface JobRowProps {
 file: JobFileEntry;
 repoSlug: string | null;
 runs: LogRun[];
 onSaved: () => void;
}

function JobRow({ file, repoSlug, runs, onSaved }: JobRowProps) {
 const [expanded, setExpanded] = useState(false);
 const [editorOpen, setEditorOpen] = useState(false);

 return (
 <div>
 <div className="flex items-center gap-2 py-3">
 <button
 type="button"
 className="flex-1 flex items-center gap-2 text-left"
 onClick={() => setExpanded((v) => !v)}
 >
 {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
 <span className="font-mono text-base truncate">{jobBaseName(file.path)}</span>
 {runs.length > 0 ? (
 <Badge variant="secondary">{runs.length}</Badge>
 ) : null}
 </button>
 <Button
 variant="ghost"
 size="default"
 leftIcon={<Edit2 size={16} />}
 onClick={() => setEditorOpen(true)}
 >
 <span className="hidden sm:inline">Edit</span>
 </Button>
 </div>

 {expanded ? (
 <div className="pb-2 pl-6 space-y-1">
 {runs.length === 0 ? (
 <p className="text-xs text-muted-foreground">No recent executions.</p>
 ) : (
 runs.slice(0, 10).map((r) => <RunRow key={r.file} run={r} />)
 )}
 </div>
 ) : null}

 {editorOpen ? (
 <JobEditor
 path={file.path}
 repoSlug={repoSlug}
 onClose={() => setEditorOpen(false)}
 onSaved={() => {
 setEditorOpen(false);
 onSaved();
 }}
 />
 ) : null}
 </div>
 );
}

interface ParsedRun {
 date?: string;
 session?: string;
 model?: string;
 prompt?: string;
 exitCode?: string;
 output?: string;
}

function parseRunLog(lines: string[]): ParsedRun {
 const parsed: ParsedRun = {};
 let i = 0;
 while (i < lines.length) {
 const line = lines[i] ??"";
 if (line.startsWith("Date:")) parsed.date = line.slice(5).trim();
 else if (line.startsWith("Session:")) parsed.session = line.slice(8).trim();
 else if (line.startsWith("Model config:"))
 parsed.model = line.slice(13).trim();
 else if (line.startsWith("Exit code:"))
 parsed.exitCode = line.slice(10).trim();
 else if (line.startsWith("Prompt:")) {
 const promptParts: string[] = [line.slice(7).trim()];
 i++;
 while (
 i < lines.length &&
 !(lines[i] ??"").startsWith("Exit code:") &&
 !(lines[i] ??"").startsWith("## Output")
 ) {
 promptParts.push(lines[i] ??"");
 i++;
 }
 parsed.prompt = promptParts.join("\n").trim();
 continue;
 } else if (line.trim() ==="## Output") {
 parsed.output = lines.slice(i + 1).join("\n").trim();
 break;
 }
 i++;
 }
 return parsed;
}

function RunRow({ run }: { run: LogRun }) {
 const [open, setOpen] = useState(false);
 const ts = new Date(run.mtime * 1000).toLocaleString();
 const parsed = useMemo(() => parseRunLog(run.lines), [run.lines]);
 const success = parsed.exitCode ==="0";
 const hasChat = parsed.prompt != null || parsed.output != null;

 return (
 <div className="text-sm">
 <button
 type="button"
 className="flex items-center gap-2 text-muted-foreground py-1"
 onClick={() => setOpen((v) => !v)}
 >
 {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
 <span className="font-mono text-xs">{ts}</span>
 {parsed.exitCode != null ? (
 <Badge variant={success ?"success" :"destructive"}>
 exit {parsed.exitCode}
 </Badge>
 ) : null}
 {parsed.model ? (
 <span className="text-xs text-muted-foreground">· {parsed.model}</span>
 ) : null}
 </button>
 {open ? (
 <div className="mt-2 ml-5 space-y-3 max-w-2xl">
 {hasChat ? (
 <>
 {parsed.prompt ? (
 <div className="flex justify-end">
 <Card className="max-w-[85%]">
 <div className="px-3 py-2 text-sm whitespace-pre-wrap font-medium">
 {parsed.prompt}
 </div>
 </Card>
 </div>
 ) : null}
 {parsed.output ? (
 <div className="flex justify-start">
 <Card className="max-w-[95%]">
 <div className="px-3 py-2 text-sm whitespace-pre-wrap">
 {parsed.output}
 </div>
 </Card>
 </div>
 ) : null}
 {parsed.session ? (
 <p className="text-[10px] text-muted-foreground font-mono">
 session {parsed.session}
 </p>
 ) : null}
 </>
 ) : (
 <Card>
 <pre className="max-h-60 overflow-auto p-2 text-xs whitespace-pre-wrap">
 {run.lines.join("\n")}
 </pre>
 </Card>
 )}
 </div>
 ) : null}
 </div>
 );
}

// ---------------------------------------------------------------------------
// Job editor — modal with frontmatter controls + body
// ---------------------------------------------------------------------------

interface ParsedFrontmatter {
 enabled: boolean;
 schedule: string;
 recurring: boolean;
 notify: boolean;
 extra: Record<string, string>;
}

function parseFrontmatter(content: string): { fm: ParsedFrontmatter; body: string } {
 const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
 const empty: ParsedFrontmatter = {
 enabled: true,
 schedule:"",
 recurring: false,
 notify: true,
 extra: {},
 };
 if (!match) return { fm: empty, body: content };
 const raw = match[1] ??"";
 const body = match[2] ??"";
 const fm: ParsedFrontmatter = { ...empty };
 for (const line of raw.split("\n")) {
 const m = line.match(/^([a-z_]+):\s*(.*)$/i);
 if (!m) continue;
 const key = m[1]?.toLowerCase() ??"";
 const val = (m[2] ??"").trim().replace(/^["']|["']$/g,"");
 if (key ==="enabled") fm.enabled = !/^(false|no|0|off)$/i.test(val);
 else if (key ==="schedule") fm.schedule = val;
 else if (key ==="recurring") fm.recurring = /^(true|yes|1|on)$/i.test(val);
 else if (key ==="notify" || key ==="notification")
 fm.notify = !/^(false|no|0|off)$/i.test(val);
 else fm.extra[key] = val;
 }
 return { fm, body };
}

function serializeFrontmatter(fm: ParsedFrontmatter, body: string): string {
 const lines: string[] = ["---"];
 lines.push(`enabled: ${fm.enabled}`);
 if (fm.schedule) lines.push(`schedule:"${fm.schedule}"`);
 lines.push(`recurring: ${fm.recurring}`);
 lines.push(`notify: ${fm.notify}`);
 for (const [k, v] of Object.entries(fm.extra)) {
 lines.push(`${k}: ${v}`);
 }
 lines.push("---","");
 return `${lines.join("\n")}${body.replace(/^\n+/,"")}`;
}

interface JobEditorProps {
 path: string;
 repoSlug: string | null;
 onClose: () => void;
 onSaved: () => void;
}

function dirOf(path: string): string {
 const i = path.lastIndexOf("/");
 return i === -1 ?"" : path.slice(0, i + 1);
}

function sanitizeName(name: string): string {
 return name.trim().replace(/\.md$/i,"").replace(/[^a-zA-Z0-9._-]+/g,"-");
}

function JobEditor({ path, repoSlug, onClose, onSaved }: JobEditorProps) {
 const { showToast } = useToast();
 const [loading, setLoading] = useState(true);
 const [saving, setSaving] = useState(false);
 const [fm, setFm] = useState<ParsedFrontmatter | null>(null);
 const [body, setBody] = useState("");
 const [name, setName] = useState(jobBaseName(path));
 const [nameError, setNameError] = useState<string | null>(null);

 useEffect(() => {
 let cancelled = false;
 async function load() {
 try {
 const res = await getJobFile(path, repoSlug);
 if (cancelled) return;
 const parsed = parseFrontmatter(res.content);
 setFm(parsed.fm);
 setBody(parsed.body);
 setName(jobBaseName(path));
 } finally {
 if (!cancelled) setLoading(false);
 }
 }
 void load();
 return () => {
 cancelled = true;
 };
 }, [path, repoSlug]);

 const handleSave = useCallback(async () => {
 if (!fm) return;
 const cleaned = sanitizeName(name);
 if (!cleaned) {
 setNameError("Name cannot be empty");
 return;
 }
 setNameError(null);
 setSaving(true);
 try {
 const content = serializeFrontmatter(fm, body);
 const originalName = jobBaseName(path);
 if (cleaned !== originalName) {
 const newPath = `${dirOf(path)}${cleaned}.md`;
 await createJobFile(newPath, repoSlug);
 await writeJobFile(newPath, content, repoSlug);
 await deleteJobFile(path, repoSlug);
 } else {
 await writeJobFile(path, content, repoSlug);
 }
 showToast(`Saved ${cleaned}`, { type:"success" });
 onSaved();
 } catch (err) {
 showToast(err instanceof Error ? err.message :"Save failed", {
 type:"error",
 });
 } finally {
 setSaving(false);
 }
 }, [fm, body, name, path, repoSlug, onSaved, showToast]);

 return (
 <Dialog open onOpenChange={(o) => (!o ? onClose() : null)}>
 <DialogContent size="lg" glass>
 <DialogHeader>
 <DialogTitle>
 <Input
 value={name}
 onChange={(e) => setName(e.target.value)}
 placeholder="routine-name"
 size="lg"
 error={nameError != null}
 />
 {nameError ? (
 <p className="text-xs text-muted-foreground mt-1">{nameError}</p>
 ) : null}
 </DialogTitle>
 </DialogHeader>
 <DialogBody>
 {loading || !fm ? (
 <div className="flex justify-center py-12">
 <CircularProgress indeterminate size={28} />
 </div>
 ) : (
 <div className="space-y-4">
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 <Switch
 checked={fm.enabled}
 onChange={(v) => setFm({ ...fm, enabled: v })}
 label="Enabled"
 />
 <Switch
 checked={fm.recurring}
 onChange={(v) => setFm({ ...fm, recurring: v })}
 label="Recurring"
 />
 <Switch
 checked={fm.notify}
 onChange={(v) => setFm({ ...fm, notify: v })}
 label="Notifications"
 />
 </div>
 <div>
 <label className="text-xs text-muted-foreground mb-1 block">
 Schedule (cron)
 </label>
 <Input
 value={fm.schedule}
 onChange={(e) => setFm({ ...fm, schedule: e.target.value })}
 placeholder="*/15 * * * *"
 />
 {fm.schedule.trim() ? (
 <p className="text-xs mt-1.5 text-muted-foreground">
 {describeCron(fm.schedule)}
 </p>
 ) : null}
 </div>
 <div>
 <label className="text-xs text-muted-foreground mb-1 block">Prompt</label>
 <MdEditor
 value={body}
 onChange={(v) => setBody(v ??"")}
 placeholder="Routine prompt body…"
 />
 </div>
 </div>
 )}
 </DialogBody>
 <DialogFooter>
 <DialogClose asChild>
 <Button variant="ghost">Cancel</Button>
 </DialogClose>
 <Button
 variant="primary"
 onClick={() => void handleSave()}
 loading={saving}
 disabled={loading}
 >
 Save
 </Button>
 </DialogFooter>
 </DialogContent>
 </Dialog>
 );
}
