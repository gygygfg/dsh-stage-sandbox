/**
 * The runtime isolation layer: hardened bwrap profile construction, network
 * mode mapping, the seccomp baseline, and cgroup v2 resource domains. These
 * are the mechanisms the PAL capability report advertises and the profile
 * builders compose.
 * @module dsh-sandbox-linux/runtime
 */

export {
  DEFAULT_MASK_PATHS,
  DEFAULT_PROC_MASK_PATHS,
  DEFAULT_READONLY_PATHS,
  DEFAULT_READONLY_ROOTS,
  DEFAULT_RUNTIME_OPTIONS,
  DEFAULT_TMPFS_ROOTS,
  type LimitOptions,
  type RuntimeOptions,
  type SeccompOptions,
} from './options.ts'
export { nodeProfileIo, bwrapProfileArgs, type OverlaySpec, type ProfileIo } from './profile.ts'
export { isWhiteout, mergeManifest, probeOverlaySupport, scanUpper, type OverlayCapture } from './overlay.ts'
export {
  ResidentSandbox,
  RESIDENT_SERVER_SCRIPT,
  type ResidentExecOptions,
  type ResidentExecResult,
  type ResidentStartInput,
} from './resident.ts'
export { networkArgs, networkEnforced, networkIsolated } from './network.ts'
export {
  buildSeccompFilter,
  ensureSeccompFilter,
  filterArch,
  seccompAvailable,
  seccompWrapper,
  type SeccompResolution,
} from './seccomp.ts'
export {
  CgroupDomain,
  cgroupAvailable,
  cgroupChain,
  hostCpuBudget,
  listDomains,
  nodeCgroupIo,
  oomAttribution,
  oomBaseline,
  readOomCount,
  resolveLimits,
  type CgroupIo,
  type CgroupSnapshot,
  type OomAttribution,
  type ResolvedLimits,
} from './cgroup.ts'
