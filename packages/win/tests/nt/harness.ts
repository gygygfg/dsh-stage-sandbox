/**
 * NT 控制面单测的极简断言器。
 *
 * 不引入第三方依赖：`node tests/nt/<suite>.ts` 直接跑（Node 24 原生 TS strip）。
 * 输出与仓库其它套件风格一致：`✓` / `✗` + 末尾 `RESULT: PASS|FAIL checks=N`。
 *
 * @module winstage-sandbox/tests/nt/harness
 */

let assertions = 0
let failures = 0

/** 打印分节标题。 */
export function section(title: string): void {
  process.stdout.write(`\n=== ${title} ===\n`)
}

/** 断言布尔条件。 */
export function check(name: string, condition: boolean, detail?: string): boolean {
  assertions += 1
  if (!condition) failures += 1
  process.stdout.write(`${condition ? '  ✓' : '  ✗'} ${name}${detail === undefined ? '' : `\n      证据: ${detail}`}\n`)
  return condition
}

/** 断言全等（按 JSON 比较对象/数组）。 */
export function eq<T>(name: string, actual: T, expected: T): boolean {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return check(name, a === b, a === b ? undefined : `actual=${a}\n      expected=${b}`)
}

/** 断言包含子串。 */
export function includes(name: string, actual: string, expected: string): boolean {
  return check(name, actual.includes(expected), actual.includes(expected) ? undefined : `actual=${JSON.stringify(actual)}`)
}

/** 断言抛出指定 code。 */
export function throwsCode(name: string, fn: () => unknown, code: string): boolean {
  try {
    fn()
    return check(name, false, `没有抛错（expected ${code}）`)
  } catch (error) {
    const actual = (error as { code?: unknown })?.code
    return check(name, actual === code, actual === code ? undefined : `actual code=${String(actual)} message=${String((error as Error)?.message)}`)
  }
}

/** 断言异步抛出指定 code。 */
export async function rejectsCode(name: string, fn: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await fn()
    return check(name, false, `没有抛错（expected ${code}）`)
  } catch (error) {
    const actual = (error as { code?: unknown })?.code
    return check(name, actual === code, actual === code ? undefined : `actual code=${String(actual)} message=${String((error as Error)?.message)}`)
  }
}

/** 运行一个套件；捕获未处理异常并计入失败。 */
export async function runSuite(label: string, fn: () => Promise<void> | void): Promise<void> {
  const started = Date.now()
  try {
    await fn()
  } catch (error) {
    failures += 1
    process.stdout.write(`\n  ✗ 套件异常: ${String((error as Error)?.stack ?? error)}\n`)
  }
  const elapsed = Date.now() - started
  process.stdout.write(`\n${'='.repeat(72)}\n`)
  process.stdout.write(`${label}: 断言 ${assertions} 项，失败 ${failures} 项，耗时 ${elapsed}ms\n`)
  process.stdout.write(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures}\n`)
  process.exitCode = failures === 0 ? 0 : 1
}
