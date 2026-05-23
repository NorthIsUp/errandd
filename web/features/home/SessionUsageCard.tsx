import { Fragment, type ReactNode, useState } from "react";
import type { SessionUsage } from "../../api/usage";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import {
  Table,
  TableBody,
  TableHead,
  TableRow,
  Td,
  Th,
} from "../../components/Table";
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
  // Pass 1: identify known bases from run-ID sessions (#base:digits)
  const knownBases: Record<string, boolean> = {};
  for (const s of sessions) {
    const base = usageJobBase(s.label, null);
    if (base !== null) knownBases[base] = true;
  }

  // Pass 2: bucket every session
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
    // Initialise agg without cacheHitPct (computed below)
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
  const barPct =
    maxCost > 0
      ? Math.round(((data.estimatedCostUsd ?? 0) / maxCost) * 100)
      : 0;

  const rowCls = child ? styles.groupChild : undefined;

  return (
    <TableRow {...(rowCls !== undefined ? { className: rowCls } : {})}>
      <Td className={styles.labelCell}>
        {prefix}
        {channelIcon(channel)} {label}
      </Td>
      <Td className={styles.numCell}>{fmtTokens(data.inputTokens ?? 0)}</Td>
      <Td className={styles.numCell}>{fmtTokens(data.outputTokens ?? 0)}</Td>
      <Td className={styles.numCell}>{fmtTokens(data.cacheReadTokens ?? 0)}</Td>
      <Td className={styles.numCell}>{data.cacheHitPct ?? 0}%</Td>
      <Td className={styles.costCell}>
        <div className={styles.costWrap}>
          <div className={styles.costBar} style={{ width: `${barPct}%` }} />
          <span className={styles.costLabel}>
            ~{fmtCost(data.estimatedCostUsd ?? 0)}
          </span>
        </div>
      </Td>
      <Td className={styles.numCell}>{data.turnCount ?? 0}</Td>
      <Td className={styles.ageCell}>{fmtRelative(data.lastUsedAt)}</Td>
    </TableRow>
  );
}

export function SessionUsageCard({ sessions, className }: Props) {
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );

  const cardProps = className !== undefined ? { className } : {};

  if (sessions.length === 0) {
    return (
      <Card title="Session Usage" {...cardProps}>
        <EmptyState message="No active sessions found." />
      </Card>
    );
  }

  const displayRows = buildDisplayRows(sessions);

  // Totals across all display rows (standalone + group aggregates)
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
    <Card title="Session Usage" {...cardProps}>
      <Table>
        <TableHead>
          <TableRow>
            <Th>Session</Th>
            <Th className={styles.numCell}>Input</Th>
            <Th className={styles.numCell}>Output</Th>
            <Th className={styles.numCell}>Cache Read</Th>
            <Th className={styles.numCell}>Cache Hit</Th>
            <Th>Est. Cost</Th>
            <Th className={styles.numCell}>Turns</Th>
            <Th>Last Active</Th>
          </TableRow>
        </TableHead>
        <TableBody>
          {/* Totals row */}
          <TableRow className={[styles.totalsRow].filter(Boolean).join(" ")}>
            <Td className={styles.labelCell}>
              Σ total{" "}
              <span className={styles.groupCount}>({displayRows.length})</span>
            </Td>
            <Td className={styles.numCell}>{fmtTokens(totalInput)}</Td>
            <Td className={styles.numCell}>{fmtTokens(totalOutput)}</Td>
            <Td className={styles.numCell}>{fmtTokens(totalCacheRead)}</Td>
            <Td className={styles.numCell}>{totalCacheHitPct}%</Td>
            <Td className={styles.costCell}>
              <span className={styles.costLabel}>~{fmtCost(totalCost)}</span>
            </Td>
            <Td className={styles.numCell}>{totalTurns}</Td>
            <Td />
          </TableRow>

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

            // Parent group row
            const isExpanded = Boolean(expandedGroups[row.base]);
            const parentCls = [
              styles.groupParent,
              isExpanded ? styles.groupExpanded : undefined,
            ]
              .filter(Boolean)
              .join(" ");
            const barPct =
              maxCost > 0
                ? Math.round(((row.data.estimatedCostUsd ?? 0) / maxCost) * 100)
                : 0;

            return (
              <Fragment key={`group-${row.base}`}>
                <TableRow
                  className={parentCls}
                  onClick={() => {
                    toggleGroup(row.base);
                  }}
                >
                  <Td className={styles.labelCell}>
                    <button
                      type="button"
                      className={styles.caret}
                      aria-expanded={isExpanded}
                      aria-label={
                        isExpanded ? "Collapse group" : "Expand group"
                      }
                    >
                      {isExpanded ? "▼" : "▶"}
                    </button>{" "}
                    ⚙️ {row.data.label}{" "}
                    <span className={styles.groupCount}>
                      ({row.children.length} runs)
                    </span>
                  </Td>
                  <Td className={styles.numCell}>
                    {fmtTokens(row.data.inputTokens ?? 0)}
                  </Td>
                  <Td className={styles.numCell}>
                    {fmtTokens(row.data.outputTokens ?? 0)}
                  </Td>
                  <Td className={styles.numCell}>
                    {fmtTokens(row.data.cacheReadTokens ?? 0)}
                  </Td>
                  <Td className={styles.numCell}>
                    {row.data.cacheHitPct ?? 0}%
                  </Td>
                  <Td className={styles.costCell}>
                    <div className={styles.costWrap}>
                      <div
                        className={styles.costBar}
                        style={{ width: `${barPct}%` }}
                      />
                      <span className={styles.costLabel}>
                        ~{fmtCost(row.data.estimatedCostUsd ?? 0)}
                      </span>
                    </div>
                  </Td>
                  <Td className={styles.numCell}>{row.data.turnCount ?? 0}</Td>
                  <Td className={styles.ageCell}>
                    {fmtRelative(row.data.lastUsedAt)}
                  </Td>
                </TableRow>

                {isExpanded &&
                  row.children.map((child, ci) => (
                    <UsageDataRow
                      key={child.sessionId + String(ci)}
                      label={child.label}
                      channel={child.channel}
                      data={child}
                      maxCost={maxCost}
                      child
                      prefix={<span className={styles.childIndent}>↳ </span>}
                    />
                  ))}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
