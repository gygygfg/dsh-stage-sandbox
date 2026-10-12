// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// Static classification probe: asks the SAME code review.json uses what each path's verdict is.
// Prints metadata-only verdicts (risk / safety / maskId). Never reads file contents.
const SRC = 'file:///C:/Users/Administrator/Desktop/WinStageSandbox/src/paths.ts'
const RS = 'file:///C:/Users/Administrator/Desktop/WinStageSandbox/dsh-plugin/review-service.ts'
const U = 'C:\\Users\\Administrator'
const LA = U + '\\AppData\\Local'
const RA = U + '\\AppData\\Roaming'
const WS = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const paths = [
  U + '\\.ssh', U + '\\.ssh\\id_rsa', U + '\\.ssh\\id_ed25519', U + '\\.ssh\\known_hosts',
  U + '\\.aws', U + '\\.aws\\credentials',
  U + '\\.azure', U + '\\.azure\\azureProfile.json',
  U + '\\.config\\gcloud', U + '\\.config\\gcloud\\credentials.db',
  U + '\\.dsh', U + '\\.dsh\\.credentials.yaml', U + '\\.dsh\\profiles',
  LA + '\\Google\\Chrome\\User Data\\Default\\Login Data',
  LA + '\\Google\\Chrome\\User Data\\Default\\Cookies',
  LA + '\\Google\\Chrome\\User Data\\Default\\Web Data',
  RA + '\\Microsoft\\Credentials', LA + '\\Microsoft\\Credentials', RA + '\\Microsoft\\Protect',
  U + '\\Documents', U + '\\Desktop', U + '\\Downloads',
  U + '\\.git-credentials', U + '\\.npmrc',
  RA + '\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt',
  U + '\\NTUSER.DAT',
  U + '\\Documents\\id_rsa', U + '\\Documents\\credentials.json', U + '\\Documents\\.env',
  WS + '\\_sandbox-tests\\sensitive\\.env',
  WS + '\\_sandbox-tests\\sensitive\\id_rsa',
  WS + '\\_sandbox-tests\\sensitive\\credentials.json',
  WS + '\\_sandbox-tests\\sensitive\\plain.txt',
]
const { maskReason } = await import(SRC)
let classify = null
try {
  const rs = await import(RS)
  classify = rs.classifyChange
} catch (e) {
  console.error('review-service import failed: ' + e.message)
}
console.log('PATH\tMASK_ID\tMASK_CATEGORY\tRISK\tSAFETY')
for (const p of paths) {
  const m = maskReason(p)
  let risk = '', safety = ''
  if (classify) {
    try {
      const v = classify({ path: p, external: true }, { workspaceRoot: WS })
      risk = v.risk; safety = String(v.safety)
    } catch (e) { risk = 'ERR:' + e.message }
  }
  console.log([p, m ? m.id : '(none)', m ? m.reason.replace(/\s+/g, ' ').slice(0, 60) : '', risk, safety].join('\t'))
}
