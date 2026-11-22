/**
 * `src/nt/apply.ts` 单测：冲突零写、CAS 校验、原子替换、journal、回滚、undo。
 *
 * 真实文件系统（临时目录）+ 注入的 `resolveBlob`（把 `C:\blobs\...` 映射到临时目录），
 * 因此不需要 Windows 也能验证发布语义。
 *
 * @module winstage-sandbox/tests/nt/apply
 */

import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NtApplyClient } from '../../src/nt/apply.ts'
import type { ApplyManifest } from '../../src/nt/apply-manifest.ts'
import { check, eq, rejectsCode, runSuite, section } from './harness.ts'

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

const WORKSPACE_WIN = 'C:\\work\\proj'
const BLOB_WIN = 'C:\\blobs'

await runSuite('nt-apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dshnt-apply-'))
  const workspace = join(root, 'ws')
  const blobs = join(root, 'blobs')
  const journalRoot = join(root, 'journal')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(blobs, { recursive: true })

  const client = new NtApplyClient({
    workspaceRoot: workspace,
    blobRoot: BLOB_WIN,
    journalRoot,
    // `C:\blobs\<sha>` → 临时目录里的同名文件
    resolveBlob: (blob: string) => join(blobs, blob.split('\\').pop() as string),
    now: () => new Date('2026-11-22T12:00:00.000Z'),
  })

  const baseA = 'base-a\n'
  const baseB = 'base-b\n'
  await writeFile(join(workspace, 'a.txt'), baseA, 'utf8')
  await writeFile(join(workspace, 'src', 'b.txt'), baseB, 'utf8')
  await writeFile(join(workspace, 'gone.txt'), 'gone\n', 'utf8')

  const newA = 'new-a content\n'
  const newB = 'new-b content\n'
  const newC = 'created content\n'
  await writeFile(join(blobs, 'a1'), newA, 'utf8')
  await writeFile(join(blobs, 'b1'), newB, 'utf8')
  await writeFile(join(blobs, 'c1'), newC, 'utf8')

  const manifest = (overrides: Partial<ApplyManifest> = {}): ApplyManifest => ({
    workspaceRoot: WORKSPACE_WIN,
    candidateId: 'cand-1',
    expectedBase: {
      'a.txt': sha256(baseA),
      'src\\b.txt': sha256(baseB),
      'gone.txt': sha256('gone\n'),
    },
    changes: [
      { rel: 'a.txt', kind: 'modified', beforeSha256: sha256(baseA), afterSha256: sha256(newA), afterBlob: `${BLOB_WIN}\\a1` },
      { rel: 'src\\b.txt', kind: 'modified', beforeSha256: sha256(baseB), afterSha256: sha256(newB), afterBlob: `${BLOB_WIN}\\b1` },
      { rel: 'new\\c.txt', kind: 'created', afterSha256: sha256(newC), afterBlob: `${BLOB_WIN}\\c1` },
      { rel: 'gone.txt', kind: 'deleted', beforeSha256: sha256('gone\n') },
    ],
    ...overrides,
  })

  section('1. 成功发布')
  const result = await client.apply(manifest())
  eq('写入数', result.written, 3)
  eq('删除数', result.deleted, 1)
  eq('a.txt 已替换', await readFile(join(workspace, 'a.txt'), 'utf8'), newA)
  eq('src/b.txt 已替换', await readFile(join(workspace, 'src', 'b.txt'), 'utf8'), newB)
  eq('新建 new/c.txt', await readFile(join(workspace, 'new', 'c.txt'), 'utf8'), newC)

  let goneExists = true
  try {
    await stat(join(workspace, 'gone.txt'))
  } catch {
    goneExists = false
  }
  check('gone.txt 已删除', !goneExists)

  const journal = JSON.parse(await readFile(result.journalPath, 'utf8')) as { status: string; entries: Array<{ rel: string; backup?: string }> }
  eq('journal 状态', journal.status, 'applied')
  eq('journal 条目数', journal.entries.length, 4)
  check('journal 记录了备份', journal.entries.some((entry) => entry.backup !== undefined))

  section('2. undo 回到基线')
  await client.undo(result.journalPath)
  eq('a.txt 恢复', await readFile(join(workspace, 'a.txt'), 'utf8'), baseA)
  eq('src/b.txt 恢复', await readFile(join(workspace, 'src', 'b.txt'), 'utf8'), baseB)
  eq('gone.txt 恢复', await readFile(join(workspace, 'gone.txt'), 'utf8'), 'gone\n')
  let createdStillThere = true
  try {
    await stat(join(workspace, 'new', 'c.txt'))
  } catch {
    createdStillThere = false
  }
  check('新建文件被撤销', !createdStillThere)

  section('3. 冲突零写')
  await writeFile(join(workspace, 'a.txt'), 'externally changed\n', 'utf8')
  await rejectsCode('基线不符 → NT_APPLY_CONFLICT', () => client.apply(manifest()), 'NT_APPLY_CONFLICT')
  eq('冲突时其它文件未被写', await readFile(join(workspace, 'src', 'b.txt'), 'utf8'), baseB)
  eq('冲突时删除未发生', await readFile(join(workspace, 'gone.txt'), 'utf8'), 'gone\n')
  await writeFile(join(workspace, 'a.txt'), baseA, 'utf8')

  section('4. CAS blob 哈希不符')
  // created 的 afterSha256 与 blob 内容不一致。
  await rejectsCode(
    'blob 与 afterSha256 不一致 → NT_APPLY_DENIED',
    () =>
      client.apply(
        manifest({
          expectedBase: { 'a.txt': sha256(baseA), 'src\\b.txt': sha256(baseB), 'gone.txt': sha256('gone\n') },
          changes: [
            { rel: 'x.txt', kind: 'created', afterSha256: sha256('something else'), afterBlob: `${BLOB_WIN}\\c1` },
          ],
        }),
      ),
    'NT_APPLY_DENIED',
  )
  let xExists = true
  try {
    await stat(join(workspace, 'x.txt'))
  } catch {
    xExists = false
  }
  check('被拒绝时没有写文件', !xExists)

  section('5. 中途失败 → 回滚')
  const flaky = new NtApplyClient({
    workspaceRoot: workspace,
    blobRoot: BLOB_WIN,
    journalRoot,
    resolveBlob: (blob: string) => join(blobs, blob.split('\\').pop() as string),
    now: () => new Date('2026-11-22T12:10:00.000Z'),
    hashFile: async (path: string) => {
      try {
        const data = await readFile(path)
        // 只对“写入之后”的 b.txt 说谎：基线检查仍通过，后置校验失败 ⇒ 触发回滚。
        if (path.endsWith('b.txt') && data.toString('utf8').startsWith('new-')) return 'f'.repeat(64)
        return sha256(data)
      } catch {
        return undefined
      }
    },
  })
  await writeFile(join(workspace, 'a.txt'), baseA, 'utf8')
  await rejectsCode('后置校验失败 → 抛错', () => flaky.apply(manifest()), 'NT_INTERNAL')
  eq('回滚后 a.txt 回到基线', await readFile(join(workspace, 'a.txt'), 'utf8'), baseA)
  eq('回滚后 gone.txt 仍在', await readFile(join(workspace, 'gone.txt'), 'utf8'), 'gone\n')

  section('6. journal 与工作区不得重叠')
  const overlapping = new NtApplyClient({
    workspaceRoot: workspace,
    blobRoot: BLOB_WIN,
    journalRoot: join(workspace, 'journal-inside'),
    resolveBlob: (blob: string) => join(blobs, blob.split('\\').pop() as string),
  })
  await rejectsCode('journal 在工作区内 → 拒绝', () => overlapping.apply(manifest()), 'NT_APPLY_DENIED')

  section('7. 非法 manifest')
  await rejectsCode(
    '空 changes → NT_APPLY_DENIED',
    () => client.apply(manifest({ changes: [] })),
    'NT_APPLY_DENIED',
  )
  await rejectsCode(
    'modified 缺 beforeSha256 → NT_APPLY_DENIED',
    () =>
      client.apply(
        manifest({
          changes: [{ rel: 'a.txt', kind: 'modified', afterSha256: sha256(newA), afterBlob: `${BLOB_WIN}\\a1` }],
        }),
      ),
    'NT_APPLY_DENIED',
  )

  await rm(root, { recursive: true, force: true })
})
