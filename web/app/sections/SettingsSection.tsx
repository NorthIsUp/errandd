import {
 Badge,
 Button,
 Card,
 CardContent,
 CardHeader,
 CardTitle,
 CircularProgress,
 Input,
 Select,
 Switch,
 Tabs,
 TabsContent,
 TabsList,
 TabsTrigger,
 Tooltip,
 TooltipContent,
 TooltipTrigger,
 useToast,
} from"@pikoloo/darwin-ui";
import { HelpCircle, Trash2 } from"lucide-react";
import { useCallback, useEffect, useState } from"react";
import {
 addMcpServer,
 listMcpServers,
 removeMcpServer,
 type McpListResponse,
 type McpServer,
} from"../../api/mcp";
import { listRepos, syncRepo, type RepoStatus } from"../../api/repos";
import {
 getSettings,
 updateSettings,
 type Settings,
} from"../../api/settings";
import { getState, type StateResponse } from"../../api/state";
import { useTheme } from"../../hooks/useSystemTheme";
import { buildTimezoneOptions } from"../../features/settings/timezones";

const MODEL_OPTIONS = [
 { value:"claude-opus-4-7", label:"Opus 4.7" },
 { value:"claude-sonnet-4-6", label:"Sonnet 4.6" },
 { value:"claude-haiku-4-5", label:"Haiku 4.5" },
];

const SECURITY_OPTIONS = [
 { value:"default", label:"Default" },
 { value:"acceptEdits", label:"Accept Edits" },
 { value:"bypassPermissions", label:"Bypass Permissions" },
 { value:"plan", label:"Plan" },
];

export function SettingsSection() {
 const [tab, setTab] = useState("general");
 return (
 <div className="px-2 sm:px-0">
 <Tabs value={tab} onValueChange={setTab}>
 <TabsList>
 <TabsTrigger value="general">General</TabsTrigger>
 <TabsTrigger value="repos">Repos</TabsTrigger>
 <TabsTrigger value="mcps">MCPs</TabsTrigger>
 </TabsList>
 <TabsContent value="general">
 <GeneralPanel />
 </TabsContent>
 <TabsContent value="repos">
 <ReposPanel />
 </TabsContent>
 <TabsContent value="mcps">
 <McpsPanel />
 </TabsContent>
 </Tabs>
 </div>
 );
}

function ThemeCard() {
 const { mode, setMode } = useTheme();
 return (
 <Card>
 <CardHeader>
 <CardTitle>Theme</CardTitle>
 </CardHeader>
 <CardContent>
 <Tabs value={mode} onValueChange={(v) => setMode(v as"system" |"light" |"dark")}>
 <TabsList>
 <TabsTrigger value="system">System</TabsTrigger>
 <TabsTrigger value="light">Light</TabsTrigger>
 <TabsTrigger value="dark">Dark</TabsTrigger>
 </TabsList>
 </Tabs>
 </CardContent>
 </Card>
 );
}

function TitleWithHint({ title, hint }: { title: string; hint: string }) {
 return (
 <CardTitle>
 <span className="inline-flex items-center gap-1.5">
 {title}
 <Tooltip>
 <TooltipTrigger asChild>
 <HelpCircle size={14} className="opacity-60 cursor-help" />
 </TooltipTrigger>
 <TooltipContent>{hint}</TooltipContent>
 </Tooltip>
 </span>
 </CardTitle>
 );
}

