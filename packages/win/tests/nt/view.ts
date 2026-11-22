/**
 * `src/nt/view.ts` 单测：ProjFS 视图 diff、tombstone、目录删除、corruption。
 *
 * @module winstage-sandbox/tests/nt/view
 */

import {
  diffView,
  dirManifestEntry,
  fileManifestEntry,
  manifestFromEntries,
  MemoryViewProbe,
  type ViewProbe,
} from '../../src/nt/view.ts'
import { check, eq, runSuite, section } from './harness.ts'

const base = manifestFromEntries([
  dirManifestEntry('dir'),
  fileManifestEntry('a.txt', Buffer.from('hello')),
  fileManifestEntry('b.txt', Buffer.from('v1')),
  fileManifestEntry('dir\\c.txt', Buffer.from('c')),
  fileManifestEntry('gone.txt', Buffer.from('gone')),
  dirManifestEntry('olddir'),
  fileManifestEntry('olddir\\x.txt', Buffer.from('x')),
  fileManifestEntry('missing.txt', Buffer.from('missing')),
])

await runSuite('nt-view', async () => {
  section('1. 基本 diff')
  const probe = new MemoryViewProbe()
    .setDir('dir')
    .setPlaceholder('a.txt', Buffer.from('hello'))
    .setFile('b.txt', Buffer.from('v2'))
    .setPlaceholder('dir\\c.txt', Buffer.from('c'))
    .setFile('new.txt', Buffer.from('new'))
    .setTombstone('gone.txt')
    .setTombstone('olddir')
    .setDir('d2')
    .setFile('d2\\y.txt', Buffer.from('y'))

  const diff = await diffView({ base, probe })
  eq('modified 只有 b.txt', diff.modified.map((c) => c.rel), ['b.txt'])
  eq('created 含 new.txt/d2/y.txt', diff.created.map((c) => c.rel).sort(), ['d2\\y.txt', 'new.txt'])
  eq('deleted 含 gone.txt/olddir/x.txt', diff.deleted.map((c) => c.rel).sort(), ['gone.txt', 'olddir\\x.txt'])
  eq('unchanged 含 a.txt/dir/c.txt', diff.unchanged.sort(), ['a.txt', 'dir\\c.txt'])
  eq('corrupted 只含 missing.txt', diff.corrupted.sort(), ['missing.txt'])
  eq('dirsCreated 含 d2', diff.dirsCreated, ['d2'])
  eq('dirsDeleted 含 olddir', diff.dirsDeleted, ['olddir'])
  check('删除不得复活：gone.txt 不在 created', !diff.created.some((c) => c.rel === 'gone.txt'))
  check('删除不得复活：gone.txt 不在 unchanged', !diff.unchanged.includes('gone.txt'))
  check('目录删除的子文件不得误报 corruption', !diff.corrupted.includes('olddir\\x.txt'))

  section('2. 缺失副本是 corruption，不是删除')
  check('missing.txt 不在 deleted', !diff.deleted.some((c) => c.rel === 'missing.txt'))
  check('missing.txt 在 corrupted', diff.corrupted.includes('missing.txt'))

  section('3. 没有哈希来源时按 size/mtime 判定并标记 unverified')
  const noHashBase = manifestFromEntries([{ rel: 'x.txt', isDirectory: false, size: 5, mtimeMs: 1 }])
  const memory = new MemoryViewProbe().setFile('x.txt', Buffer.from('12345'), { mtimeMs: 2 })
  const noHashProbe: ViewProbe = {
    state: (rel) => memory.state(rel),
    list: (rel) => memory.list(rel),
    stat: async (rel) => {
      const stat = await memory.stat(rel)
      return stat === undefined ? undefined : { ...stat, hash: undefined }
    },
  }
  const noHashDiff = await diffView({ base: noHashBase, probe: noHashProbe, maxHashBytes: 0 })
  eq('无哈希来源判定 modified', noHashDiff.modified.map((c) => c.rel), ['x.txt'])
  check('标记 hashUnverified', noHashDiff.modified[0]?.hashUnverified === true)

  section('4. 空视图 + 空 base')
  const empty = await diffView({ base: manifestFromEntries([]), probe: new MemoryViewProbe() })
  eq('空 base 无变更', [empty.created.length, empty.modified.length, empty.deleted.length, empty.corrupted.length], [0, 0, 0, 0])
})
