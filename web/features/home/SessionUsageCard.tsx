import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@pikoloo/darwin-ui";
import { type ReactNode, useState } from "react";
import type { SessionUsage } from "../../api/usage";
import styles from "./SessionUsageCard.module.css";
import { fmtCost, fmtRelative, fmtTokens, usageJobBase } from "./utils";

interface Props {
  sessions: SessionUsage[];
  className?: string;
}

/** Aggregated row for a job base group. */
interface GroupAgg {
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  cacheHitPct: number;
  turnCount: number;
  lastUsedAt: string;
}

type DisplayRow =
  | { type: "standalone"; data: SessionUsage }
  | { type: "parent"; data: GroupAgg; base: string; children: SessionUsage[] };

function buildDisplayRows(sessions: SessionUsage[]): DisplayRow[] {
  const knownBases: Record<string, boolean> = {};
  for (const s of sessions) {
    const base = usageJobBase(s.label, null);
    if (base !== null) knownBases[base] = true;
  }

  const groupMap: Record<string, SessionUsage[]> = {};
  const groupOrder: string[] = [];
  const standalones: SessionUsage[] = [];

  for (const s of sessions) {
    const base = usageJobBase(s.label, knownBases);
    if (base !== null) {
      if (groupMap[base] === undefined) {
        groupMap[base] = [];
        groupOrder.push(base);
      }
      groupMap[base]?.push(s);
    } else {
      standalones.push(s);
    }
  }

  const rows: DisplayRow[] = [];
  for (const s of standalones) {
    rows.push({ type: "standalone", data: s });
  }
  for (const base of groupOrder) {
    const children = (groupMap[base] ?? [])
      .slice()
      .sort((a, b) => ((b.lastUsedAt ?? "") > (a.lastUsedAt ?? "") ? 1 : -1));
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let estimatedCostUsd = 0;
    let turnCount = 0;
    let lastUsedAt = "";
    for (const c of children) {
      inputTokens += c.inputTokens ?? 0;
      outputTokens += c.outputTokens ?? 0;
      cacheReadTokens += c.cacheReadTokens ?? 0;
      cacheWriteTokens += c.cacheWriteTokens ?? 0;
      estimatedCostUsd += c.estimatedCostUsd ?? 0;
      turnCount += c.turnCount ?? 0;
      if (!lastUsedAt || (c.lastUsedAt && c.lastUsedAt > lastUsedAt)) {
        lastUsedAt = c.lastUsedAt;
      }
    }
    const totalIn = inputTokens + cacheReadTokens + cacheWriteTokens;
    const cacheHitPct =
      totalIn > 0 ? Math.round((cacheReadTokens / totalIn) * 100) : 0;
    const agg: GroupAgg = {
      label: `#${base}`,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      estimatedCostUsd,
      cacheHitPct,
      turnCount,
      lastUsedAt,
    };
    rows.push({ type: "parent", data: agg, base, children });
  }
  return rows;
}

function channelIcon(channel: string | undefined): string {
  if (channel === "discord") return "🎮";
  if (channel === "web") return "🌐";
  return "⚙️";
}

interface RowData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheHitPct: number;
  estimatedCostUsd: number;
  turnCount: number;
  lastUsedAt: string;
}

function CostBarCell({
  estimatedCostUsd,
  maxCost,
}: {
  estimatedCostUsd: number;
  maxCost: number;
}) {
  const barPct =
    maxCost > 0 ? Math.round(((estimatedCostUsd ?? 0) / maxCost) * 100) : 0;
  return (
    <TableCell className={styles.costCell ?? ""}>
      <div className={styles.costWrap ?? ""}>
        <div className={styles.costBar ?? ""} style={{ width: `${barPct}%` }} />
        <span className={styles.costLabel ?? ""}>
          ~{fmtCost(estimatedCostUsd ?? 0)}
        </span>
      </div>
    </TableCell>
  );
}

interface UsageDataRowProps {
  label: string;
  channel?: string;
  data: RowData;
  maxCost: number;
  child?: boolean;
  prefix?: ReactNode;
}

