// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// Corrected classification probe.
// Why: inside a shimmed child process canonical()/realpathSync returns the STAGED path
// (C:\...\.dshstage\sessions\...\staged\fs\C\...), and the `stage-store` rule (order 13)
// swallows every later rule. So we (a) prove that artifact, (b) apply MASK_CLASSES regexes
// directly to the REAL path (what the unshimmed host does), with a positive control from
// MASK_PROBES. No file contents are read.
const SRC = 'file:///C:/Users/Administrator/Desktop/WinStageSandbox/src/paths.ts'
const paths = 'file:///C:/Users/Administrator/Desktop/WinStageSandbox/src/paths.ts'
const { MASK_CLASSES, MASK_PROBES, canonical, maskReason } = await import(SRC)
const U = 'C:\\Users\\Administrator'
const LA = U + '\\AppData\\Local'
const RA = U + '\\AppData\\Roaming'
const WS = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const DANGER = new Set(['stage-store','ssh','aws','gcloud','kube','git-credentials','npmrc','dsh-home','dpapi','dpapi-user','browser','sam','sysvol-copy','wifi'])
function lexicalMask(p) {
  for (const r of MASK_CLASSES) if (new RegExp(r.pattern.source, r.pattern.flags).test(p)) return r.id
  return undefined
}
console.log('=== A. POSITIVE CONTROL: MASK_PROBES declared class vs lexicalMatcher ===')
let bad = 0
for (const pr of MASK_PROBES) {
  const got = lexicalMask(pr.path) ?? '(none)'
  const ok = got === pr.maskClass
  if (!ok) bad++
  if (!ok) console.log(`MISMATCH ${pr.id} declared=${pr.maskClass} got=${got} path=${pr.path}`)
}
console.log(`positive-control: ${MASK_PROBES.length - bad}/${MASK_PROBES.length} matched`)
console.log('=== B. SHIM ARTIFACT: canonical() inside a shimmed process ===')
for (const p of [U + '\\Documents', U + '\\.azure', LA + '\\Microsoft\\Credentials', U + '\\.dsh']) {
  let c = '?'
  try { c = canonical(p) } catch (e) { c = 'ERR:' + e.message }
  const m = maskReason(p)
  console.log(`${p}\n   canonical -> ${c}\n   maskReason(real arg) -> ${m ? m.id : '(none)'}  [lexical would be ${lexicalMask(p) ?? '(none)'}]`)
}
console.log('=== C. INTENDED VERDICT (lexical, = unshimmed host) ===')
const targets = [
  U + '\\.ssh', U + '\\.ssh\\id_rsa', U + '\\.ssh\\id_ed25519', U + '\\.ssh\\known_hosts',
  U + '\\.aws', U + '\\.aws\\credentials', U + '\\.azure', U + '\\.azure\\azureProfile.json',
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
  U + '\\Documents\\secret.docx', U + '\\Documents\\secret.pdf', U + '\\Documents\\secret.xlsx', U + '\\Documents\\photo.jpg',
  WS + '\\_sandbox-tests\\sensitive\\.env', WS + '\\_sandbox-tests\\sensitive\\id_rsa',
  WS + '\\_sandbox-tests\\sensitive\\credentials.json', WS + '\\_sandbox-tests\\sensitive\\plain.txt',
  U + '\\.ssh\\dsh-sensitive-probe.txt', U + '\\Documents\\dsh-sensitive-probe.txt',
  U + '\\.dsh\\dsh-sensitive-probe.txt', LA + '\\Microsoft\\Credentials\\dsh-sensitive-probe.txt',
]
console.log('PATH\tMASK_ID\tSAFETY(if masked)\tRISK')
for (const p of targets) {
  const id = lexicalMask(p)
  const safety = id ? (DANGER.has(id) ? 'danger' : 'risk') : ''
  const risk = id ? 'sensitive' : (p.startsWith(WS) ? 'normal(inside ws)' : 'outside')
  console.log([p, id ?? '(none)', safety, risk].join('\t'))
}
