// Decisive probe: overlay vs stat/readdir/require in Node
const fs = require('fs');
const path = require('path');
const REAL = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\_sandbox-tests';
const MINE = REAL + '\\node';

function t(tag, fn) { try { console.log(tag + ' => OK ' + fn()); } catch (e) { console.log(tag + ' => THREW ' + e.code + ' | ' + e.message); } }

// 1. write a NEW file into a real (pre-existing) dir, then stat/read it
const p = REAL + '\\nodestat-probe.txt';
t('W1 writeFileSync(REAL/new-file)', () => { fs.writeFileSync(p, 'hello-overlay'); return 'written'; });
t('W2 readFileSync(same)', () => fs.readFileSync(p, 'utf8'));
t('W3 existsSync(same)', () => String(fs.existsSync(p)));
t('W4 statSync(same)', () => 'size=' + fs.statSync(p).size);
t('W5 lstatSync(same)', () => 'size=' + fs.lstatSync(p).size);

// 2. stat a file that exists on the REAL disk (PROTOCOL.md)
t('W6 statSync(REAL/PROTOCOL.md) [real-disk file]', () => 'size=' + fs.statSync(REAL + '\\PROTOCOL.md').size);

// 3. stat a dir created by PowerShell earlier this session (overlay-only)
t('W7 existsSync(REAL/psonly-dir) [PS-created]', () => String(fs.existsSync(REAL + '\\psonly-dir')));
t('W8 statSync(REAL/psonly-dir) [PS-created]', () => 'isDir=' + fs.statSync(REAL + '\\psonly-dir').isDirectory());

// 4. stat a file created by PowerShell (overlay-only)
t('W9 statSync(REAL/psside-precreated/x.txt) [PS-created dir + node-written file]', () => 'size=' + fs.statSync(REAL + '\\psside-precreated\\x.txt').size);

// 5. readdir of a real dir: does it merge overlay entries?
t('W10 readdirSync(REAL) ', () => JSON.stringify(fs.readdirSync(REAL)));
t('W11 readdirSync(MINE)', () => JSON.stringify(fs.readdirSync(MINE)));

// 6. require a directory-based module that lives only in the overlay
t('W12 require(overlay dir module)', () => JSON.stringify(require(MINE + '\\reqprobe')));

// 7. require a file
t('W13 require(overlay .js file)', () => JSON.stringify(require(MINE + '\\reqprobe\\index.js')));

// 8. fs.realpathSync
t('W14 realpathSync(REAL/nodestat-probe.txt)', () => fs.realpathSync(p));

// 9. createReadStream / open
t('W15 fs.openSync read', () => { const fd = fs.openSync(p, 'r'); const n = fs.fstatSync(fd).size; fs.closeSync(fd); return 'fstat.size=' + n; });