function UsageDataRow({
  label,
  channel,
  data,
  maxCost,
  child = false,
  prefix,
}: UsageDataRowProps) {
  const rowCls = child ? styles.groupChild : undefined;

  return (
    <TableRow {...(rowCls !== undefined ? { className: rowCls } : {})}>
      <TableCell className={styles.labelCell ?? ""}>
        {prefix}
        {channelIcon(channel)} {label}
      </TableCell>
      <TableCell className={styles.numCell ?? ""}>
        {fmtTokens(data.inputTokens ?? 0)}
      </TableCell>
      <TableCell className={styles.numCell ?? ""}>
        {fmtTokens(data.outputTokens ?? 0)}
      </TableCell>
      <TableCell className={styles.numCell ?? ""}>
        {fmtTokens(data.cacheReadTokens ?? 0)}
      </TableCell>
      <TableCell className={styles.numCell ?? ""}>
        {data.cacheHitPct ?? 0}%
      </TableCell>
      <CostBarCell
        estimatedCostUsd={data.estimatedCostUsd ?? 0}
        maxCost={maxCost}
      />
      <TableCell className={styles.numCell ?? ""}>
        {data.turnCount ?? 0}
      </TableCell>
      <TableCell className={styles.ageCell ?? ""}>
        {fmtRelative(data.lastUsedAt)}
      </TableCell>
    </TableRow>
  );
}

interface GroupRowProps {
  row: DisplayRow & { type: "parent" };
  maxCost: number;
  isExpanded: boolean;
  onToggle: () => void;
}

function GroupRow({ row, maxCost, isExpanded, onToggle }: GroupRowProps) {
  const barPct =
    maxCost > 0
      ? Math.round(((row.data.estimatedCostUsd ?? 0) / maxCost) * 100)
      : 0;

  const parentCls = [
    styles.groupParent,
    isExpanded ? styles.groupExpanded : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {/* Native <tr> for the clickable group parent row (Darwin TableRow has no onClick) */}
      <tr
        className={parentCls}
        onClick={onToggle}
        style={{ cursor: "pointer" }}
      >
        <td className={styles.labelCell ?? ""}>
          <button
            type="button"
            className={styles.caret ?? ""}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? "Collapse group" : "Expand group"}
          >
            {isExpanded ? "▼" : "▶"}
          </button>{" "}
          ⚙️ {row.data.label}{" "}
          <span className={styles.groupCount ?? ""}>
            ({row.children.length} runs)
          </span>
        </td>
        <td className={styles.numCell ?? ""}>
          {fmtTokens(row.data.inputTokens ?? 0)}
        </td>
        <td className={styles.numCell ?? ""}>
          {fmtTokens(row.data.outputTokens ?? 0)}
        </td>
        <td className={styles.numCell ?? ""}>
          {fmtTokens(row.data.cacheReadTokens ?? 0)}
        </td>
        <td className={styles.numCell ?? ""}>{row.data.cacheHitPct ?? 0}%</td>
        <td className={styles.costCell ?? ""}>
          <div className={styles.costWrap ?? ""}>
            <div
              className={styles.costBar ?? ""}
              style={{ width: `${barPct}%` }}
            />
            <span className={styles.costLabel ?? ""}>
              ~{fmtCost(row.data.estimatedCostUsd ?? 0)}
            </span>
          </div>
        </td>
        <td className={styles.numCell ?? ""}>{row.data.turnCount ?? 0}</td>
        <td className={styles.ageCell ?? ""}>
          {fmtRelative(row.data.lastUsedAt)}
        </td>
      </tr>

      {isExpanded &&
        row.children.map((child, ci) => (
          <UsageDataRow
            key={child.sessionId + String(ci)}
            label={child.label}
            channel={child.channel}
            data={child}
            maxCost={maxCost}
            child
            prefix={<span className={styles.childIndent ?? ""}>↳ </span>}
          />
        ))}
    </>
  );
}

