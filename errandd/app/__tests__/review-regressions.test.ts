import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function isolated(script: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "errandd-review-"));
  try {
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, stderr).toBe(0);
    return stdout;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("saving the fallback model preserves its config shape and credentials", async () => {
  const route = new URL("../ui/routes/settings.ts", import.meta.url).pathname;
  const result = await isolated(`
    import {settingsPut} from ${JSON.stringify(route)};
    await Bun.write('.claude/errandd/settings.json',JSON.stringify({fallback:{model:'sonnet',api:'fixture-key'}}));
    const response=await settingsPut({req:new Request('http://localhost/api/settings',{method:'PUT',body:JSON.stringify({fallback:'opus'})})});
    if(!response.ok) throw Error(await response.text());
    console.log(JSON.stringify((await Bun.file('.claude/errandd/settings.json').json()).fallback));
  `);
  expect(JSON.parse(result)).toEqual({ model: "opus", api: "fixture-key" });
});

test("metadata setters persist prototype-like IDs without polluting Object.prototype", async () => {
  const service = new URL("../ui/services/session-meta.ts", import.meta.url).pathname;
  const result = await isolated(`
    import {setSessionGoal,getSessionGoal} from ${JSON.stringify(service)};
    await setSessionGoal('__proto__','saved safely');
    await setSessionGoal('constructor','another session');
    if(Object.prototype.goal) throw Error('prototype polluted');
    console.log(await getSessionGoal('__proto__'));
  `);
  expect(result.trim()).toBe("saved safely");
});

test("recent log selection considers files beyond the first 200 directory entries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "errandd-log-review-"));
  const service = new URL("../ui/services/logs.ts", import.meta.url).pathname;
  try {
    const dir = join(cwd, ".claude/errandd/logs");
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 201 }, async (_, i) => {
        const path = join(dir, `${String(i).padStart(4, "0")}.log`);
        await writeFile(path, `${i}\n`);
        await utimes(path, i + 1, i + 1);
      }),
    );
    await writeFile(join(dir, "daemon.log"), "old\n".repeat(100000) + "tail 🦞\n");
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import {readLogs} from ${JSON.stringify(service)}; console.log(JSON.stringify(await readLogs(2)));`,
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const result = JSON.parse(await new Response(proc.stdout).text()) as {
      runs: { file: string }[];
      daemonLog: string[];
    };
    expect(await proc.exited).toBe(0);
    expect(result.runs[0]?.file).toBe("0200.log");
    expect(result.daemonLog).toEqual(["tail 🦞"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repo reset remains reachable when self-route predicates gate dispatch", async () => {
  const routes = new URL("../ui/routes/index.ts", import.meta.url).pathname;
  const config = new URL("../config.ts", import.meta.url).pathname;
  const result = await isolated(`
    import {dispatch} from ${JSON.stringify(routes)};
    import {loadSettings} from ${JSON.stringify(config)};
    await Bun.write('.claude/errandd/settings.json','{}');
    await loadSettings();
    const url=new URL('http://localhost/api/jobs/repos/missing/reset');
    const response=await dispatch({req:new Request(url,{method:'POST'}),url,opts:{}});
    console.log(JSON.stringify(await response.json()));
  `);
  expect(JSON.parse(result)).toEqual({ ok: false, error: "repo not found" });
});

test("settings save updates the daemon snapshot before reporting success and preserves unrelated config", async () => {
  const route = new URL("../ui/routes/settings.ts", import.meta.url).pathname;
  const result = await isolated(`
    import {settingsPut} from ${JSON.stringify(route)};
    await Bun.write('.claude/errandd/settings.json',JSON.stringify({model:'opus',fallback:{model:'sonnet',api:'fixture-key'},custom:{keep:true}}));
    let model;
    const response=await settingsPut({req:new Request('http://localhost/api/settings',{method:'PUT',body:JSON.stringify({model:'sonnet'})}),opts:{onSettingsChanged:next=>{model=next.model}}});
    if(!response.ok) throw Error(await response.text());
    const saved=await Bun.file('.claude/errandd/settings.json').json();
    console.log(JSON.stringify({model,custom:saved.custom,fallback:saved.fallback}));
  `);
  expect(JSON.parse(result)).toEqual({
    model: "sonnet",
    custom: { keep: true },
    fallback: { model: "sonnet", api: "fixture-key" },
  });
});

test("invalid timezone edits do not overwrite a working schedule configuration", async () => {
  const route = new URL("../ui/routes/settings.ts", import.meta.url).pathname;
  const result = await isolated(`
    import {settingsPut} from ${JSON.stringify(route)};
    await Bun.write('.claude/errandd/settings.json',JSON.stringify({timezone:'America/Los_Angeles',heartbeat:{enabled:false,interval:60}}));
    const response=await settingsPut({req:new Request('http://localhost/api/settings',{method:'PUT',body:JSON.stringify({timezone:'Not/A-Timezone'})})});
    console.log(JSON.stringify({status:response.status,saved:await Bun.file('.claude/errandd/settings.json').json()}));
  `);
  expect(JSON.parse(result)).toEqual({
    status: 400,
    saved: { timezone: "America/Los_Angeles", heartbeat: { enabled: false, interval: 60 } },
  });
});


test("label migration is on by default, persists through settings saves, and can be disabled without accepting truthy strings", async () => {
  const route = new URL("../ui/routes/settings.ts", import.meta.url).pathname;
  const config = new URL("../config.ts", import.meta.url).pathname;
  const result = await isolated(`
    import {settingsPut} from ${JSON.stringify(route)};
    import {loadSettings,reloadSettings} from ${JSON.stringify(config)};
    await Bun.write('.claude/errandd/settings.json',JSON.stringify({model:'sonnet',unrelated:'preserved'}));
    const before=(await loadSettings()).migrateLegacyClawLabels;
    const invalid=await settingsPut({req:new Request('http://localhost/api/settings',{method:'PUT',body:JSON.stringify({migrateLegacyClawLabels:'true'})})});
    const values=[];
    for(const enabled of [true,false]){
      const response=await settingsPut({req:new Request('http://localhost/api/settings',{method:'PUT',body:JSON.stringify({migrateLegacyClawLabels:enabled})})});
      if(!response.ok)throw Error(await response.text());
      values.push((await reloadSettings()).migrateLegacyClawLabels);
    }
    console.log(JSON.stringify({before,invalid:invalid.status,values,unrelated:(await Bun.file('.claude/errandd/settings.json').json()).unrelated}));
  `);
  expect(JSON.parse(result)).toEqual({before:true,invalid:400,values:[true,false],unrelated:'preserved'});
});
