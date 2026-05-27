import {
 AreaChart,
 Badge,
 Card,
 CardContent,
 CardHeader,
 CardTitle,
 DonutChart,
 Skeleton,
 Table,
 TableBody,
 TableCell,
 TableEmptyRow,
 TableHead,
 TableHeaderCell,
 TableLoadingRows,
 TableRow,
 Tabs,
 TabsList,
 TabsTrigger,
} from"@pikoloo/darwin-ui";
import {
 Activity,
 DollarSign,
 ListChecks,
 MessageSquare,
 TrendingDown,
 TrendingUp,
} from"lucide-react";
import { useEffect, useMemo, useState } from"react";
import { getHome, type HomeResponse } from"../../api/home";
import {
 getUsageTimeline,
 type TimeRange,
 type UsageTimelineResponse,
} from"../../api/timeline";
import { getUsage, type SessionUsage } from"../../api/usage";

const RANGES: { id: TimeRange; label: string }[] = [
 { id:"1h", label:"Hour" },
 { id:"24h", label:"Day" },
 { id:"7d", label:"Week" },
 { id:"30d", label:"Month" },
];

const DONUT_COLORS = [
"#60a5fa",
"#a78bfa",
"#f472b6",
"#fbbf24",
"#34d399",
"#fb7185",
"#22d3ee",
"#facc15",
];

function fmtBucket(ts: string, range: TimeRange): string {
 const d = new Date(ts);
 if (range ==="1h") return `${d.getMinutes()}m`;
 if (range ==="24h")
 return `${d.getHours().toString().padStart(2,"0")}:00`;
 return d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
}

function fmtUsd(n: number): string {
 if (n === 0) return"$0";
 if (n < 0.01) return `$${n.toFixed(4)}`;
 return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
 if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
 if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
 return String(n);
}

function fmtDelta(pct: number): string {
 const sign = pct >= 0 ?"+" :"";
 return `${sign}${pct.toFixed(1)}%`;
}

interface StatCardProps {
 label: string;
 value: string;
 delta?: number | null;
 Icon: typeof DollarSign;
 loading?: boolean;
}

