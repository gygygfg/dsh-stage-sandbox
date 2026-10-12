/**
 * The impact model: what a staged execution was observed or estimated to
 * change, split into fs, process, and network. A missing or unknown value is
 * `null` or an explicit coverage status, never `0`, so an unobserved effect is
 * not reported as "no effect".
 * @module dsh-sandbox-linux/candidate/impact
 */

import type { OomAttribution } from '../runtime/cgroup.ts'

/** Whether an impact record was observed at execution time or estimated. */
export type ImpactSource = 'estimated' | 'observed'

/** How completely the record's category was covered by observation. */
export type ImpactCoverage = 'complete' | 'partial' | 'missing'

/** One filesystem effect. */
export interface FsImpact {
  /** The effect kind. */
  readonly kind: 'create' | 'write' | 'delete' | 'rename' | 'link' | 'metadata'
  /** The affected path. */
  readonly path: string
  /** The content digest before the effect, or `null` when absent/unknown. */
  readonly beforeHash: string | null
  /** The content digest after the effect, or `null` when absent/unknown. */
  readonly afterHash: string | null
  /** Whether the record was observed or estimated. */
  readonly source: ImpactSource
  /** The category coverage at the time. */
  readonly coverage: ImpactCoverage
  /** The evidence pointer this record came from. */
  readonly evidenceId: string
}

/** One process effect. */
export interface ProcessImpact {
  /** The observed peak process count. */
  readonly peakPids: number | null
  /** The exit code, or `null` when unknown. */
  readonly exitCode: number | null
  /** Whether the process was signalled. */
  readonly signalled: boolean
  /** The cgroup OOM attribution when the command died under a memory limit. */
  readonly oom?: OomAttribution
  /** The evidence pointer. */
  readonly evidenceId: string
}

/** One network effect. */
export interface NetworkImpact {
  /** The approved or attempted endpoint, or `null`. */
  readonly endpoint: string | null
  /** Transmitted bytes, or `null` when unknown. */
  readonly txBytes: number | null
  /** Received bytes, or `null` when unknown. */
  readonly rxBytes: number | null
  /** Whether a connection was denied by the gateway. */
  readonly denied: boolean
  /** The evidence pointer. */
  readonly evidenceId: string
}

/** The complete impact model for one candidate. */
export interface ImpactModel {
  /** Filesystem effects. */
  readonly fs: readonly FsImpact[]
  /** Process effects. */
  readonly process: readonly ProcessImpact[]
  /** Network effects. */
  readonly network: readonly NetworkImpact[]
}

/** The counted impact summary carried in the compact return. */
export interface ImpactStats {
  /** Filesystem counts. */
  readonly fs: { readonly creates: number; readonly writes: number; readonly deletes: number }
  /** Process counts. */
  readonly process: { readonly peakPids: number | null }
  /** Network counts. */
  readonly network: { readonly txBytes: number | null; readonly rxBytes: number | null }
}

/**
 * Count an impact model into the compact return's stats. Counts are exact for
 * records that exist; a category with no records reports `0`, while an unknown
 * measurement stays `null` rather than collapsing to zero.
 * @param model - the impact model.
 * @returns the counted stats.
 */
export function summarizeImpact(model: ImpactModel): ImpactStats {
  return {
    fs: {
      creates: model.fs.filter(entry => entry.kind === 'create').length,
      writes: model.fs.filter(entry => entry.kind === 'write' || entry.kind === 'rename' || entry.kind === 'metadata').length,
      deletes: model.fs.filter(entry => entry.kind === 'delete').length,
    },
    process: { peakPids: model.process[0]?.peakPids ?? null },
    network: { txBytes: model.network[0]?.txBytes ?? null, rxBytes: model.network[0]?.rxBytes ?? null },
  }
}
