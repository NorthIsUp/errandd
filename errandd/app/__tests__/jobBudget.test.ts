import { expect, test } from 'bun:test';
import { ClaudeRuntime } from '../runtime/claude';
import { parseClaudeRuntimeStream } from '../runtime/claude/stream';
import { BUDGET_STOP_EXIT_CODE, jobBudgetPatch, parseJobBudgets } from '../jobBudget';
import { nextQueueAction } from '../hookQueue';
import type { RuntimeResult } from '../runtime/types';
const security = { level: 'moderate' as const, allowedTools: [], disallowedTools: [] };

test('a budgeted agent invocation passes the native spend cap, while unbudgeted chat argv stays unchanged', () => {
  const rt = new ClaudeRuntime(), base = { prompt: 'test', outputMode: 'stream' as const, model: 'claude-sonnet-5-5', security, jobsRepoArgs: [] };
  const args = rt.buildRunArgs({ ...base, maxBudgetUsd: 5 });
  expect(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '5']);
  expect(rt.buildRunArgs(base)).not.toContain('--max-budget-usd');
});
test('the CLI budget-stop event survives stream normalization even when no final text exists', async () => {
  let result: RuntimeResult | undefined;
  await parseClaudeRuntimeStream(new Blob([JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.1, session_id: 'session', usage: {} }) + '\n']).stream(), { onResult: value => { result = value; } });
  expect(result?.budgetExceeded).toBe(true);
  expect(result?.totalCostUsd).toBe(5.1);
});
test('a budget stop cannot buy another retry, including when a rate-limit string is also present', () => {
  for (const rateLimited of [true, false]) {
    const decision = nextQueueAction({ exitCode: BUDGET_STOP_EXIT_CODE, rateLimited, rateLimitResetAt: 0, priorAttempts: 0, cap: 5, now: 0 });
    expect(decision.action).toBe('fail');
    expect(decision.error).toContain('Spend cap');
  }
});
test('limits have bounded defaults and invalid, zero, infinite or unknown settings are rejected at the write boundary', () => {
  const current = parseJobBudgets(undefined);
  expect(current).toEqual({ enabled: true, maxUsd: 5, securityMaxUsd: 10 });
  for (const value of [0, -1, Infinity, NaN, 101, '5']) expect(() => jobBudgetPatch({ maxUsd: value }, current)).toThrow();
  expect(() => jobBudgetPatch({ mystery: true }, current)).toThrow();
  expect(jobBudgetPatch({ maxUsd: 2 }, current).securityMaxUsd).toBe(10);
  expect(jobBudgetPatch({ enabled: false }, current).enabled).toBe(false);
});