function StatCard({ label, value, delta, Icon, loading }: StatCardProps) {
 return (
 <Card>
 <CardContent className="py-4">
 <div className="flex items-start justify-between mb-3">
 <Icon size={20} className="opacity-70" />
 {delta != null && !loading ? (
 <Badge variant={delta >= 0 ?"success" :"destructive"}>
 <span className="inline-flex items-center gap-0.5">
 {delta >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
 {fmtDelta(delta)}
 </span>
 </Badge>
 ) : null}
 </div>
 <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
 {label}
 </div>
 {loading ? (
 <Skeleton className="h-7 w-24" />
 ) : (
 <div className="text-2xl font-semibold tabular-nums">{value}</div>
 )}
 </CardContent>
 </Card>
 );
}

export function HomeSection() {
 const [range, setRange] = useState<TimeRange>("24h");
 const [timeline, setTimeline] = useState<UsageTimelineResponse | null>(null);
 const [usage, setUsage] = useState<SessionUsage[]>([]);
 const [home, setHome] = useState<HomeResponse | null>(null);
 const [loading, setLoading] = useState(true);

 useEffect(() => {
 let cancelled = false;
 async function load() {
 try {
 const [tl, u, h] = await Promise.all([
 getUsageTimeline(range),
 getUsage(),
 getHome(),
 ]);
 if (cancelled) return;
 setTimeline(tl);
 setUsage(Array.isArray(u) ? u : []);
 setHome(h);
 } finally {
 if (!cancelled) setLoading(false);
 }
 }
 void load();
 return () => {
 cancelled = true;
 };
 }, [range]);

 const { chartData, unitLabel } = useMemo(() => {
 if (!timeline) return { chartData: [], unitLabel:"" };
 const max = timeline.buckets.reduce(
 (m, b) => Math.max(m, b.totalTokens),
 0,
 );
 const u = max >= 1_000_000 ? 1_000_000 : max >= 1_000 ? 1_000 : 1;
 const label = u === 1_000_000 ?"M" : u === 1_000 ?"k" :"";
 return {
 unitLabel: label,
 chartData: timeline.buckets.map((b) => ({
 label: fmtBucket(b.ts, range),
 tokens: Number((b.totalTokens / u).toFixed(2)),
 })),
 };
 }, [timeline, range]);

 const totals = useMemo(() => {
 if (!timeline) return { tokens: 0, cost: 0, delta: 0 };
 const buckets = timeline.buckets;
 const half = Math.floor(buckets.length / 2);
 let curTokens = 0;
 let prevTokens = 0;
 let cost = 0;
 for (let i = 0; i < buckets.length; i++) {
 const b = buckets[i];
 if (!b) continue;
 cost += b.totalCostUsd;
 if (i >= half) curTokens += b.totalTokens;
 else prevTokens += b.totalTokens;
 }
 const delta = prevTokens > 0 ? ((curTokens - prevTokens) / prevTokens) * 100 : 0;
 return { tokens: curTokens + prevTokens, cost, delta };
 }, [timeline]);

 const routineGroups = useMemo(() => {
 if (!timeline) return [] as { name: string; cost: number; runs: { id: string; cost: number }[] }[];
 // Group raw byJob keys (e.g."#every-10m:20260523115004311") by routine prefix.
 const groups = new Map<string, { cost: number; runs: Map<string, number> }>();
 for (const b of timeline.buckets) {
 for (const [job, cost] of Object.entries(b.byJob)) {
 const [routine, runId] = job.split(":");
 const key = routine ?? job;
 const g = groups.get(key) ?? { cost: 0, runs: new Map<string, number>() };
 g.cost += cost;
 if (runId) g.runs.set(runId, (g.runs.get(runId) ?? 0) + cost);
 groups.set(key, g);
 }
 }
 return Array.from(groups.entries())
 .map(([name, g]) => ({
 name,
 cost: g.cost,
 runs: Array.from(g.runs.entries())
 .map(([id, cost]) => ({ id, cost }))
 .sort((a, b) => b.cost - a.cost),
 }))
 .sort((a, b) => b.cost - a.cost);
 }, [timeline]);

 const byRoutine = useMemo(
 () => routineGroups.map((g) => ({ name: g.name, cost: g.cost })),
 [routineGroups],
 );

 const donutData = useMemo(() => {
 if (byRoutine.length === 0) return [];
 const top = byRoutine.slice(0, 6);
 const rest = byRoutine.slice(6).reduce((sum, r) => sum + r.cost, 0);
 const items = top.map((r) => ({
 name: r.name,
 value: Number(r.cost.toFixed(4)),
 }));
 if (rest > 0) items.push({ name:"other", value: Number(rest.toFixed(4)) });
 return items;
 }, [byRoutine]);

 const showSkeleton = loading && !timeline;
 const sessionCount = usage.length;
 const routineCount = byRoutine.length;
 const chatsTotalCost = useMemo(
 () => usage.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
 [usage],
 );
 const grandTotal = chatsTotalCost + byRoutine.reduce((s, r) => s + r.cost, 0);

 return (
 <div className="space-y-4 sm:space-y-6 px-2 sm:px-0">
 <header className="px-2 sm:px-0">
 <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Dashboard</h1>
 <p className="text-sm text-muted-foreground mt-1">
 Token usage, routines, and chat activity.
 </p>
 </header>

 <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
 <StatCard
 label="Tokens"
 value={fmtTokens(totals.tokens)}
 delta={totals.delta !== 0 ? totals.delta : null}
 Icon={Activity}
 loading={showSkeleton}
 />
 <StatCard
 label="Cost"
 value={fmtUsd(totals.cost)}
 delta={totals.delta !== 0 ? totals.delta : null}
 Icon={DollarSign}
 loading={showSkeleton}
 />
 <StatCard
 label="Sessions"
 value={String(sessionCount)}
 delta={null}
 Icon={MessageSquare}
 loading={showSkeleton}
 />
 <StatCard
 label="Routines"
 value={String(routineCount)}
 delta={null}
 Icon={ListChecks}
 loading={showSkeleton}
 />
 </div>

 <Card>
 <CardHeader>
 <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
 <div>
 <CardTitle>
 Token usage{unitLabel ? ` (${unitLabel})` :""}
 </CardTitle>
 {!showSkeleton && totals.delta !== 0 ? (
 <div className="mt-1 inline-flex items-center gap-2">
 <Badge variant={totals.delta >= 0 ?"success" :"destructive"}>
 {fmtDelta(totals.delta)}
 </Badge>
 <span className="text-xs text-muted-foreground">vs previous period</span>
 </div>
 ) : (
 <p className="text-xs mt-1 text-muted-foreground">Live</p>
 )}
 </div>
 <Tabs value={range} onValueChange={(v) => setRange(v as TimeRange)}>
 <TabsList>
 {RANGES.map((r) => (
 <TabsTrigger key={r.id} value={r.id}>
 {r.label}
 </TabsTrigger>
 ))}
 </TabsList>
 </Tabs>
 </div>
 </CardHeader>
 <CardContent>
 {showSkeleton ? (
 <Skeleton className="h-[240px] w-full" />
 ) : (
 <AreaChart
 data={chartData}
 xKey="label"
 areas={[
 {
 dataKey:"tokens",
 fill:"#60a5fa",
 stroke:"#3b82f6",
 },
 ]}
 height={240}
 stacked={false}
 />
 )}
 </CardContent>
 </Card>

 <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
 <Card>
 <CardHeader>
 <CardTitle>Cost by routine</CardTitle>
 </CardHeader>
 <CardContent>
 {showSkeleton ? (
 <Skeleton className="h-[220px] w-full" />
 ) : donutData.length === 0 ? (
 <p className="text-muted-foreground text-sm py-12 text-center">
 No routine usage in this range.
 </p>
 ) : (
 <div className="relative">
 <DonutChart
 data={donutData}
 nameKey="name"
 valueKey="value"
 height={220}
 innerRadius={60}
 outerRadius={90}
 colors={DONUT_COLORS}
 showLegend={false}
 />
 <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
 <div className="text-xl font-semibold tabular-nums">
 {fmtUsd(donutData.reduce((s, d) => s + d.value, 0))}
 </div>
 <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
 Total
 </div>
 </div>
 </div>
 )}
 {donutData.length > 0 ? (
 <div className="mt-3 space-y-1.5 text-xs">
 {donutData.map((d, i) => (
 <div key={d.name} className="flex items-center gap-2">
 <span
 className="inline-block w-2.5 h-2.5 rounded-sm"
 style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
 />
 <span className="flex-1 truncate font-mono">{d.name}</span>
 <span className="text-muted-foreground tabular-nums">
 {fmtUsd(d.value)}
 </span>
 </div>
 ))}
 </div>
 ) : null}
 </CardContent>
 </Card>

 <UsageBreakdownCard
 chats={usage}
 chatsTotal={chatsTotalCost}
 grandTotal={grandTotal}
 routines={routineGroups}
 loading={showSkeleton}
 />
 </div>

 {home?.server.daemon ? (
 <p className="text-xs text-muted-foreground text-center">
 Daemon pid {home.server.daemon.pid} ·{""}
 {Math.round(home.server.daemon.uptimeMs / 60000)}m uptime
 </p>
 ) : null}
 </div>
 );
}

interface UsageBreakdownProps {
 chats: SessionUsage[];
 chatsTotal: number;
 grandTotal: number;
 routines: { name: string; cost: number; runs: { id: string; cost: number }[] }[];
 loading: boolean;
}

function UsageBreakdownCard({
 chats,
 chatsTotal,
 grandTotal,
 routines,
 loading,
}: UsageBreakdownProps) {
 const [openChats, setOpenChats] = useState(false);
 const [openRoutines, setOpenRoutines] = useState<Record<string, boolean>>({});

 function toggleRoutine(name: string) {
 setOpenRoutines((prev) => ({ ...prev, [name]: !prev[name] }));
 }

 return (
 <Card>
 <CardHeader>
 <CardTitle>Usage breakdown</CardTitle>
 </CardHeader>
 <CardContent>
 <Table>
 <TableHead>
 <TableRow>
 <TableHeaderCell>Name</TableHeaderCell>
 <TableHeaderCell>Cost</TableHeaderCell>
 </TableRow>
 </TableHead>
 <TableBody>
 {loading ? (
 <TableLoadingRows rows={4} colSkeletons={["w-40 h-4","w-16 h-4"]} />
 ) : (
 <>
 <TableRow>
 <TableCell>
 <span className="font-semibold uppercase text-[10px] tracking-wider text-muted-foreground">
 Total
 </span>
 </TableCell>
 <TableCell className="tabular-nums font-semibold">
 {fmtUsd(grandTotal)}
 </TableCell>
 </TableRow>

 <DisclosureRow
 open={openChats}
 onToggle={() => setOpenChats((v) => !v)}
 label="Chats"
 count={chats.length}
 cost={chatsTotal}
 />
 {openChats
 ? chats.slice(0, 20).map((s) => (
 <TableRow key={s.sessionId}>
 <TableCell>
 <span className="pl-7 inline-flex items-center gap-2 text-xs">
 <Badge variant="secondary">{s.channel}</Badge>
 <span className="truncate max-w-[14rem]">{s.label}</span>
 </span>
 </TableCell>
 <TableCell className="tabular-nums text-xs">
 {fmtUsd(s.estimatedCostUsd)}
 </TableCell>
 </TableRow>
 ))
 : null}

 {routines.map((r) => (
 <RoutineGroup
 key={r.name}
 name={r.name}
 cost={r.cost}
 runs={r.runs}
 open={openRoutines[r.name] ?? false}
 onToggle={() => toggleRoutine(r.name)}
 />
 ))}

 {chats.length === 0 && routines.length === 0 ? (
 <TableEmptyRow colSpan={2}>
 <p className="text-muted-foreground text-sm">No usage in this range</p>
 </TableEmptyRow>
 ) : null}
 </>
 )}
 </TableBody>
 </Table>
 </CardContent>
 </Card>
 );
}

function DisclosureRow({
 open,
 onToggle,
 label,
 count,
 cost,
}: {
 open: boolean;
 onToggle: () => void;
 label: string;
 count: number;
 cost: number;
}) {
 return (
 <TableRow>
 <TableCell>
 <button
 type="button"
 onClick={onToggle}
 className="flex items-center gap-2 text-left w-full"
 >
 <ChevronRightIcon open={open} />
 <span className="font-medium">{label}</span>
 <Badge variant="secondary">{count}</Badge>
 </button>
 </TableCell>
 <TableCell className="tabular-nums">{fmtUsd(cost)}</TableCell>
 </TableRow>
 );
}

function RoutineGroup({
 name,
 cost,
 runs,
 open,
 onToggle,
}: {
 name: string;
 cost: number;
 runs: { id: string; cost: number }[];
 open: boolean;
 onToggle: () => void;
}) {
 return (
 <>
 <TableRow>
 <TableCell>
 <button
 type="button"
 onClick={onToggle}
 className="flex items-center gap-2 text-left w-full"
 disabled={runs.length === 0}
 >
 <ChevronRightIcon open={open} faded={runs.length === 0} />
 <span className="font-mono text-sm">{name}</span>
 {runs.length > 0 ? (
 <Badge variant="secondary">{runs.length}</Badge>
 ) : null}
 </button>
 </TableCell>
 <TableCell className="tabular-nums">{fmtUsd(cost)}</TableCell>
 </TableRow>
 {open
 ? runs.map((run) => (
 <TableRow key={run.id}>
 <TableCell>
 <span className="pl-7 font-mono text-xs text-muted-foreground">
 {run.id}
 </span>
 </TableCell>
 <TableCell className="tabular-nums text-xs">
 {fmtUsd(run.cost)}
 </TableCell>
 </TableRow>
 ))
 : null}
 </>
 );
}

function ChevronRightIcon({
 open,
 faded,
}: {
 open: boolean;
 faded?: boolean;
}) {
 const cls = faded ?"text-muted-foreground opacity-50" :"text-muted-foreground";
 return (
 <span
 className={`inline-block transition-transform ${cls} ${open ?"rotate-90" :""}`}
 >
 ▸
 </span>
 );
}
