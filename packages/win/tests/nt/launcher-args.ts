/**
 * `src/nt/launcher-args.ts` 单测：启动契约、环境白名单、路径/Job 校验。
 *
 * @module winstage-sandbox/tests/nt/launcher-args
 */

import { buildLauncherArgv, sortedEnv } from '../../src/nt/launcher-args.ts'
import { defaultJobLimits } from '../../src/nt/types.ts'
import { check, eq, runSuite, section, throwsCode } from './harness.ts'

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    launcherPath: 'C:\\dshnt\\bin\\dshnt-launch.exe',
    domain: 'sess-1',
    viewRoot: 'D:\\dshnt\\view\\sess-1',
    workspaceRoot: 'C:\\work\\proj',
    policyGeneration: 3,
    network: 'offline' as const,
    job: defaultJobLimits(),
    tokenMode: 'appcontainer' as const,
    appContainerSid: 'S-1-15-2-1-2-3-4',
    env: { PATH: 'C:\\Windows\\System32', LANG: 'C.UTF-8' },
    argv: ['C:\\Windows\\System32\\cmd.exe', '/c', 'echo hi'],
    ...overrides,
  }
}

await runSuite('nt-launcher-args', async () => {
  section('1. 基本 argv')
  const argv = buildLauncherArgv(baseInput())
  eq('launcher 在首位', argv[0], 'c:\\dshnt\\bin\\dshnt-launch.exe')
  check('含 --domain', argv.includes('--domain') && argv[argv.indexOf('--domain') + 1] === 'sess-1')
  check('含规范化 view', argv.includes('d:\\dshnt\\view\\sess-1'))
  check('含规范化 workspace', argv.includes('c:\\work\\proj'))
  check('含 policy generation', argv[argv.indexOf('--policy-generation') + 1] === '3')
  check('含 network', argv[argv.indexOf('--network') + 1] === 'offline')
  check('含 token', argv[argv.indexOf('--token') + 1] === 'appcontainer')
  check('含 SID', argv[argv.indexOf('--sid') + 1] === 'S-1-15-2-1-2-3-4')
  check('cwd 默认 viewRoot', argv[argv.indexOf('--cwd') + 1] === 'd:\\dshnt\\view\\sess-1')
  check('含 job 参数', argv.includes('--job-memory-mb') && argv.includes('--job-kill-on-close'))
  const separator = argv.indexOf('--')
  check('-- 分隔符存在', separator > 0)
  eq('目标 argv 原样在 -- 之后', argv.slice(separator + 1), ['C:\\Windows\\System32\\cmd.exe', '/c', 'echo hi'])
  check('环境按 key 排序（LANG 在 PATH 前）', argv.indexOf('LANG=C.UTF-8') < argv.indexOf('PATH=C:\\Windows\\System32'))

  section('2. 环境白名单')
  eq('sortedEnv 排序', sortedEnv({ b: '2', a: '1' }), [['a', '1'], ['b', '2']])
  throwsCode('凭据键默认拒绝', () => sortedEnv({ GITHUB_TOKEN: 'x' }), 'NT_ENV_REJECTED')
  throwsCode('非法键拒绝', () => sortedEnv({ 'bad-key': 'x' }), 'NT_ENV_REJECTED')
  throwsCode('NUL 值拒绝', () => sortedEnv({ A: 'x\0y' }), 'NT_ENV_REJECTED')
  eq('显式允许凭据键', sortedEnv({ GITHUB_TOKEN: 'x' }, true), [['GITHUB_TOKEN', 'x']])

  section('3. 路径/Job/令牌校验')
  throwsCode(
    'view 与 workspace 重叠',
    () => buildLauncherArgv(baseInput({ viewRoot: 'C:\\work\\proj\\view' })),
    'NT_VIEW_ROOT_INVALID',
  )
  throwsCode(
    'cwd 逃出 view',
    () => buildLauncherArgv(baseInput({ cwd: 'C:\\work\\proj' })),
    'NT_PATH_ESCAPE',
  )
  throwsCode(
    'launcher 必须是绝对路径',
    () => buildLauncherArgv(baseInput({ launcherPath: 'dshnt-launch.exe' })),
    'NT_UNSUPPORTED_PATH',
  )
  throwsCode(
    'policy generation 必须为正',
    () => buildLauncherArgv(baseInput({ policyGeneration: 0 })),
    'NT_POLICY_GENERATION_MISMATCH',
  )
  throwsCode(
    'allowlist + restricted 不支持',
    () => buildLauncherArgv(baseInput({ network: 'allowlist', tokenMode: 'restricted' })),
    'NT_NETWORK_UNSUPPORTED',
  )
  throwsCode(
    'appcontainer 缺 SID',
    () => buildLauncherArgv(baseInput({ appContainerSid: undefined })),
    'NT_CAPABILITY_MISSING',
  )
  throwsCode(
    '空 argv',
    () => buildLauncherArgv(baseInput({ argv: [] })),
    'NT_CAPABILITY_MISSING',
  )
  throwsCode(
    '非法 Job 内存',
    () => buildLauncherArgv(baseInput({ job: { ...defaultJobLimits(), memoryMb: 0 } })),
    'NT_CAPABILITY_MISSING',
  )

  section('4. allowlist 端点（v1：IP 字面量，无 DNS）')
  const allowV4 = buildLauncherArgv(
    baseInput({ network: 'allowlist', allow: [{ host: '172.30.112.1', port: 445 }] }),
  )
  eq('v4 端点写成 host:port', allowV4[allowV4.indexOf('--allow') + 1], '172.30.112.1:445')
  const allowV6 = buildLauncherArgv(
    baseInput({ network: 'allowlist', allow: [{ host: '2001:db8::1', port: 443 }] }),
  )
  eq('v6 端点加方括号', allowV6[allowV6.indexOf('--allow') + 1], '[2001:db8::1]:443')
  const multi = buildLauncherArgv(
    baseInput({
      network: 'allowlist',
      allow: [
        { host: '10.0.0.2', port: 53 },
        { host: '10.0.0.1', port: 443 },
      ],
    }),
  )
  eq(
    '多个端点按输入顺序',
    multi.filter((item, index) => index > 0 && multi[index - 1] === '--allow'),
    ['10.0.0.2:53', '10.0.0.1:443'],
  )
  throwsCode(
    'allowlist 空列表拒绝（不得静默当 offline）',
    () => buildLauncherArgv(baseInput({ network: 'allowlist', allow: [] })),
    'NT_NETWORK_UNSUPPORTED',
  )
  throwsCode(
    '域名拒绝（闸门没有 DNS）',
    () => buildLauncherArgv(baseInput({ network: 'allowlist', allow: [{ host: 'example.com', port: 443 }] })),
    'NT_NETWORK_UNSUPPORTED',
  )
  throwsCode(
    '非法端口拒绝',
    () => buildLauncherArgv(baseInput({ network: 'allowlist', allow: [{ host: '10.0.0.1', port: 0 }] })),
    'NT_NETWORK_UNSUPPORTED',
  )
  throwsCode(
    '非 allowlist 模式带端点拒绝',
    () => buildLauncherArgv(baseInput({ network: 'offline', allow: [{ host: '10.0.0.1', port: 443 }] })),
    'NT_NETWORK_UNSUPPORTED',
  )
  check('offline 不产生 --allow', !buildLauncherArgv(baseInput()).includes('--allow'))
})
