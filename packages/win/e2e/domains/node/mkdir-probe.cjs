// WinStage sandbox probe: Node fs.mkdir semantics under the staging overlay
// Run: node mkdir-probe.js <baseDir>
const fs = require('fs');
const path = require('path');

const base = process.argv[2];
console.log('base=' + base);
console.log('process.cwd()=' + process.cwd());

function report(tag, fn) {
  try {
    const r = fn();
    console.log(tag + ' => OK' + (r === undefined ? '' : ' ' + r));
    return true;
  } catch (e) {
    console.log(tag + ' => THREW ' + e.code + ' | ' + e.message);
    return false;
  }
}

// T1: deep recursive mkdir, single call
const p1 = path.join(base, 'a', 'b', 'c');
report('T1 mkdirSync(deep,{recursive:true})', () => {
  fs.mkdirSync(p1, { recursive: true });
  return 'existsSync=' + fs.existsSync(p1) + ' statIsDir=' + fs.statSync(p1).isDirectory();
});

// T2: same path again, recursive (should be idempotent, no throw)
report('T2 mkdirSync(same,{recursive:true}) again', () => {
  fs.mkdirSync(p1, { recursive: true });
  return 'existsSync=' + fs.existsSync(p1);
});

// T3: non-recursive mkdir on existing path
report('T3 mkdirSync(existing, non-recursive)', () => {
  fs.mkdirSync(p1);
  return 'no error (idempotent)';
});

// T4: write a file into the deep dir
report('T4 writeFileSync into deeper dir', () => {
  const f = path.join(p1, 'x.txt');
  fs.writeFileSync(f, 'hello-staging');
  return 'readBack=' + fs.readFileSync(f, 'utf8') + ' size=' + fs.statSync(f).size;
});

// T5: parallel recursive mkdir race on the SAME fresh deep path (what cacache does)
const p5 = path.join(base, 'race', 'sh', '6d', '93');
report('T5 parallel mkdir x2 (recursive, same path)', () => {
  const results = [];
  const sync = [];
  for (let i = 0; i < 3; i++) sync.push(i);
  sync.forEach(() => {
    try { fs.mkdirSync(p5, { recursive: true }); results.push('ok'); }
    catch (e) { results.push('THREW ' + e.code); }
  });
  return 'results=' + JSON.stringify(results) + ' existsSync=' + fs.existsSync(p5);
});

// T6: async Promise.all race (closest to cacache)
(async () => {
  const p6 = path.join(base, 'race2', 'sh', 'ab');
  const r = await Promise.allSettled([
    fs.promises.mkdir(p6, { recursive: true }),
    fs.promises.mkdir(p6, { recursive: true }),
    fs.promises.mkdir(path.dirname(p6), { recursive: true }),
  ]);
  console.log('T6 Promise.all mkdir => ' + JSON.stringify(r.map(x => x.status === 'fulfilled' ? 'ok' : (x.reason.code + '|' + x.reason.message))));
  console.log('T6 existsSync=' + fs.existsSync(p6));

  // T7: mkdir of the temp dir npm uses for atomic rename
  const p7 = path.join(base, 'tmpdir-probe');
  try { await fs.promises.mkdir(p7, { recursive: true }); console.log('T7 async mkdir tmpdir => ok exists=' + fs.existsSync(p7)); }
  catch (e) { console.log('T7 async mkdir tmpdir => THREW ' + e.code + ' ' + e.message); }

  // T8: realpath / stat of the deep dir (what npm does after mkdir)
  try { console.log('T8 fs.realpathSync(p1)=' + fs.realpathSync(p1)); }
  catch (e) { console.log('T8 fs.realpathSync(p1) THREW ' + e.code + ' ' + e.message); }

  // T9: rename into a fresh shard dir, imitating cacache move-file
  const tmp = path.join(base, 'tmp-probe.bin');
  const dest = path.join(base, 'race3', 'sh', 'cd', 'tmp-probe.bin');
  try {
    fs.writeFileSync(tmp, 'payload');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
    console.log('T9 moveFile emulate => ok exists=' + fs.existsSync(dest) + ' size=' + fs.statSync(dest).size);
  } catch (e) {
    console.log('T9 moveFile emulate => THREW ' + e.code + ' ' + e.message);
  }
})();
