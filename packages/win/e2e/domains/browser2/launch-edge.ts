// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// Launch an isolated Edge with GPU workarounds and wait for DevToolsActivePort.
// Usage: node launch-edge.ts <profileDir> <port> <flagGroup>
const [prof, portArg, group] = process.argv.slice(2);
const port = portArg || '9222';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const fs = require('fs');
const { spawn } = require('child_process');

const groups = {
  base: ['--disable-gpu'],
  gpu3: ['--disable-gpu', '--disable-gpu-sandbox', '--disable-software-rasterizer'],
  inproc: ['--disable-gpu', '--disable-gpu-sandbox', '--in-process-gpu', '--disable-software-rasterizer'],
  swift: ['--disable-gpu', '--disable-gpu-sandbox', '--use-gl=swiftshader', '--disable-software-rasterizer'],
  nosandbox: ['--disable-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--disable-software-rasterizer'],
};
const extra = groups[group] || groups.gpu3;

fs.mkdirSync(prof, { recursive: true });
const args = [
  `--user-data-dir=${prof}`,
  `--remote-debugging-port=${port}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  ...extra,
  'about:blank',
];

const errPath = `${prof}\\edge.err.txt`;
const outPath = `${prof}\\edge.out.txt`;
const errFd = fs.openSync(errPath, 'w');
const outFd = fs.openSync(outPath, 'w');
const child = spawn(edge, args, { detached: true, stdio: ['ignore', outFd, errFd] });
child.unref();

const dp = `${prof}\\DevToolsActivePort`;
const started = Date.now();
let found = false;
const timer = setInterval(() => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (fs.existsSync(dp)) {
    const txt = fs.readFileSync(dp, 'utf8');
    console.log(JSON.stringify({ group: group || 'gpu3', port, found: true, elapsed, devtoolsPort: txt.replace(/\r?\n/g, '|') }));
    clearInterval(timer);
    process.exit(0);
  }
  if (Number(elapsed) > 45) {
    let errTail = '';
    try { errTail = fs.readFileSync(errPath, 'utf8').split(/\r?\n/).slice(-8).join(' || '); } catch (e) { errTail = 'ERR:' + e.code; }
    console.log(JSON.stringify({ group: group || 'gpu3', port, found: false, elapsed, errTail }));
    clearInterval(timer);
    process.exit(0);
  }
}, 1000);
