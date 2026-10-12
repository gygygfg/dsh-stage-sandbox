// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// Consolidate all thread deliverables into a compact digest.
import fs from 'node:fs';
import path from 'node:path';

const root = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\_sandbox-tests';
const areas = ['fs', 'browser', 'pip', 'node', 'exe', 'registry', 'network', 'sensitive'];

const rows = [];
const summary = {};
for (const area of areas) {
  const dir = path.join(root, area);
  const resFile = path.join(dir, 'results.json');
  let items = null;
  let err = null;
  if (fs.existsSync(resFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(resFile, 'utf8'));
      items = Array.isArray(j) ? j : (Array.isArray(j.checkpoints) ? j.checkpoints : (Array.isArray(j.results) ? j.results : null));
      if (!items) { for (const k of Object.keys(j)) if (Array.isArray(j[k])) { items = j[k]; break; } }
    } catch (e) { err = e.message; }
  } else err = 'NO results.json';

  const counts = {};
  if (items) for (const it of items) { const s = String(it.status || 'UNKNOWN').toUpperCase(); counts[s] = (counts[s] || 0) + 1; }
  const findings = fs.existsSync(path.join(dir, 'findings.md')) ? fs.statSync(path.join(dir, 'findings.md')).size : 0;
  const exec = fs.existsSync(path.join(dir, 'executions.log')) ? fs.statSync(path.join(dir, 'executions.log')).size : 0;
  const evid = fs.existsSync(path.join(dir, 'evidence')) ? fs.readdirSync(path.join(dir, 'evidence')).length : 0;
  summary[area] = { items: items ? items.length : 0, counts, findingsBytes: findings, execBytes: exec, evidenceFiles: evid, err };

  if (items) for (const it of items) {
    rows.push([area, it.id || '', it.status || '', (it.title || '').slice(0, 70), (it.channel ? [].concat(it.channel).join('+') : '')].join('\t'));
  }
}
console.log('=== SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));
console.log('=== CHECKPOINTS (' + rows.length + ') ===');
console.log(rows.join('\n'));
