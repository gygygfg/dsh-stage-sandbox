// WinStage sandbox probe 2: can Node create directories? under real vs staged parents?
// Run: node dir-probe2.js <realParent> <stagedParent>
const fs = require('fs');
const path = require('path');

const realParent = process.argv[2];   // exists on real disk (e.g. ...\_sandbox-tests)
const stagedParent = process.argv[3]; // created inside sandbox -> staged only (e.g. ...\node)

function line(tag, fn) {
  try { const r = fn(); console.log(tag + ' => OK ' + (r === undefined ? '' : r)); }
  catch (e) { console.log(tag + ' => THREW ' + e.code + ' | ' + e.message); }
}

console.log('realParent=' + realParent + ' existsSync=' + fs.existsSync(realParent));
console.log('stagedParent=' + stagedParent + ' existsSync=' + fs.existsSync(stagedParent));

// --- single level mkdir under REAL parent ---
const s1 = path.join(realParent, 'nodeprobe-one');
line('U1 mkdirSync(REAL/one,{recursive:false})', () => {
  fs.mkdirSync(s1);
  return 'existsSync=' + fs.existsSync(s1) + ' isDir=' + fs.statSync(s1).isDirectory();
});

// --- recursive nested mkdir under REAL parent ---
const s2 = path.join(realParent, 'nodeprobe-two', 'sub');
line('U2 mkdirSync(REAL/two/sub,{recursive:true})', () => {
  fs.mkdirSync(s2, { recursive: true });
  return 'existsSync=' + fs.existsSync(s2) + ' statRoot=' + fs.existsSync(path.join(realParent, 'nodeprobe-two'));
});

// --- single level mkdir under STAGED-only parent ---
const s3 = path.join(stagedParent, 'nodeprobe-three');
line('U3 mkdirSync(STAGED/three,{recursive:false})', () => {
  fs.mkdirSync(s3);
  return 'existsSync=' + fs.existsSync(s3);
});

// --- write a file into an existing REAL dir ---
line('U4 writeFileSync(REAL/written-by-node.txt)', () => {
  const f = path.join(realParent, 'written-by-node.txt');
  fs.writeFileSync(f, 'node-wrote-this');
  return 'readBack=' + fs.readFileSync(f, 'utf8') + ' size=' + fs.statSync(f).size;
});

// --- write a file into a dir that PowerShell pre-created (passed as argv[3] child) ---
const pre = path.join(realParent, 'psside-precreated');
line('U5 writeFileSync(REAL/psside-precreated/x.txt)', () => {
  const f = path.join(pre, 'x.txt');
  fs.writeFileSync(f, 'into-precreated-dir');
  return 'readBack=' + fs.readFileSync(f, 'utf8');
});

// --- mkdir under a .NET-precreated deep dir ---
const deep = path.join(realParent, 'psdeep', 'a', 'b');
line('U6 mkdirSync(REAL/psdeep/a/b,{recursive:true})', () => {
  fs.mkdirSync(deep, { recursive: true });
  return 'existsSync=' + fs.existsSync(deep);
});

// --- does Node see a dir made by PowerShell? ---
const psOnly = path.join(realParent, 'psonly-dir');
console.log('U7 pre-check fs.existsSync(psonly-dir)=' + fs.existsSync(psOnly));

// --- async variants ---
(async () => {
  const a1 = path.join(realParent, 'anodeprobe-one');
  try { await fs.promises.mkdir(a1); console.log('U8 async mkdir(REAL/async-one) => OK exists=' + fs.existsSync(a1)); }
  catch (e) { console.log('U8 async mkdir(REAL/async-one) => THREW ' + e.code + ' ' + e.message); }

  const a2 = path.join(realParent, 'anodeprobe-two', 'x', 'y');
  try { await fs.promises.mkdir(a2, { recursive: true }); console.log('U9 async mkdir(REAL/async-two/x/y,recursive) => OK exists=' + fs.existsSync(a2)); }
  catch (e) { console.log('U9 async mkdir(REAL/async-two/x/y,recursive) => THREW ' + e.code + ' ' + e.message); }

  // mkdtemp (what many tools use)
  try { const d = fs.mkdtempSync(path.join(realParent, 'mkdtemp-')); console.log('U10 mkdtempSync => ' + d + ' exists=' + fs.existsSync(d)); }
  catch (e) { console.log('U10 mkdtempSync => THREW ' + e.code + ' ' + e.message); }
})();
