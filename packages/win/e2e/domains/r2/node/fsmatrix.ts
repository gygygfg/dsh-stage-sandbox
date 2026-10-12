// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// ND-02: Node filesystem semantics matrix under WinStage shim
// Run: node fsmatrix.ts
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const out = [];
const rec = (id, api, ok, detail) => out.push({ id, api, ok, detail: String(detail) });
const t = (id, api, fn) => {
  try {
    const r = fn();
    rec(id, api, true, r === undefined ? 'ok' : JSON.stringify(r));
  } catch (e) {
    rec(id, api, false, `${e.code || e.name}: ${e.message}`);
  }
};

const base = process.argv[2] || process.cwd();
const probeDir = path.resolve(base, 'probe');
const f1 = path.join(probeDir, 'n1.txt');
const f2 = path.join(probeDir, 'n2.txt');
const newDir = path.join(probeDir, 'newdir-node');

rec('meta', 'cwd', true, process.cwd());
rec('meta', 'argv[2]/base', true, base);
rec('meta', 'probeDir', true, probeDir);
rec('meta', 'platform/node', true, `${process.platform} ${process.version}`);
rec('meta', 'env.WINSTAGE_STAGE_ROOT', true, JSON.stringify(process.env.WINSTAGE_STAGE_ROOT ?? null));
rec('meta', 'env.WINSTAGE_SHIM_DISABLE', true, JSON.stringify(process.env.WINSTAGE_SHIM_DISABLE ?? null));

// 0. baseline: does probe dir exist / enumerate
t('ND02-00', 'existsSync(probeDir)', () => fs.existsSync(probeDir));
t('ND02-01', 'statSync(probeDir)', () => { const s = fs.statSync(probeDir); return { isDir: s.isDirectory(), size: s.size }; });
t('ND02-02', 'readdirSync(probeDir)', () => fs.readdirSync(probeDir));

// 1. writeFileSync -> existsSync -> statSync -> readFileSync
t('ND02-03', 'writeFileSync(n1.txt)', () => { fs.writeFileSync(f1, 'ND02-PAYLOAD-1'); return 'returned-ok'; });
t('ND02-04', 'existsSync(n1.txt)', () => fs.existsSync(f1));
t('ND02-05', 'statSync(n1.txt)', () => { const s = fs.statSync(f1); return { size: s.size, isFile: s.isFile() }; });
t('ND02-06', 'readFileSync(n1.txt)', () => fs.readFileSync(f1, 'utf8'));
t('ND02-07', 'readdirSync(probeDir) after write', () => fs.readdirSync(probeDir));

// 2. promises writeFile + stat
await (async () => {
  try {
    await fsp.writeFile(f2, 'ND02-PAYLOAD-2');
    rec('ND02-08', 'fsp.writeFile(n2.txt)', true, 'resolved-ok');
  } catch (e) { rec('ND02-08', 'fsp.writeFile(n2.txt)', false, `${e.code}: ${e.message}`); }
  try {
    const s = await fsp.stat(f2);
    rec('ND02-09', 'fsp.stat(n2.txt)', true, JSON.stringify({ size: s.size }));
  } catch (e) { rec('ND02-09', 'fsp.stat(n2.txt)', false, `${e.code}: ${e.message}`); }
  try {
    const d = await fsp.readdir(probeDir);
    rec('ND02-10', 'fsp.readdir(probeDir)', true, JSON.stringify(d));
  } catch (e) { rec('ND02-10', 'fsp.readdir(probeDir)', false, `${e.code}: ${e.message}`); }
})();

// 3. openSync / fstatSync / writeSync / fsync / close
t('ND02-11', 'openSync(n3.txt,"w")', () => {
  let fd;
  try {
    fd = fs.openSync(path.join(probeDir, 'n3.txt'), 'w');
    const st = fs.fstatSync(fd);
    fs.writeSync(fd, 'ND02-PAYLOAD-3');
    fs.fsyncSync(fd);
    return { fd, fstatSizeAtOpen: st.size };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
});
t('ND02-12', 'existsSync(n3.txt) after fd write', () => fs.existsSync(path.join(probeDir, 'n3.txt')));
t('ND02-13', 'readFileSync(n3.txt)', () => fs.readFileSync(path.join(probeDir, 'n3.txt'), 'utf8'));

// 4. mkdirSync
t('ND02-14', 'mkdirSync(newdir-node)', () => { fs.mkdirSync(newDir); return 'returned-ok'; });
t('ND02-15', 'existsSync(newdir-node)', () => fs.existsSync(newDir));
t('ND02-16', 'statSync(newdir-node)', () => { const s = fs.statSync(newDir); return { isDir: s.isDirectory() }; });
t('ND02-17', 'readdirSync(probeDir) after mkdir', () => fs.readdirSync(probeDir));

// 5. mkdtempSync
t('ND02-18', 'mkdtempSync(probeDir/tmp-)', () => fs.mkdtempSync(path.join(probeDir, 'tmp-')));
t('ND02-19', 'tmpdir()', () => os.tmpdir());
t('ND02-20', 'mkdtempSync(os.tmpdir())', () => fs.mkdtempSync(path.join(os.tmpdir(), 'nd02-')));

// 6. appendFileSync / copyFileSync / renameSync
t('ND02-21', 'appendFileSync(n1.txt)', () => { fs.appendFileSync(f1, '+APPEND'); return 'returned-ok'; });
t('ND02-22', 'readFileSync(n1.txt) after append', () => fs.readFileSync(f1, 'utf8'));
t('ND02-23', 'copyFileSync(n1->n4)', () => { fs.copyFileSync(f1, path.join(probeDir, 'n4.txt')); return 'returned-ok'; });
t('ND02-24', 'renameSync(n4->n5)', () => { fs.renameSync(path.join(probeDir, 'n4.txt'), path.join(probeDir, 'n5.txt')); return 'returned-ok'; });
t('ND02-25', 'readdirSync(probeDir) final', () => fs.readdirSync(probeDir));

// 7. rmSync
t('ND02-26', 'rmSync(newdir-node)', () => { fs.rmSync(newDir, { recursive: true, force: true }); return 'returned-ok'; });
t('ND02-27', 'existsSync(newdir-node) after rm', () => fs.existsSync(newDir));

// 8. path / cwd
t('ND02-28', 'path.resolve(".")', () => path.resolve('.'));
t('ND02-29', 'path.resolve(probeDir,"..")', () => path.resolve(probeDir, '..'));
t('ND02-30', 'process.cwd()', () => process.cwd());

// 9. write to nonexistent parent dir
t('ND02-31', 'writeFileSync into nonexistent dir', () => { fs.writeFileSync(path.join(probeDir, 'nodir', 'x.txt'), 'x'); return 'returned-ok'; });

console.log(JSON.stringify(out, null, 1));
