// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// ND-03: child_process semantics matrix under WinStage shim
import { spawn, spawnSync, exec, execSync, execFile } from 'node:child_process';

const out = [];
const rec = (id, api, ok, detail) => out.push({ id, api, ok, detail: String(detail) });
const NODE = process.execPath;

function trySpawn(id, label, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NODE, ['-e', 'process.stdout.write("CHILD-OUT"); process.stderr.write("CHILD-ERR")'], opts);
    } catch (e) {
      rec(id, label, false, `spawn-threw ${e.code || e.name}: ${e.message}`);
      return resolve();
    }
    let so = '', se = '';
    if (child.stdout) child.stdout.on('data', d => so += d);
    if (child.stderr) child.stderr.on('data', d => se += d);
    const timer = setTimeout(() => {
      rec(id, label, false, `TIMEOUT(20s) so=${JSON.stringify(so)} se=${JSON.stringify(se)}`);
      try { child.kill(); } catch {}
      resolve();
    }, 20000);
    child.on('error', (e) => {
      clearTimeout(timer);
      rec(id, label, false, `child-error ${e.code || e.name}: ${e.message}`);
      resolve();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      rec(id, label, true, `closed code=${code} capturedOut=${JSON.stringify(so)} capturedErr=${JSON.stringify(se)}`);
      resolve();
    });
  });
}

rec('meta', 'execPath', true, NODE);
rec('meta', 'cwd', true, process.cwd());

await trySpawn('ND03-01', "spawn stdio:'pipe'", { stdio: 'pipe' });
await trySpawn('ND03-02', "spawn stdio:'inherit'", { stdio: 'inherit' });
await trySpawn('ND03-03', "spawn stdio:'ignore'", { stdio: 'ignore' });

// spawnSync pipe
try {
  const r = spawnSync(NODE, ['-e', 'process.stdout.write("SYNC-OUT")'], { stdio: 'pipe', timeout: 20000 });
  rec('ND03-04', "spawnSync stdio:'pipe'", true, `status=${r.status} stdout=${JSON.stringify(String(r.stdout))} stderr=${JSON.stringify(String(r.stderr))} error=${r.error ? (r.error.code + ':' + r.error.message) : 'none'}`);
} catch (e) { rec('ND03-04', "spawnSync stdio:'pipe'", false, `threw ${e.code || e.name}: ${e.message}`); }

try {
  const r = spawnSync(NODE, ['-e', 'process.stdout.write("SYNC-INH")'], { stdio: 'inherit', timeout: 20000 });
  rec('ND03-05', "spawnSync stdio:'inherit'", true, `status=${r.status} error=${r.error ? r.error.message : 'none'}`);
} catch (e) { rec('ND03-05', "spawnSync stdio:'inherit'", false, `threw ${e.code || e.name}: ${e.message}`); }

// execSync
try {
  const s = execSync('"' + NODE + '" -e "process.stdout.write(1+1)"', { encoding: 'utf8', timeout: 20000 });
  rec('ND03-06', 'execSync', true, `out=${JSON.stringify(s)}`);
} catch (e) { rec('ND03-06', 'execSync', false, `threw ${e.code || e.name}: ${e.message}`); }

// exec (async, callback)
await new Promise((resolve) => {
  let done = false;
  const finish = (ok, detail) => { if (!done) { done = true; rec('ND03-07', 'exec (async)', ok, detail); resolve(); } };
  const t = setTimeout(() => finish(false, 'TIMEOUT(20s)'), 20000);
  try {
    exec('"' + NODE + '" -e "process.stdout.write(42)"', { timeout: 15000 }, (err, stdout, stderr) => {
      clearTimeout(t);
      finish(!err, `err=${err ? (err.code + ':' + err.message.split('\n')[0]) : 'none'} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
    });
  } catch (e) { clearTimeout(t); finish(false, `threw ${e.code || e.name}: ${e.message}`); }
});

// execFile
await new Promise((resolve) => {
  let done = false;
  const finish = (ok, detail) => { if (!done) { done = true; rec('ND03-08', 'execFile', ok, detail); resolve(); } };
  const t = setTimeout(() => finish(false, 'TIMEOUT(20s)'), 20000);
  try {
    execFile(NODE, ['-e', 'process.stdout.write("EF")'], { timeout: 15000 }, (err, stdout) => {
      clearTimeout(t);
      finish(!err, `err=${err ? (err.code + ':' + err.message.split('\n')[0]) : 'none'} stdout=${JSON.stringify(stdout)}`);
    });
  } catch (e) { clearTimeout(t); finish(false, `threw ${e.code || e.name}: ${e.message}`); }
});

console.log(JSON.stringify(out, null, 1));
