/**
 * `src/nt/paths.ts` 单测：规范化、边界、视图映射、输出还原。
 *
 * @module winstage-sandbox/tests/nt/paths
 */

import {
  concealViewText,
  hasAlternateDataStream,
  isDriveRoot,
  isPathInside,
  joinWin32,
  logicalToView,
  normalizeRelativeWin32Path,
  normalizeWin32Path,
  relativeToRoot,
  viewToLogical,
} from '../../src/nt/paths.ts'
import { check, eq, runSuite, section, throwsCode } from './harness.ts'

await runSuite('nt-paths', async () => {
  section('1. 绝对路径规范化')
  eq('盘符/分隔符/大小写/尾随分隔符', normalizeWin32Path('C:/Work/Proj/'), 'c:\\work\\proj')
  eq('根路径保留反斜杠', normalizeWin32Path('C:\\'), 'c:\\')
  eq('. 与 .. 归一', normalizeWin32Path('C:\\ws\\.\\a\\..\\b.txt'), 'c:\\ws\\b.txt')
  eq('长路径前缀被剥离', normalizeWin32Path('\\\\?\\C:\\ws\\a.txt'), 'c:\\ws\\a.txt')
  eq('重复分隔符归一', normalizeWin32Path('C:\\\\ws\\\\a.txt'), 'c:\\ws\\a.txt')

  section('2. 拒绝歧义/危险路径')
  throwsCode('盘符相对路径拒绝', () => normalizeWin32Path('C:foo'), 'NT_UNSUPPORTED_PATH')
  throwsCode('UNC 拒绝', () => normalizeWin32Path('\\\\server\\share\\a'), 'NT_UNSUPPORTED_PATH')
  throwsCode('设备命名空间拒绝', () => normalizeWin32Path('\\Device\\HarddiskVolume1\\ws'), 'NT_UNSUPPORTED_PATH')
  throwsCode('\\\\.\\ 设备拒绝', () => normalizeWin32Path('\\\\.\\C:\\ws'), 'NT_UNSUPPORTED_PATH')
  throwsCode('GLOBALROOT 拒绝', () => normalizeWin32Path('\\\\?\\GLOBALROOT\\Device\\C:\\ws'), 'NT_UNSUPPORTED_PATH')
  throwsCode('ADS 拒绝', () => normalizeWin32Path('C:\\ws\\a.txt:secret'), 'NT_UNSUPPORTED_PATH')
  throwsCode('通配符拒绝', () => normalizeWin32Path('C:\\ws\\*.txt'), 'NT_UNSUPPORTED_PATH')
  throwsCode('超长路径拒绝', () => normalizeWin32Path(`C:\\${'a'.repeat(32770)}`), 'NT_UNSUPPORTED_PATH')
  throwsCode('空路径拒绝', () => normalizeWin32Path('   '), 'NT_UNSUPPORTED_PATH')
  throwsCode('NUL 字节拒绝', () => normalizeWin32Path('C:\\ws\\a\0b'), 'NT_UNSUPPORTED_PATH')

  section('3. 相对路径')
  eq('相对路径归一', normalizeRelativeWin32Path('a/b/./c'), 'a\\b\\c')
  eq('空相对路径 = 根', normalizeRelativeWin32Path(''), '')
  throwsCode('相对路径 .. 逃逸拒绝', () => normalizeRelativeWin32Path('a/../b'), 'NT_PATH_ESCAPE')
  throwsCode('相对路径不能是绝对路径', () => normalizeRelativeWin32Path('C:\\a'), 'NT_UNSUPPORTED_PATH')
  throwsCode('相对路径不能含 ADS', () => normalizeRelativeWin32Path('a/b:c'), 'NT_UNSUPPORTED_PATH')

  section('4. 前缀边界')
  check('同路径 inside', isPathInside('C:\\ws', 'C:\\ws'))
  check('子路径 inside', isPathInside('C:\\ws\\a\\b', 'C:\\ws'))
  check('兄弟前缀不 inside（ws2 != ws）', !isPathInside('C:\\ws2\\a', 'C:\\ws'))
  check('根 inside 覆盖同盘', isPathInside('C:\\ws\\a', 'C:\\'))
  eq('relativeToRoot 子路径', relativeToRoot('C:\\ws\\a\\b', 'C:\\ws'), 'a\\b')
  eq('relativeToRoot 根', relativeToRoot('C:\\ws\\a', 'C:\\'), 'ws\\a')
  eq('relativeToRoot 同路径', relativeToRoot('C:\\ws', 'C:\\ws'), '')
  throwsCode('relativeToRoot 越界拒绝', () => relativeToRoot('C:\\other', 'C:\\ws'), 'NT_PATH_ESCAPE')

  section('5. 视图映射')
  eq(
    '逻辑路径 → 视图路径',
    logicalToView('C:\\work\\proj\\src\\a.ts', 'C:\\work\\proj', 'D:\\dshnt\\view'),
    'd:\\dshnt\\view\\src\\a.ts',
  )
  eq(
    '视图路径 → 逻辑路径',
    viewToLogical('D:\\dshnt\\view\\src\\a.ts', 'C:\\work\\proj', 'D:\\dshnt\\view'),
    'c:\\work\\proj\\src\\a.ts',
  )
  throwsCode(
    '逻辑路径越界拒绝',
    () => logicalToView('C:\\work\\other\\a.ts', 'C:\\work\\proj', 'D:\\dshnt\\view'),
    'NT_PATH_ESCAPE',
  )
  eq('joinWin32 正常', joinWin32('C:\\ws', 'a\\b'), 'c:\\ws\\a\\b')
  throwsCode('joinWin32 .. 逃逸拒绝', () => joinWin32('C:\\ws', '..\\x'), 'NT_PATH_ESCAPE')

  section('6. 输出还原与指纹')
  eq(
    '视图根大小写不敏感还原',
    concealViewText('open C:\\DshNt\\View\\a.txt via dshnt', [
      { from: 'C:\\DshNt\\View', to: 'C:\\work\\proj' },
    ]),
    'open C:\\work\\proj\\a.txt via sandbox',
  )
  eq(
    '正斜杠变体也还原',
    concealViewText('path=C:/DshNt/View/a.txt', [{ from: 'C:\\DshNt\\View', to: 'C:\\work\\proj' }]),
    'path=C:/work/proj/a.txt',
  )
  check('ADS 检测', hasAlternateDataStream('C:\\ws\\a.txt:secret'))
  check('普通文件不是 ADS', !hasAlternateDataStream('C:\\ws\\a.txt'))
  check('盘符根判定', isDriveRoot('C:\\'))
  check('非根判定', !isDriveRoot('C:\\ws'))
})
