// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// Compact digest of the WinStage review artifact (single pass, avoids dumping raw JSON).
import fs from 'node:fs';

const s = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.dshstage\\sessions\\session-eb7c901d-97ed-4f83-9096-33c97138c361\\review.json';
const raw = fs.readFileSync(s, 'utf8');
let o;
try { o = JSON.parse(raw); } catch (e) { console.log('PARSE_FAIL ' + e.message); process.exit(0); }

const files = o.files || [];
const cands = o.candidates || [];
const enc = o.entries || [];

const risk = {};
const op = {};
let noise = { pwshPolicy: 0, shimSelfcheck: 0, shimlog: 0, injectJson: 0, real: 0 };
for (const f of files) {
  risk[f.risk] = (risk[f.risk] || 0) + 1;
  op[f.op] = (op[f.op] || 0) + 1;
  const p = f.path || '';
  if (p.includes('__PSScriptPolicyTest_')) noise.pwshPolicy++;
  else if (p.includes('winstage-shim-selfcheck-')) noise.shimSelfcheck++;
  else if (p === 'shim.log') noise.shimlog++;
  else if (p.startsWith('.winstage-inject-')) noise.injectJson++;
  else noise.real++;
}
const candStatus = {};
for (const c of cands) candStatus[c.status] = (candStatus[c.status] || 0) + 1;

// Does the approval surface contain the sensitive writes the threads reported?
const probes = ['.ssh', '.dsh', 'dsh-exfil-secret', 'Documents', 'Microsoft\\Credentials', '%ALLUSERSPROFILE%', 'pip.ini', '.npmrc', 'node_modules', 'Program Files', 'HKCU', 'HKLM'];
const hits = {};
for (const p of probes) {
  hits[p] = files.filter((f) => (f.path || '').includes(p)).length;
}

console.log(JSON.stringify({
  revision: o.revision, pending: o.pending, generatedAt: o.generatedAt,
  fileCount: files.length, candidates: cands.length, alerts: (o.alerts || []).length,
  counts: o.counts, riskCounts: o.riskCounts, myRiskTally: risk, opTally: op,
  noiseBreakdown: noise, candidateStatuses: candStatus,
  pathProbeHits: hits,
  queueBytes: fs.statSync(s.replace('review.json', 'queue.json')).size,
  manifestEntries: JSON.parse(fs.readFileSync(s.replace('review.json', 'manifest.json'), 'utf8')).entries ? Object.keys(JSON.parse(fs.readFileSync(s.replace('review.json', 'manifest.json'), 'utf8')).entries).length : null,
}, null, 2));
