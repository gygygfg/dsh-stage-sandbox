/**
 * dsh-sandbox-core — 跨平台共享层的**契约占位**。
 *
 * 本文件目前只声明目标接口，不含实现。抽取路线见同目录 `README.md`。
 * 选择"先占位"而不是"立即重写"：两个实现都成熟（win 41 次提交 / linux v2.3 + 51 用例），
 * 必须按后端边界**逐一**抽取，保证每步可二分、各自测试仍绿。
 *
 * @module dsh-sandbox-core
 */

/** 宿主平台标识（PAL 按此选后端；控制面永不按 OS 名分支）。 */
export type HostPlatform = 'win32' | 'linux'

/** 后端能力档位（对齐 packages/linux/src/pal/types.ts 的语义）。 */
export type CapabilityStatus = 'absent' | 'partial' | 'enforced'

/** 一次能力报告：某后端在本宿主上的真实能力。 */
export interface CapabilityReport {
  readonly platform: HostPlatform
  readonly backend: string
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>
}

/** 运行时后端契约：平台机制的收敛点。 */
export interface RuntimeBackend {
  readonly id: string
  readonly platform: HostPlatform
  /** 探测本宿主上该后端的真实能力（不是版本检查）。 */
  probe(): Promise<CapabilityReport>
  /** 是否满足给定能力需求；不满足即拒绝，绝不静默降级。 */
  meets(requirements: readonly string[]): boolean
}

/** 控制面状态机的可观察阶段（对齐 packages/linux/src/control 与 win 的候选/审批语义）。 */
export type ControlPhase = 'idle' | 'staged' | 'frozen' | 'published' | 'discarded'

/** 候选冻结的标识（内容寻址）。 */
export interface CandidateId {
  readonly session: string
  readonly hash: string
}

/**
 * 控制面契约：两平台共享的"暂存 → 冻结 → 选择提交"语义边界。
 * 实现分别位于 packages/win 与 packages/linux；抽取完成前此接口仅作文档与类型对齐。
 */
export interface ControlPlane {
  readonly phase: ControlPhase
  freeze(): Promise<CandidateId>
  publish(candidate: CandidateId, paths?: readonly string[]): Promise<void>
  discard(candidate: CandidateId): Promise<void>
}