export function SessionUsageCard({ sessions, className }: Props) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );

  const cardProps = className !== undefined ? { className } : {};

  if (sessions.length === 0) {
    return (
      <Card glass {...cardProps}>
        <CardHeader>
          <CardTitle>Session Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <p style={{ color: "var(--muted)", fontSize: "13px" }}>
            No active sessions found.
          </p>
        </CardContent>
      </Card>
    );
  }

  const displayRows = buildDisplayRows(sessions);

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;
  let totalTurns = 0;
  for (const row of displayRows) {
    const d = row.data;
    totalInput += d.inputTokens ?? 0;
    totalOutput += d.outputTokens ?? 0;
    totalCacheRead += d.cacheReadTokens ?? 0;
    totalCacheWrite +=
      (d as GroupAgg).cacheWriteTokens ??
      (d as SessionUsage).cacheWriteTokens ??
      0;
    totalCost += d.estimatedCostUsd ?? 0;
    totalTurns += d.turnCount ?? 0;
  }
  const totalsIn = totalInput + totalCacheRead + totalCacheWrite;
  const totalCacheHitPct =
    totalsIn > 0 ? Math.round((totalCacheRead / totalsIn) * 100) : 0;

  const maxCost = displayRows.reduce(
    (m, r) => Math.max(m, r.data.estimatedCostUsd ?? 0),
    0,
  );

  const toggleGroup = (base: string) => {
    setExpandedGroups((prev) => ({ ...prev, [base]: !prev[base] }));
  };

  return (
    <Card glass {...cardProps}>
      <CardHeader>
        <CardTitle>Session Usage</CardTitle>
      </CardHeader>
      <CardContent>
        <div style={{ overflowX: "auto" }}>
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Session</TableHeaderCell>
                <TableHeaderCell className={styles.numCell ?? ""}>
                  Input
                </TableHeaderCell>
                <TableHeaderCell className={styles.numCell ?? ""}>
                  Output
                </TableHeaderCell>
                <TableHeaderCell className={styles.numCell ?? ""}>
                  Cache Read
                </TableHeaderCell>
                <TableHeaderCell className={styles.numCell ?? ""}>
                  Cache Hit
                </TableHeaderCell>
                <TableHeaderCell>Est. Cost</TableHeaderCell>
                <TableHeaderCell className={styles.numCell ?? ""}>
                  Turns
                </TableHeaderCell>
                <TableHeaderCell>Last Active</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* Totals row */}
              <tr className={styles.totalsRow ?? ""}>
                <td className={styles.labelCell ?? ""}>
                  Σ total{" "}
                  <span className={styles.groupCount ?? ""}>
                    ({displayRows.length})
                  </span>
                </td>
                <td className={styles.numCell ?? ""}>
                  {fmtTokens(totalInput)}
                </td>
                <td className={styles.numCell ?? ""}>
                  {fmtTokens(totalOutput)}
                </td>
                <td className={styles.numCell ?? ""}>
                  {fmtTokens(totalCacheRead)}
                </td>
                <td className={styles.numCell ?? ""}>{totalCacheHitPct}%</td>
                <td className={styles.costCell ?? ""}>
                  <span className={styles.costLabel ?? ""}>
                    ~{fmtCost(totalCost)}
                  </span>
                </td>
                <td className={styles.numCell ?? ""}>{totalTurns}</td>
                <td />
              </tr>

              {displayRows.map((row, i) => {
                if (row.type === "standalone") {
                  return (
                    <UsageDataRow
                      key={row.data.sessionId + String(i)}
                      label={row.data.label}
                      channel={row.data.channel}
                      data={row.data}
                      maxCost={maxCost}
                    />
                  );
                }

                const isExpanded = Boolean(expandedGroups[row.base]);
                return (
                  <GroupRow
                    key={`group-${row.base}`}
                    row={row}
                    maxCost={maxCost}
                    isExpanded={isExpanded}
                    onToggle={() => {
                      toggleGroup(row.base);
                    }}
                  />
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
