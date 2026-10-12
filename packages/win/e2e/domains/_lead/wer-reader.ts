// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
import fs from 'node:fs';
const dir = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.dshstage\\sessions\\session-eb7c901d-97ed-4f83-9096-33c97138c361\\staged\\fs\\%ALLUSERSPROFILE%\\Microsoft\\Windows\\WER\\ReportArchive';
const out = [];
if (!fs.existsSync(dir)) { console.log('NO_DIR'); process.exit(0); }
for (const sub of fs.readdirSync(dir)) {
  const p = dir + '\\' + sub + '\\Report.wer';
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  // WER reports are UTF-16LE; decode and keep only the lines we care about
  const txt = buf.toString('utf16le');
  const want = [];
  for (const line of txt.split(/\r?\n/)) {
    if (/^(Sig\[|DynamicSig\[|AppName|AppPath|EventType|EventTime|Response\.type|FriendlyEventName|LoadedModule\[0\]=|OsInfo\[0\]|ReportDescription)/.test(line)) want.push(line);
  }
  out.push({ report: sub, bytes: buf.length, fields: want.slice(0, 14) });
}
console.log(JSON.stringify(out, null, 2));
