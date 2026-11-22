/**
 * `src/nt/apply-manifest.ts` 单测：CAS 预检、冲突零写、路径安全、写入顺序。
 *
 * @module winstage-sandbox/tests/nt/apply-manifest
 */

import { pathDepth, planApply, validateApplyManifest, type ApplyManifest } from '../../src/nt/apply-manifest.ts'
import { check, eq, runSuite, section, throwsCode } from './harness.ts'

const H = (n: string) => n.repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a')

const workspace = 'C:\\work\\proj'
const blobRoot = 'D:\\dshnt\\store\\s1\\blobs'

function manifest(overrides: Partial<ApplyManifest> = {}): ApplyManifest {
  return {
    workspaceRoot: workspace,
    candidateId: 'cs_001',
    expectedBase: {
      'src\\b.ts': H('b'),
      'src\\c.ts': H('c'),
    },
    changes: [
      { rel: 'src\\a.ts', kind: 'created', afterSha256: H('a'), afterBlob: `${blobRoot}\\${H('a')}` },
      { rel: 'src\\b.ts', kind: 'modified', beforeSha256: H('b'), afterSha256: H('d'), afterBlob: `${blobRoot}\\${H('d')}` },
      { rel: 'src\\c.ts', kind: 'deleted', beforeSha256: H('c') },
    ],
    ...overrides,
  }
}

await runSuite('nt-apply-manifest', async () => {
  section('1. 合法 manifest')
  const valid = validateApplyManifest(manifest(), { blobRoot })
  eq('规范化工作区', valid.workspaceRoot, 'c:\\work\\proj')
  eq('changes 数量', valid.changes.length, 3)
  eq('相对路径规范化', valid.changes[0].rel, 'src\\a.ts')

  section('2. 预检通过 → 写入顺序')
  const current = (rel: string): string | undefined => {
    if (rel === 'src\\b.ts') return H('b')
    if (rel === 'src\\c.ts') return H('c')
    return undefined
  }
  const plan = planApply(manifest(), current, { blobRoot })
  eq('writes 含 a/b', plan.writes.map((c) => c.rel), ['src\\a.ts', 'src\\b.ts'])
  eq('deletes 含 c', plan.deletes.map((c) => c.rel), ['src\\c.ts'])
  eq('写父目录浅的先写', plan.writes[0].rel, 'src\\a.ts')

  section('3. 冲突 → 整批零写')
  throwsCode(
    'modified 基线不符冲突',
    () => planApply(manifest(), (rel) => (rel === 'src\\b.ts' ? H('x') : rel === 'src\\c.ts' ? H('c') : undefined), { blobRoot }),
    'NT_APPLY_CONFLICT',
  )
  throwsCode(
    'created 路径已存在冲突',
    () => planApply(manifest(), (rel) => (rel === 'src\\a.ts' ? H('a') : rel === 'src\\b.ts' ? H('b') : H('c')), { blobRoot }),
    'NT_APPLY_CONFLICT',
  )
  throwsCode(
    'deleted 路径已消失冲突',
    () => planApply(manifest(), (rel) => (rel === 'src\\b.ts' ? H('b') : undefined), { blobRoot }),
    'NT_APPLY_CONFLICT',
  )

  section('4. manifest 非法（数据错误，不是冲突）')
  throwsCode(
    'created 不应在 expectedBase',
    () =>
      validateApplyManifest(
        manifest({ expectedBase: { 'src\\a.ts': H('a'), 'src\\b.ts': H('b'), 'src\\c.ts': H('c') } }),
        { blobRoot },
      ),
    'NT_APPLY_DENIED',
  )
  throwsCode(
    'modified 必须在 expectedBase',
    () =>
      validateApplyManifest(
        manifest({
          expectedBase: { 'src\\c.ts': H('c') },
        }),
        { blobRoot },
      ),
    'NT_APPLY_DENIED',
  )
  throwsCode(
    '重复 change 路径',
    () =>
      validateApplyManifest(
        manifest({
          changes: [
            { rel: 'src\\a.ts', kind: 'created', afterSha256: H('a'), afterBlob: `${blobRoot}\\a` },
            { rel: 'SRC\\A.TS', kind: 'created', afterSha256: H('a'), afterBlob: `${blobRoot}\\a` },
          ],
        }),
        { blobRoot },
      ),
    'NT_APPLY_DENIED',
  )
  throwsCode(
    '路径 .. 逃逸',
    () =>
      validateApplyManifest(
        manifest({ changes: [{ rel: '..\\a.ts', kind: 'created', afterSha256: H('a'), afterBlob: `${blobRoot}\\a` }] }),
        { blobRoot },
      ),
    'NT_PATH_ESCAPE',
  )
  throwsCode(
    'ADS 路径',
    () =>
      validateApplyManifest(
        manifest({ changes: [{ rel: 'a.txt:secret', kind: 'created', afterSha256: H('a'), afterBlob: `${blobRoot}\\a` }] }),
        { blobRoot },
      ),
    'NT_UNSUPPORTED_PATH',
  )
  throwsCode(
    '非法 afterSha256',
    () =>
      validateApplyManifest(
        manifest({ changes: [{ rel: 'a.ts', kind: 'created', afterSha256: 'nope', afterBlob: `${blobRoot}\\a` }] }),
        { blobRoot },
      ),
    'NT_APPLY_DENIED',
  )
  throwsCode(
    'afterBlob 必须在 blobRoot 内',
    () =>
      validateApplyManifest(
        manifest({ changes: [{ rel: 'a.ts', kind: 'created', afterSha256: H('a'), afterBlob: 'C:\\evil\\a' }] }),
        { blobRoot },
      ),
    'NT_APPLY_DENIED',
  )
  throwsCode(
    'candidateId 非法',
    () => validateApplyManifest(manifest({ candidateId: '..\\x' }), { blobRoot }),
    'NT_APPLY_DENIED',
  )
  throwsCode(
    '空 changes',
    () => validateApplyManifest(manifest({ changes: [] }), { blobRoot }),
    'NT_APPLY_DENIED',
  )

  section('5. 删除顺序：子路径深的先删')
  const deep = manifest({
    expectedBase: { 'a\\b\\c.txt': H('1'), 'a\\b.txt': H('2') },
    changes: [
      { rel: 'a\\b\\c.txt', kind: 'deleted', beforeSha256: H('1') },
      { rel: 'a\\b.txt', kind: 'deleted', beforeSha256: H('2') },
    ],
  })
  const deepPlan = planApply(deep, (rel) => (rel === 'a\\b\\c.txt' ? H('1') : H('2')), { blobRoot })
  eq('深层先删', deepPlan.deletes.map((c) => c.rel), ['a\\b\\c.txt', 'a\\b.txt'])
  eq('pathDepth', pathDepth('a\\b\\c.txt'), 3)

  section('6. 冲突 details 可机读')
  try {
    planApply(manifest(), (rel) => (rel === 'src\\b.ts' ? H('x') : rel === 'src\\c.ts' ? H('c') : undefined), { blobRoot })
    check('应当抛冲突', false)
  } catch (error) {
    const details = (error as { details?: { conflicts?: Array<{ rel: string; expected?: string; actual?: string }> } }).details
    check('冲突带 conflicts 数组', Array.isArray(details?.conflicts))
    eq('冲突路径为 b', details?.conflicts?.[0]?.rel, 'src\\b.ts')
    check('冲突声明 zeroWrite', (error as { details?: { zeroWrite?: boolean } }).details?.zeroWrite === true)
  }
})
