import { expect, test } from 'bun:test';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the real runner treats native budget exhaustion as terminal even with a rate-limit message and configured fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errandd-budget-runner-'));
  const bin = join(dir, 'bin'), capture = join(dir, 'calls.jsonl');
  const app = join(import.meta.dir, '..');
  try {
    await mkdir(bin);
    await mkdir(join(dir, '.claude/errandd'), { recursive: true });
    await writeFile(join(dir, '.claude/errandd/settings.json'), JSON.stringify({ runtime: 'claude', model: 'sonnet', api: 'test-key', fallback: { model: 'opus', api: 'fallback-key' }, jobsRepos: [], security: { level: 'locked' } }));
    const fixture = join(bin, 'claude');
    await writeFile(fixture, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(process.env.BUDGET_TEST_CAPTURE, JSON.stringify(process.argv.slice(2))+'\\n');\nconsole.error('rate limit exceeded');\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}));\nconsole.log(JSON.stringify({type:'result',subtype:'error_max_budget_usd',is_error:true,total_cost_usd:5.1,usage:{},session_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}));\n`);
    await chmod(fixture, 0o755);
    const script = `import { loadSettings } from ${JSON.stringify(join(app, 'config.ts'))};\nimport { run } from ${JSON.stringify(join(app, 'runner.ts'))};\nawait loadSettings();\nconst result=await run('budget-test','test','budget-thread','sonnet',5000,undefined,'job',undefined,undefined,{runtime:'claude',maxBudgetUsd:5});\nconsole.log('RESULT '+JSON.stringify(result));\nprocess.exit(0);`;
    const proc = Bun.spawn([process.execPath, '-e', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUDGET_TEST_CAPTURE: capture, ERRANDD_RUNTIME: 'claude', ERRANDD_MODEL: 'sonnet', ERRANDD_API: 'test-key' } });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('"exitCode":78');
    expect(stdout).toContain('automatic retries are disabled');
    const calls: string[][] = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--max-budget-usd');
    expect(calls[0]).not.toContain('opus');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20_000);

test('a budgeted run whose --resume session is gone retries once as a fresh session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'errandd-budget-stale-'));
  const bin = join(dir, 'bin'), capture = join(dir, 'calls.jsonl');
  const app = join(import.meta.dir, '..');
  try {
    await mkdir(bin);
    await mkdir(join(dir, '.claude/errandd'), { recursive: true });
    await writeFile(join(dir, '.claude/errandd/settings.json'), JSON.stringify({ runtime: 'claude', model: 'sonnet', api: 'test-key', jobsRepos: [], security: { level: 'locked' } }));
    const fixture = join(bin, 'claude');
    // Like a fresh sandbox pod: any --resume fails; a new session succeeds.
    await writeFile(fixture, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst a=process.argv.slice(2);\nappendFileSync(process.env.BUDGET_TEST_CAPTURE, JSON.stringify(a)+'\\n');\nif (a.includes('--resume')) { console.error('No conversation found with session ID: '+a[a.indexOf('--resume')+1]); process.exit(1); }\nconsole.log(JSON.stringify({type:'system',subtype:'init',session_id:'11111111-2222-3333-4444-555555555555'}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done',total_cost_usd:0.1,usage:{},session_id:'11111111-2222-3333-4444-555555555555'}));\n`);
    await chmod(fixture, 0o755);
    const script = `import { loadSettings } from ${JSON.stringify(join(app, 'config.ts'))};\nimport { run } from ${JSON.stringify(join(app, 'runner.ts'))};\nimport { createThreadSession } from ${JSON.stringify(join(app, 'sessionManager.ts'))};\nawait loadSettings();\nawait createThreadSession('stale-thread','99999999-0000-4000-8000-000000000000');\nconst result=await run('budget-test','test','stale-thread','sonnet',5000,undefined,'job',undefined,undefined,{runtime:'claude',maxBudgetUsd:5});\nconsole.log('RESULT '+JSON.stringify(result));\nprocess.exit(0);`;
    const proc = Bun.spawn([process.execPath, '-e', script], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUDGET_TEST_CAPTURE: capture, ERRANDD_RUNTIME: 'claude', ERRANDD_MODEL: 'sonnet', ERRANDD_API: 'test-key' } });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    expect(stdout).toContain('"exitCode":0');
    const calls: string[][] = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--resume');
    expect(calls[1]).not.toContain('--resume');
    expect(calls[1]).toContain('--max-budget-usd');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20_000);