function GeneralPanel() {
 const { showToast } = useToast();
 const [settings, setSettings] = useState<Settings | null>(null);
 const [state, setState] = useState<StateResponse | null>(null);
 const [model, setModel] = useState("");
 const [security, setSecurity] = useState("default");
 const [tz, setTz] = useState("");
 const [clock, setClock] = useState<"12" |"24">("24");
 const [saving, setSaving] = useState(false);
 const [loading, setLoading] = useState(true);

 useEffect(() => {
 void (async () => {
 try {
 const [s, st] = await Promise.all([getSettings(), getState()]);
 setSettings(s);
 setState(st);
 setModel(st.model);
 setSecurity(s.security.level);
 setTz(s.timezone);
 const stored = (localStorage.getItem("clawd.clockFormat") ??"24") as
 |"12"
 |"24";
 setClock(stored);
 } finally {
 setLoading(false);
 }
 })();
 }, []);

 const handleSave = useCallback(async () => {
 setSaving(true);
 try {
 await updateSettings({
 model,
 security: { level: security },
 timezone: tz,
 });
 localStorage.setItem("clawd.clockFormat", clock);
 const [s, st] = await Promise.all([getSettings(), getState()]);
 setSettings(s);
 setState(st);
 showToast("Settings saved", { type:"success" });
 } catch (err) {
 showToast(err instanceof Error ? err.message :"Save failed", {
 type:"error",
 });
 } finally {
 setSaving(false);
 }
 }, [model, security, tz, clock, showToast]);

 if (loading || !settings || !state) {
 return (
 <div className="flex justify-center py-16">
 <CircularProgress indeterminate size={32} />
 </div>
 );
 }

 return (
 <div className="space-y-4 mt-4">
 <Card>
 <CardHeader>
 <TitleWithHint
 title="Model"
 hint="The default Claude model used for chats and routines."
 />
 </CardHeader>
 <CardContent>
 <Select
 value={model}
 onChange={(e) => setModel(e.target.value)}
 options={MODEL_OPTIONS}
 />
 </CardContent>
 </Card>

 <Card>
 <CardHeader>
 <TitleWithHint
 title="Security"
 hint="Permission mode applied to every tool call. Default prompts before running anything risky; bypass disables prompts entirely."
 />
 </CardHeader>
 <CardContent>
 <Select
 value={security}
 onChange={(e) => setSecurity(e.target.value)}
 options={SECURITY_OPTIONS}
 />
 </CardContent>
 </Card>

 <ThemeCard />

 <Card>
 <CardHeader>
 <CardTitle>Clock</CardTitle>
 </CardHeader>
 <CardContent className="space-y-3">
 <div>
 <label className="text-xs text-muted-foreground mb-1 block">Timezone</label>
 <Select
 value={tz}
 onChange={(e) => setTz(e.target.value)}
 options={buildTimezoneOptions(settings.timezone)}
 />
 </div>
 <div>
 <label className="text-xs text-muted-foreground mb-2 block">Format</label>
 <Tabs value={clock} onValueChange={(v) => setClock(v as"12" |"24")}>
 <TabsList>
 <TabsTrigger value="12">12-hour</TabsTrigger>
 <TabsTrigger value="24">24-hour</TabsTrigger>
 </TabsList>
 </Tabs>
 </div>
 </CardContent>
 </Card>

 <div className="flex justify-end">
 <Button variant="primary" onClick={() => void handleSave()} loading={saving}>
 Save
 </Button>
 </div>
 </div>
 );
}

