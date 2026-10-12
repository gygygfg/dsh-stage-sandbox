// WinStage sandbox probe: child_process spawn with different cwd + stdio modes
// Run with: node cwd-spawn-probe.js <mode> [cwd]
//   mode = inherit | ignore | pipe
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mode = process.argv[2] || 'inherit';
const cwd = process.argv[3] || process.cwd();
const nodeExe = process.execPath;

console.log('node=' + process.version);
console.log('mode=' + mode);
console.log('cwd=' + cwd);
console.log('cwd exists (node fs.statSync)=' + (() => { try { fs.statSync(cwd); return 'yes'; } catch (e) { return 'NO: ' + e.code + ' ' + e.message; } })());

// can we chdir to it?
try {
  process.chdir(cwd);
  console.log('process.chdir: ok -> ' + process.cwd());
} catch (e) {
  console.log('process.chdir: FAILED ' + e.code + ' ' + e.message);
}

const opts = { cwd: cwd, encoding: 'utf8' };
let r;
try {
  if (mode === 'pipe') {
    r = spawnSync(nodeExe, ['-e', 'console.log("child-ok")'], opts);
    console.log('spawnSync(pipe) returned');
    console.log('  error=' + (r.error ? r.error.code + ' ' + r.error.message : 'null'));
    console.log('  status=' + r.status);
    console.log('  signal=' + r.signal);
    console.log('  stdout=' + JSON.stringify(r.stdout));
    console.log('  stderr=' + JSON.stringify(r.stderr));
  } else {
    r = spawnSync(nodeExe, ['-e', 'console.log("child-ok cwd=" + process.cwd())'], { cwd: cwd, stdio: mode });
    console.log('spawnSync(' + mode + ') returned');
    console.log('  error=' + (r.error ? r.error.code + ' ' + r.error.message : 'null'));
    console.log('  status=' + r.status);
    console.log('  signal=' + r.signal);
  }
} catch (e) {
  console.log('spawnSync THREW: ' + e.code + ' ' + e.message);
}