function ReposPanel() {
 const [repos, setRepos] = useState<RepoStatus[]>([]);
 const [loading, setLoading] = useState(true);
 const [syncing, setSyncing] = useState<string | null>(null);

 const reload = useCallback(async () => {
 try {
 setRepos(await listRepos());
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 void reload();
 }, [reload]);

 const handleSync = useCallback(
 async (slug: string) => {
 setSyncing(slug);
 try {
 await syncRepo(slug);
 await reload();
 } finally {
 setSyncing(null);
 }
 },
 [reload],
 );

 if (loading) {
 return (
 <div className="flex justify-center py-16">
 <CircularProgress indeterminate size={32} />
 </div>
 );
 }

 return (
 <div className="space-y-3 mt-4">
 {repos.length === 0 ? (
 <p className="text-sm text-muted-foreground text-center py-8">
 No plugin repos configured.
 </p>
 ) : (
 repos.map((r) => (
 <Card key={r.slug}>
 <CardContent className="py-4">
 <div className="flex items-start gap-3">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 mb-1 flex-wrap">
 <span className="font-medium">{r.slug}</span>
 {r.cloned ? (
 <Badge variant="success">cloned</Badge>
 ) : (
 <Badge variant="secondary">not cloned</Badge>
 )}
 {r.dirty ? <Badge variant="warning">dirty</Badge> : null}
 {r.ahead > 0 ? (
 <Badge variant="secondary">{r.ahead}↑</Badge>
 ) : null}
 {r.behind > 0 ? (
 <Badge variant="secondary">{r.behind}↓</Badge>
 ) : null}
 </div>
 <div className="text-xs text-muted-foreground truncate font-mono">
 {r.url}
 </div>
 {r.plugins.length > 0 ? (
 <div className="text-xs text-muted-foreground mt-1">
 plugins: {r.plugins.map((p) => p.name).join(",")}
 </div>
 ) : null}
 {r.lastError ? (
 <div className="text-xs text-muted-foreground mt-1">
 {r.lastError}
 </div>
 ) : null}
 </div>
 <Button
 variant="outline"
 size="sm"
 onClick={() => void handleSync(r.slug)}
 loading={syncing === r.slug}
 >
 Sync
 </Button>
 </div>
 </CardContent>
 </Card>
 ))
 )}
 </div>
 );
}

function McpsPanel() {
 const { showToast } = useToast();
 const [list, setList] = useState<McpListResponse | null>(null);
 const [loading, setLoading] = useState(true);
 const [adding, setAdding] = useState(false);
 const [draft, setDraft] = useState<{
 name: string;
 transport: McpServer["transport"];
 target: string;
 }>({ name:"", transport:"stdio", target:"" });

 const reload = useCallback(async () => {
 try {
 setList(await listMcpServers());
 } finally {
 setLoading(false);
 }
 }, []);

 useEffect(() => {
 void reload();
 }, [reload]);

 const handleAdd = useCallback(async () => {
 if (!draft.name.trim() || !draft.target.trim()) return;
 setAdding(true);
 try {
 await addMcpServer({
 name: draft.name.trim(),
 transport: draft.transport,
 target: draft.target.trim(),
 scope:"user",
 });
 setDraft({ name:"", transport:"stdio", target:"" });
 await reload();
 showToast(`Added ${draft.name.trim()}`, { type:"success" });
 } catch (err) {
 showToast(err instanceof Error ? err.message :"Add failed", {
 type:"error",
 });
 } finally {
 setAdding(false);
 }
 }, [draft, reload, showToast]);

 const handleRemove = useCallback(
 async (name: string, scope: McpServer["scope"]) => {
 try {
 await removeMcpServer(name, scope);
 await reload();
 showToast(`Removed ${name}`, { type:"success" });
 } catch (err) {
 showToast(err instanceof Error ? err.message :"Remove failed", {
 type:"error",
 });
 }
 },
 [reload, showToast],
 );

 if (loading || !list) {
 return (
 <div className="flex justify-center py-16">
 <CircularProgress indeterminate size={32} />
 </div>
 );
 }

 const all = [
 ...list.user.map((s) => ({ ...s, scope:"user" as const })),
 ...list.project.map((s) => ({ ...s, scope:"project" as const })),
 ];

 return (
 <div className="space-y-4 mt-4">
 <Card>
 <CardHeader>
 <CardTitle>Add MCP server</CardTitle>
 </CardHeader>
 <CardContent>
 <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
 <Input
 placeholder="name"
 value={draft.name}
 onChange={(e) => setDraft({ ...draft, name: e.target.value })}
 />
 <Select
 value={draft.transport}
 onChange={(e) =>
 setDraft({
 ...draft,
 transport: e.target.value as McpServer["transport"],
 })
 }
 options={[
 { value:"stdio", label:"stdio" },
 { value:"http", label:"http" },
 { value:"sse", label:"sse" },
 ]}
 />
 <Input
 placeholder={draft.transport ==="stdio" ?"command args…" :"https://…"}
 value={draft.target}
 onChange={(e) => setDraft({ ...draft, target: e.target.value })}
 />
 <Button
 variant="primary"
 onClick={() => void handleAdd()}
 loading={adding}
 disabled={!draft.name.trim() || !draft.target.trim()}
 >
 Add
 </Button>
 </div>
 </CardContent>
 </Card>

 {all.length === 0 ? (
 <p className="text-sm text-muted-foreground text-center py-8">
 No MCP servers configured.
 </p>
 ) : (
 <div className="space-y-2">
 {all.map((s) => (
 <Card key={`${s.scope}:${s.name}`}>
 <CardContent className="py-3 flex items-center gap-3">
 <div className="flex-1 min-w-0">
 <div className="flex items-center gap-2 mb-0.5">
 <span className="font-medium">{s.name}</span>
 <Badge variant="secondary">{s.scope}</Badge>
 <Badge variant="secondary">{s.transport}</Badge>
 </div>
 <div className="text-xs font-mono text-muted-foreground truncate">
 {s.target}
 </div>
 </div>
 <Button
 variant="ghost"
 size="sm"
 leftIcon={<Trash2 size={14} />}
 onClick={() => void handleRemove(s.name, s.scope)}
 >
 <span className="hidden sm:inline">Remove</span>
 </Button>
 </CardContent>
 </Card>
 ))}
 </div>
 )}
 </div>
 );
}
