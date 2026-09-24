# dsh-sandbox-linux

A standalone [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that implements the
Agent sandbox **dry-run / commit** architecture (v2.3, Linux-only). It replaces the built-in
`@deepseek-ai/dsh-sandbox-local` provider and adds a control plane that stages commands against a
private copy of the workspace, freezes a candidate, and publishes it under compare-and-swap.

v2.3 unifies every tool behind one logical workspace version: file edit, read, directory listing,
search, Git, and command execution resolve the same namespace, deletions are persistent markers
that cannot be resurrected from the host disk, and a missing storage object is reported as
corruption instead of an inferred deletion. It also adds actual-execution capability validation,
explicit network modes, three-phase secret handling, selective candidate approval, a startup
boundary, and a closed cleanup protocol.

The plugin is loaded by a dsh profile through the machine-local patch layer, which disables the
built-in `sandbox` row and inserts this plugin's rows (`~/.dsh/cordis.patch.yml`).

The plugin targets **Linux only** and uses Linux-specific isolation: bubblewrap namespaces, the
minimal read-only root and masking, seccomp, cgroup v2 resource domains, overlayfs, and optional
Landlock. There is no Windows or macOS backend.

## Status

| Area | State |
|---|---|
| Platform Abstraction Layer (PAL) | Implemented (`src/pal/`) |
| Linux runner backends (bubblewrap + Landlock) | Implemented (`src/backends.ts`, `src/profiles.ts`) |
| Runtime isolation: minimal read-only root + path masking (ch.8) | Implemented (`src/runtime/profile.ts`, `options.ts`) |
| Explicit network modes → `--unshare-net` (ch.9) | Implemented (`src/runtime/network.ts`) |
| seccomp baseline (ch.7.1) | Implemented (`src/runtime/seccomp.ts`) |
| cgroup v2 resource domains + OOM attribution (ch.7.1) | Implemented (`src/runtime/cgroup.ts`) |
| Resident command server (persistent shell, background processes) (ch.16) | Implemented (`src/runtime/resident.ts`) |
| Control-plane state machine (ch.7) | Implemented (`src/control/machine.ts`) |
| Execution/publication intent hashing (ch.6) | Implemented (`src/control/intent.ts`, `src/util/canonical.ts`) |
| Leases and fencing tokens (ch.7.2) | Implemented (`src/control/lease.ts`) |
| Durable operation store + optimistic concurrency | Implemented (`src/control/store.ts`, `records.ts`) |
| Candidate manifest / freeze / diff (ch.5.3, ch.9) | Implemented (`src/candidate/`) |
| Staged execution: overlay delta (fallback: copy) (ch.5.2) | Implemented (`src/stage/stager.ts`, `src/runtime/overlay.ts`) |
| Content-addressed candidate (full manifest + delta content) (ch.5.3) | Implemented (`src/candidate/freeze.ts`, `src/publish/directory-backend.ts`) |
| CAS publisher + receipts (ch.5.5) | Implemented (`src/publish/`) |
| `ctx.sandbox` provider (PAL-backed) | Implemented (`src/index.ts`) |
| `ctx.sandboxControl` dry-run/commit service | Implemented (`src/control/plugin.ts`) |
| Durable ControlStore + publication receipts (ch.13) | Implemented (`src/control/store.ts`, `src/publish/receipt-store.ts`) |
| Selective publication + per-file reject (ch.12) | Implemented (`src/stage/workspace-service.ts`) |
| Narrow task grants (auto-apply scope/budget/TTL) (ch.15) | Implemented (`src/control/grant.ts`) |
| Static script scanning (ch.10) | Implemented (`src/candidate/script-scan.ts`) |
| Git command guard (ch.11) | Implemented (`src/candidate/git-guard.ts`) |
| Privilege tiers T0/T1/T2 (ch.14) | Implemented (`src/candidate/privilege.ts`) |
| Evidence store with redaction (ch.12) | Implemented (`src/evidence/store.ts`) |
| Out-of-bounds trace (ch.12) | Implemented (`src/evidence/trace.ts`) |
| Concealment / staging-path restoration (ch.4) | Implemented (`src/util/conceal.ts`) |
| Host-operation proposals (`hostop`) (ch.14) | Implemented (`src/control/hostop.ts`) |
| Root-write `writer` / `NEEDS_ROOT` (ch.13) | Implemented (`src/publish/writer.ts`) |
| Policy replay (ch.13) | Implemented (`src/policy/replay.ts`) |
| Fault injection + benchmark (`diag`) (ch.16) | Implemented (`src/runtime/diag.ts`) |
| Kernel behavior observation (eBPF→strace) (ch.12) | Implemented (`src/runtime/observer.ts`) |
| systemd facade (`systemctl`/`journalctl`) (ch.16) | Implemented (`src/runtime/systemd.ts`) |
| Container runtime control (`podman`/`docker`) (ch.16) | Implemented (`src/runtime/container.ts`) |
| Git atomic apply ordering (ch.11) | Implemented (`src/publish/directory-backend.ts`) |
| `ctx.fs` staged (overlay) filesystem | Implemented (`src/fs/staged-fs.ts`) |
| `ctx.shell` staged executor | Implemented (`src/shell/staged-shell.ts`) |
| Sandboxed `ctx.subprocess` (search/jobs/terminal/process tools) | Implemented (`src/subprocess/sandboxed-subprocess.ts`) |
| Sandboxed `ctx.web` (network-gateway-authorized) | Implemented (`src/web/sandboxed-web.ts`) |
| Unified logical workspace namespace + deletion markers + corruption (ch.1.1, ch.3, ch.7) | Implemented (`src/workspace/`) |
| Copy-on-write staging (delta tree + base-read fallback) (ch.5.2) | Implemented (`src/workspace/logical.ts`) |
| Workspace branches, sessions, attempts + integrity-gated publish (ch.2, ch.13) | Implemented (`src/stage/workspace-service.ts`) |
| Structured tool returns + path restoration (ch.4) | Implemented (`src/workspace/result.ts`) |
| Actual-execution capability validation + environment fingerprint (ch.5) | Implemented (`src/pal/probe.ts`) |
| Explicit network modes + honest guarantees (ch.9) | Implemented (`src/broker/network.ts`) |
| Candidate before/after refs + selective approval (ch.12) | Implemented (`src/candidate/approval.ts`) |
| Startup boundary: environment allow-list + inherited resources (ch.8) | Implemented (`src/control/launch.ts`) |
| Secret display/execute/publish phases (ch.10) | Implemented (`src/secrets/phases.ts`) |
| Cleanup closure protocol (ch.13) | Implemented (`src/control/cleanup.ts`) |
| Workspace staging service + review/apply commands | Implemented (`src/stage/workspace-service.ts`, `src/review/commands.ts`) |
| Python / JavaScript policy executors + aggregate verdicts (ch.10) | Implemented (`src/policy/`) |
| registry / system_state impact categories (ch.9) | Implemented (`src/candidate/impact.ts`) |
| External operation broker + network gateway (ch.3.2, ch.8.4) | Implemented (`src/broker/`) |
| Caching, policy replay, Hyper-V/microVM backends (ch.13, ch.14) | Not yet — phase 4 |

## Architecture

The control plane is deliberately split into a pure orchestrator and injected platform pieces:

```
PlanRequest
   │  submit (idempotent by client_idempotency_key; request_hash mismatch refused)
   ▼
PARSED ──preflight (PAL capability gate)──▶ PREFLIGHTED ──▶ AWAITING_EXECUTION_AUTH
   │                                                              │ authorize
   ▼                                                              ▼
STAGING ◀── resources-ready ◀────────────────────────────────────┘
   │  Stager: copy workspace → confine argv via ctx.sandbox → run in the private copy
   ▼
CANDIDATE_READY ──▶ READY_TO_PUBLISH ──publish-intent──▶ PUBLISHING
   │                                                          │ CAS + fencing
   │                                                          ▼
   │                                                     VERIFYING ──▶ COMMITTED
   └── read-only-complete ──▶ COMPLETED_READ_ONLY
```

- **The real workspace is never written during staging.** The stager copies the workspace into a
  private candidate directory, runs the confined command with that copy as its workspace root, and
  diffs the result against the base manifest.
- **Publication is compare-and-swap.** The publisher checks a lease's fencing token at the write
  and refuses when the target's current version no longer equals the candidate's `expectedBase`.
- **Receipts are queryable and idempotent by operation id**, so a restart returns the same
  published result instead of publishing twice.
- **Backend identity is bound into the execution intent** (`backendId` + version + capability
  fingerprint), so the same logical command under a different backend or capability set is a
  different intent.

## Unified workspace (v2.3)

`LogicalWorkspace` (`src/workspace/logical.ts`) is the single namespace every tool reads. On hosts
that can mount an overlay it is **copy-on-write**: the staging tree holds only the delta, reads fall
back to the base snapshot, and mutations are recorded in a staged index (a staged object going
missing is corruption). A host without overlay support falls back to an eager full copy
(`copyOnWrite: false`). It keeps a base snapshot, the staging tree, and a persistent
deletion-marker set; it distinguishes `absent`, `baseline`, `staged-file`, `staged-directory`,
`deleted`, and `corrupted`. Consequences:

- **Deletion is authoritative.** A delete records a marker before removing the storage object, and
  reads never fall back to the real disk, so a deleted file cannot be resurrected.
- **Corruption blocks publication.** If the base record declares an object the staging storage no
  longer holds, `integrity()` reports `corrupted` and `/sandbox-apply` refuses — a lost copy is
  never interpreted as a user deletion.
- **One projection for commands.** `StagingStager` accepts a `projection`; the command starts from
  the current logical version (staged edits included) and its impact is extracted relative to that
  input version.
- **Directory merge and type changes.** Directory creation, recursive deletion, rename, and
  file↔directory type replacement all update the logical state; path mapping is idempotent.

`WorkspaceStagingService` owns one `LogicalWorkspace` per `(workspace, branch)` pair, binds sessions
to branches, and exposes `state`, `apply`, and `discard`. `apply` checks integrity first and returns
`corrupted` with the offending paths instead of publishing.

Structured tool results (`src/workspace/result.ts`) separate statuses that must not be conflated
(empty directory, no match, not found, permission denied, corrupted, timeout) and carry the exit
code, logical paths, observed scope, and evidence; `restorePaths` rewrites structured path fields
without string-replacing file bodies.

## System integration and observability

- **Static script scanning** (`src/candidate/script-scan.ts`): a command that delegates to a script
  or interpreter is scanned before classification — referenced shell scripts (by interpreter, `source`,
  shebang, or direct execution) are read and folded, embedded shell strings are extracted from
  Python/Node/Ruby/Perl/PHP, and the scan recurses with depth/file/byte limits. An indirect execution
  it cannot resolve (`curl | sh`, `python -m`, dynamic `-c "$VAR"`, an unreadable script) is `opaque`,
  which forces review. `assessDanger` folds the scanned text when a `readFile` (staged-aware) is
  supplied, so a hidden `pip install` in `deploy.sh` is classified.
- **Git command guard** (`src/candidate/git-guard.ts`): a raw mutating `git` invocation
  (`commit`/`push`/`reset`/…) is flagged (`SANDBOX_GIT_MUTATION_VIA_COMMAND`, L2) so the candidate is
  reviewed, and publication writes `.git` objects before pointers (`applyRank`) so a ref never
  dangles. Read-only git verbs pass.
- **Privilege tiers** (`src/candidate/privilege.ts`): commands are graded T0 (baseline), T1
  (package installs, containers, git network ops) or T2 (mount, modules, services, partition tables,
  registry). A `sudo`/`doas`/`su` wrapper never lowers the wrapped tier. A T2 command raises an L3
  `PRIVILEGE_TIER_T2` reason in danger classification.
- **Evidence store** (`src/evidence/store.ts`): append-only, paged evidence records (fs/process/
  network/policy/privilege/observe) with automatic redaction of secret keys and high-entropy values;
  a file-backed store survives a restart.
- **Concealment** (`src/util/conceal.ts`): staging paths in command output are rewritten to the real
  workspace paths (`restorePaths`), and residual sandbox fingerprints are removed
  (`redactFingerprint`), so the model never sees the private tree.
- **Host-operation proposals** (`src/control/hostop.ts`): a T2 command's host effect is frozen as a
  proposal (no host change), listed, rejected, or replayed on the host only after approval.
- **Root-write writer** (`src/publish/writer.ts`): a write is attempted unprivileged first; a
  permission refusal (`EACCES`/`EPERM`/`EROFS`) reports `needs-root` instead of failing, and only an
  approved write uses the privileged attempt. A non-permission failure is never retried.
- **Policy replay** (`src/policy/replay.ts`): a stored decision is re-evaluated from its facts and
  compared (decision + reason-code set); a mismatch means the decision was not a pure function of
  its inputs.
- **Diagnostics** (`src/runtime/diag.ts`): named fault seams (`probe`/`materialize`/`capture`/
  `freeze`/`publish`/`persist`/`cleanup`) for recovery tests, plus `timeSync` benchmark sampling.
- **Behavior observer** (`src/runtime/observer.ts`): detects the strongest available backend
  (`bpftrace` → `strace` → `none`) and, for `strace`, wraps the host runner with `strace -f` and
  parses successful opens outside the workspace into out-of-bounds paths. It honestly reports `none`
  when no kernel tool is present rather than claiming coverage.
- **systemd facade** (`src/runtime/systemd.ts`): a standalone `systemctl`/`journalctl` command is
  answered from in-session unit state instead of failing on the missing D-Bus. It supports
  start/stop/restart/status/is-active/is-enabled/is-system-running/is-failed/enable/disable/
  daemon-reload/list-units plus `journalctl` and `--version`, with realistic output and exit codes
  (unknown unit 5, inactive `is-active` 3, unknown verb 1). It is a facade, not systemd: it manages
  the state the AI asked for and does not run real services.
- **Container runtime control** (`src/runtime/container.ts`): an AI-invoked `podman`/`nerdctl`
  `run`/`create` is rewritten with `--net=host --pid=host --ipc=host --uts=host` so the container
  shares the SANDBOX's namespaces; `docker` is left unchanged (it reaches a controlled socket, and
  the orchestrator socket is masked by default).

## Runtime isolation (hardened bwrap profile)

The bwrap rung no longer binds the whole host root read-only. `src/runtime/` composes a hardened
profile (v2.3 §7–§9) and advertises exactly what the host enforces:

- **Minimal read-only root** (`runtime/profile.ts`): only an explicit whitelist (`/usr`, `/lib*`,
  `/bin`, `/sbin`, `/etc/*` necessities, `/var/lib`, …) is exposed read-only; unlisted host paths
  (`/home`, `/etc/shadow`, `/var/log`, `/opt`, `/srv`, `/mnt`, `/boot`) do not exist inside the
  sandbox. Set `readonlyRoots`/`readonlyPaths` to widen it.
- **Path masking**: sensitive directories become an empty tmpfs and files/sockets are overwritten
  with `/dev/null` (a `connect` then fails). Defaults cover orchestrator sockets (docker/containerd/
  podman), D-Bus/systemd, host credentials (`~/.ssh`, `~/.aws`, `~/.gnupg`, keyrings, git/gh), identity
  files (`/etc/shadow`, `/etc/machine-id`), logs, cron, and shell history; override with `maskPaths`.
- **Network modes** (`runtime/network.ts`): `OFFLINE` and `CONTROLLED_ONLINE` create a private
  network namespace (`--unshare-net`, all egress kernel-forced off); `OBSERVED_ONLINE` shares egress
  and honestly reports that direct paths are not covered. Default `OBSERVED_ONLINE`; set
  `networkMode` for a real boundary.
- **seccomp baseline** (`runtime/seccomp.ts`): a classic-BPF denylist (mount/ptrace/bpf/module/key/
  io_uring families, namespace-creating `clone` flags, `mknod` device nodes, non-allowlisted socket
  families) is applied via `bwrap --seccomp`, loaded by a bash wrapper that opens the filter on fd 9
  and `exec`s bwrap. `seccompEnabled` (default on), `seccompFilterPath`, `requireSeccomp` control it.
- **cgroup v2 resource domains** (`runtime/cgroup.ts`): each staged execution gets a private subtree
  with `memory.max`/`memory.swap.max`/`pids.max`/`cpu.max`, is killed with `cgroup.kill` on timeout
  or cancel, and OOM is attributed by diffing `memory.events` along the domain → ancestor → root
  chain. `cgroupEnabled`, `memoryRatio`, `memoryMaxBytes`-equivalent, `pidsMax`, `cpuMax`,
  `cgroupBase` control it. When the host cannot delegate, the domain is skipped and the capability
  report says `resourceLimits: absent`.

The PAL capability report reflects the configured runtime: `networkControl` is `enforced` only when a
mode isolates, `syscallPolicy` is `enforced` only when the filter loads, and `resourceLimits` is
`partial` because domains apply to staged executions.

## Overlay-based staged execution

A staged command no longer needs a full private copy of the workspace. When the host can mount a
bwrap overlay (`overlaySupported`, probed once and cached), the stager runs the command against the
**real workspace as the overlay lower** with a private **upper** as the writable layer
(`runtime/overlay.ts`, `runtime/profile.ts`). The sandbox path is the real workspace path, so the
command sees the logical view at the path it expects; only the delta lands in the upper.

- **Capture is delta-only**: after the command the upper is walked once. Created/modified files
  become entries; deletions appear as overlay whiteouts (character devices with `rdev === 0`) and are
  translated into deletion markers. The full candidate manifest is the base with the captured
  changes merged and deletions applied.
- **Content-addressed candidate**: `CandidateRef.entries` carries the complete desired manifest
  while `candidate.path` may hold only the changed content. The publisher applies the full manifest
  under CAS and copies content only for entries the target does not already satisfy — an unchanged
  entry needs no bytes because the CAS base check proved it still matches.
- **Honest fallback**: a host without bwrap overlays (an unavailable overlayfs, or a non-Linux platform)
  keeps the full-copy path. The decision is made once from the probe, so the chosen path and the
  fallback can never disagree.

The `sandboxWorkspace` file/shell/subprocess services share the same mechanism: the branch's staging
delta is registered with the provider as the overlay for its workspace root
(`registerOverlay`), so the inherited bash/subprocess executors keep calling `ctx.sandbox.confine`
while actually running at the real workspace path against the delta. After a command the workspace
reconciles the overlay's whiteouts into deletion markers. This is what makes `edit → read → search →
command` observe one logical version: a tool edit is visible to the next command, and a command's
writes/deletes are visible to the tool reads. A host without overlays redirects commands into the
full-copy staging tree instead.

## Resident command server

`src/runtime/resident.ts` runs one persistent sandbox instance holding a tiny bash command server, so
it behaves like a normal long-lived shell rather than a fresh process per command:

- **Persistent shell state**: `cd` and `export` survive between commands. Each command runs in a
  subshell seeded from a state file (cwd + `export -p`), so an `exit` cannot kill the server and a
  failure cannot leak into the next command.
- **Background survival**: `… &` starts a child of the persistent shell, so it keeps running across
  tool calls and can be inspected/killed by later commands (`kill -0 <pid>`).
- **Framed, base64 protocol**: requests are `REQ <id> <base64-script>` lines; responses are
  `RES <id> <base64-code> <base64-out> <base64-err>`, so control bytes and NUL never break framing.
  Requests are serialized; the client self-heals by restarting the server on EOF.

- **In-namespace rematerialize**: an inbox directory is bind-mounted into the instance
  (`OverlaySpec.binds`); before each command the branch's delta is mirrored into the inbox
  (`LogicalWorkspace.exportDelta`) and copied into the overlay *from inside the namespace*
  (`ResidentSandbox.materialize`). This is what makes a tool edit made after the overlay mounted
  visible to the next command despite overlayfs dentry caching, and it applies deletions too.
- **Shell routing**: when `ctx.sandboxWorkspace.residentEnabled` (`resident: true` on the workspace
  service, default off) and the host supports overlays, `StagedShellExecutor.run` sends foreground
  commands through `runResident` instead of spawning a one-shot process.

Verified on the host by `resident-server` in `scripts/runtime-conformance.ts` (cwd/env persistence,
background survival, post-mount edit and delete visibility, real workspace untouched).

## Capability, network, secrets, cleanup

- **Capability probe = actual execution validation** (`src/pal/probe.ts`): the report binds an
  environment fingerprint (filesystem type, mount topology, namespace/privilege context, runtime
  version) and exercises create, read, modify, delete, directory change, candidate capture, and
  cleanup. A cached success never replaces instance-start checks.
- **Network modes** (`src/broker/network.ts`): `OFFLINE` forcibly blocks all egress and overrides
  grants; `CONTROLLED_ONLINE` enforces grants and rejects prohibited local/metadata targets;
  `OBSERVED_ONLINE` provides a proxy and logs but honestly reports that direct paths are not
  covered. Revoking a lease closes its live connections. The kernel layer (`src/runtime/network.ts`)
  now backs the isolation modes with `--unshare-net`, so a direct socket cannot bypass the
  application-layer authorization.
- **Secrets** (`src/secrets/phases.ts`): display redacts to placeholders, execution provides only
  explicitly authorized secrets, and publication constructs verified final bytes. A lost, stale, or
  ambiguous mapping refuses publication rather than writing a placeholder to disk.
- **Startup boundary** (`src/control/launch.ts`): the environment is built from an allow-list (never
  pruned from the parent), and a launch refuses to start when descriptors/handles or the
  environment boundary cannot be converged.
- **Cleanup closure** (`src/control/cleanup.ts`): dereference → stop writers → release handles →
  verify ownership → delete → record. A non-converged writer or unverified owner aborts before
  deletion and records the residual object.

## Candidate approval

`src/candidate/approval.ts` builds a revision whose change units carry verifiable before/after
snapshot references (an approval diff never reads the live disk), counts pending files and host
operations separately, and supports selective apply: the selected subset becomes a
`publication_set`, the rest stay trackable as `partially-published`, `dependency-blocked`, or
`stale`. Discard records the discarded state before storage is reclaimed.

## Selective approval and durability

- **Selective publication**: `/sandbox-apply --file <path>` (or
  `sandboxWorkspace.apply(root, { files })`) publishes only the chosen paths. The candidate's desired
  manifest is the base with just those changes applied, so unselected changes stay pending;
  after publication the branch is re-based against the now-updated real root
  (`LogicalWorkspace.reBase`) and the remaining changes continue to diff correctly.
- **Per-file reject**: `/sandbox-reject --file <path>` (or `rejectFile`) reverts one path to the base
  in the delta (or restores it into a full-copy staging tree) and supersedes any held candidate.
- **Git atomic ordering**: `.git/objects/**` entries are written before ordinary entries and before
  `.git` pointers (`index`, `HEAD`, `refs/**`, `logs/**`, `packed-refs`), so a published index/ref
  never references an object that does not exist yet (`applyRank` in `directory-backend.ts`).
- **Durable stores**: `FileControlStore` persists every operation record and `FileReceiptStore`
  persists publication receipts (`stateDir` on the control service; `stateDir` on the workspace
  service), so a restart resumes an operation and a replayed `publish` returns the recorded receipt
  instead of applying twice.
- **Narrow task grants** (`src/control/grant.ts`): `issueGrant({ taskId, roots, operations,
  fileBudget, ttlMs })` authorizes a bounded task; a change covered by a live grant auto-applies
  (the confirmation requirement is removed and the file budget is consumed). A grant never overrides
  a policy `DENY`; `revokeGrant` cancels it.

## Dangerous operations are frozen and confirmed

`src/candidate/danger.ts` classifies a staged candidate independently of the rule packs, grading
every staged change and command into three levels with an approval-window marker color:

`WorkspaceStagingService.apply()` freezes the candidate and, when it is dangerous, holds the frozen
candidate — the real workspace is untouched. The hold is written to a **durable pending store**
(`src/stage/pending-store.ts`, `stateDir` config, default `~/.dsh/sandbox-state`) before the process
may exit, so reopening the session restores the approval instead of losing it: the frozen tree is
snapshotted content-addressed under `<stateDir>/candidates/<digest>` and the record under
`<stateDir>/pending/`. A restart between the two L3 confirmations remembers the first one.

The user reviews the held candidate with `/sandbox-review` (which prints the colored level, the
danger reasons, the consequences, and the confirmation progress) and confirms with
`/sandbox-apply --force` (or rejects with `/sandbox-discard`). A policy `DENY` still cannot be
overridden by the confirmation; the danger gate only adds a confirmation requirement on top of an
allow.

| Level | Marker | Examples | Confirmations |
|---|---|---|---|
| L1 | green | ordinary workspace write, official-channel package install | 1 |
| L2 | yellow | write outside the workspace, protected path in the workspace, destructive in-workspace edit, third-party install/download | 1 |
| L3 | red | system-file change, sensitive data written/sent outside the workspace, host operation, download-and-execute | 2 (+ consequences) |

## Every tool through the sandbox

The machine-local patch disables the built-in `fs-sandbox`, `bash-sandbox`, `subprocess`, and
`web` rows and mounts the plugin's replacements, so process- and network-based tools do not bypass
the sandbox:

- **`ctx.subprocess`** (`src/subprocess/sandboxed-subprocess.ts`) replaces the plain local subprocess
  provider. A spawn is workspace-scoped when its working directory or an absolute path argument falls
  under the policy workspace root; those spawns are redirected into the branch's staging tree and
  wrapped with `ctx.sandbox`. This covers filesystem search (ripgrep), background jobs, persistent
  shells, terminals, and extension tools. Unrelated spawns (language servers, MCP transports, harness
  internals) pass through unchanged, and an already-confined or already-staged argv is unwrapped and
  re-confined rather than nested.
- **`ctx.web`** (`src/web/sandboxed-web.ts`) authorizes every fetch through the plugin's
  `NetworkGateway`: local, link-local, and cloud-metadata targets are always rejected, `OFFLINE`
  blocks all egress, `CONTROLLED_ONLINE` requires a covering grant, and `OBSERVED_ONLINE` allows a
  proxied path while honestly reporting that direct egress is not forcibly covered.

The result is that `edit → read → search → command → Git` all observe the same logical workspace
version.

## Policy rules

Rule packs are signed: a pack's `signature` is the digest of its canonical rule list, and a
mismatch is refused at load. Each rule declares a `language` and optional `phases`. The engine
dispatches to the executor for that language and aggregates with a fixed precedence — `DENY` beats
`NEEDS_CONFIRMATION` beats `ALLOW`; a failed or timed-out rule is a `DENY`, never a skip.

- **JavaScript** rules run in a `node:vm` context with frozen prototypes, no
  `require`/`process`/`Buffer`, no `eval`/`Function`, and no `Date.now`/`Math.random`.
- **Python** rules run in a fresh `python3 -I` subprocess whose embedded harness AST-whitelists the
  source and installs a `sys.audit` hook that blocks filesystem, network, subprocess, ctypes, and
  import events. A deployment with RestrictedPython can swap in a stronger executor.

Per v2.3, none of these is a sandbox: `node:vm` is explicitly not a security mechanism,
RestrictedPython is not a sandbox, and a `sys.audit` hook (PEP 578) is not defined as one. The
language subset, audit hooks, and prototype freeze are additional protection only; rules that are
not trusted must run in an OS-constrained, low-privilege independent host.

The engine gates publication: `ctx.sandboxControl` refuses a denied candidate, and
`ctx.sandboxWorkspace.apply()` returns `denied` for a hard deny or `needs-authorization` for a
confirmation (which `/sandbox-apply --force` confirms; force never overrides a deny).

## External operations and network

External side effects never reuse the file-publish atomicity. `ctx.sandboxBroker` owns the adapter
table and the outcome log: an adapter declares its idempotency, query, transaction-boundary,
compensation, and irreversibility facts, and the broker invokes it only when it is available,
deduplicates by operation id, and records an `unknown` outcome as unknown (reconciled by query,
never reported as success or safe to retry).

The default-deny `NetworkGateway` grants endpoint sets with byte budgets and a lease; a
five-tuple match authorizes a connection and meters bytes, but the gateway's own guarantee is
L3/L4 authorization only — application identity is not provable there.

Host operations that would change system state (a T2 command) are never published by the file CAS:
they are frozen as host proposals (`src/control/hostop.ts`) and only replayed on the host after
approval. A write that needs root reports `NEEDS_ROOT` (`src/publish/writer.ts`) instead of failing.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: `LinuxSandboxProvider` registers `ctx.sandbox` |
| `src/backends.ts` | Per-platform runner chains, functional probes, capability profiles, dialects |
| `src/profiles.ts` | bwrap / Landlock profile builders |
| `src/runtime/` | Hardened bwrap runtime: minimal root + masking, network modes, seccomp baseline, cgroup v2 domains, overlay capture, resident command server |
| `src/pal/` | Platform Abstraction Layer: `RuntimeBackend`, `CapabilityReport`, registry, requirement checks |
| `src/control/` | State machine, intents, leases, store, records, ids, and the `ctx.sandboxControl` service |
| `src/candidate/` | Manifest scan/digest, freeze, diff, impact model, revisions/selective approval, danger classification |
| `src/workspace/` | Unified logical workspace, structured tool results, lifecycle types |
| `src/secrets/` | Secret display/execute/publish phases |
| `src/control/launch.ts` | Startup boundary: environment allow-list and inherited resources |
| `src/control/cleanup.ts` | Cleanup closure protocol |
| `src/pal/probe.ts` | Actual-execution capability validation and environment fingerprint |
| `src/stage/stager.ts` | Copy-based staged execution for command plans |
| `src/stage/workspace-service.ts` | `ctx.sandboxWorkspace`: per-workspace overlays, apply/discard, danger hold |
| `src/stage/pending-store.ts` | Durable pending-approval store (held candidates survive restart) |
| `src/fs/staged-fs.ts` | `ctx.fs`: overlay writes/reads, fenced by the sandbox policy |
| `src/shell/staged-shell.ts` | `ctx.shell`: confined commands redirected into the overlay |
| `src/subprocess/sandboxed-subprocess.ts` | `ctx.subprocess`: workspace-scoped spawns redirected and confined |
| `src/web/sandboxed-web.ts` | `ctx.web`: network-gateway-authorized fetch/search |
| `src/review/commands.ts` | `/sandbox-review`, `/sandbox-apply`, `/sandbox-discard` |
| `src/policy/` | Fact schema, verdict aggregation, JS (`node:vm`) and Python (subprocess) executors, signed packs, engine, publication gate |
| `src/broker/` | External-operation broker, default-deny network gateway, candidate-scope guard |
| `src/publish/` | CAS publisher + directory backend |
| `src/util/canonical.ts` | Versioned canonical encoding and digests |

## Development

`node_modules` is a set of symlinks into the harness workspace, so `@deepseek-ai/*` imports resolve
during development. `tsc`, `tsx`, and `vitest` are symlinked from the harness tree as well.

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.json   # typecheck
./node_modules/.bin/vitest run                       # unit tests
./node_modules/.bin/tsx scripts/smoke.ts             # boot the plugin on a bare Cordis context
./node_modules/.bin/tsx scripts/e2e.ts               # real dry-run -> commit through bwrap
./node_modules/.bin/tsx scripts/runtime-conformance.ts  # real bwrap: minimal root, network, seccomp, cgroup
./node_modules/.bin/tsx scripts/security-conformance.ts # real bwrap: escape / dangerous-command attacks
```

### Security / escape conformance

`scripts/security-conformance.ts` is adversarial: it runs dangerous commands
and common container-escape attempts **inside** the sandbox and asserts each one
is blocked (a check fails only when the boundary is breached). It covers host
secret reads (`/etc/shadow`, keys, `/var/log`), read-only-root writes, namespace
escapes (`unshare` user/mount/pid, `mount`, `setns`), seccomp-denied syscalls
(`ptrace`, `bpf`, `keyctl`, `io_uring`, module load), device-node creation and
raw sockets, masked orchestrator sockets (docker/containerd/dbus), kernel-info
`/proc` masking, `OFFLINE`/`CONTROLLED_ONLINE` egress, a bounded process storm,
the cgroup pids limit, and a `rm -rf`/`dd` command that must not touch the real
workspace. Every dangerous command is wrapped by `ctx.sandbox.confine` (and
resource checks are cgroup-bounded); nothing runs unconfined.

### Containerized full-suite run

`scripts/test-in-container.sh` runs the entire suite (typecheck, the 241 unit
tests, smoke, e2e, the runtime conformance, and the security/escape conformance)
inside a disposable Docker container, so bubblewrap/syscall/overlay/cgroup
behaviour is exercised against a clean Debian userland rather than the developer
host:

```sh
./scripts/test-in-container.sh                 # build image if needed, run, collect, remove
./scripts/test-in-container.sh --build --keep  # force rebuild and keep the container
```

The image ([`scripts/container/Dockerfile`](scripts/container/Dockerfile)) only
provides the OS tooling (`bubblewrap`, `python3`); the working tree and the
harness are bind-mounted, so the current code is what is tested. The driver
probes the host, starts the container with the privileges overlayfs/seccomp/
cgroup need, runs `scripts/container/run-tests.sh`, collects the per-stage logs
and `RESULT_<runId>.json` into `ebk/container-artifacts/`, then removes the
container. `ebk collect` is used for artifact collection when the ebk skills are
installed.

`scripts/runtime-conformance.ts` verifies the hardened profile on the host: the host root is no
longer readable, `OFFLINE` isolates the network namespace, the seccomp filter is loaded (and absent
when disabled), an overlay command writes only to the delta layer (real workspace untouched,
deletions captured as whiteouts), a `sandboxWorkspace` branch shares its delta with command
execution and publishes correctly under CAS, a selective publication applies one file and leaves the
rest pending, a resident server persists cwd/env, keeps background processes alive, and sees
post-mount tool edits/deletes via in-namespace rematerialize, and a cgroup domain's `memory.max`
triggers an attributed OOM.

Disposable-VM conformance tests for the Linux backends live under [`ebk/`](ebk/README.md): a Linux VM
script covers bubblewrap/Landlock. See `ebk/README.md` for how to run it. A
Docker-container runner that exercises the *whole* suite (`scripts/test-in-container.sh`) is
documented under Development above.

## Loading it in dsh

`~/.dsh/cordis.patch.yml` disables the built-in provider and mounts this plugin:

```yaml
- id: sandbox
  disabled: true
- id: fs-sandbox
  disabled: true
- id: bash-sandbox
  disabled: true
- id: subprocess
  disabled: true
- id: web
  disabled: true
- insert:
    - id: sandbox-plugin
      name: 'dsh-sandbox-linux'
    - id: sandbox-workspace
      name: 'dsh-sandbox-linux/src/stage/workspace-service.ts'
      config:
        workspaceRoot: !!js process.cwd()
    - id: sandbox-policy-engine
      name: 'dsh-sandbox-linux/src/policy/plugin.ts'
    - id: sandbox-broker
      name: 'dsh-sandbox-linux/src/broker/plugin.ts'
      config:
        networkMode: OBSERVED_ONLINE
    - id: sandbox-control
      name: 'dsh-sandbox-linux/src/control/plugin.ts'
      config:
        workspaceRoot: !!js process.cwd()
    - id: sandbox-fs
      name: 'dsh-sandbox-linux/src/fs/staged-fs.ts'
    - id: sandbox-shell
      name: 'dsh-sandbox-linux/src/shell/staged-shell.ts'
    - id: sandbox-subprocess
      name: 'dsh-sandbox-linux/src/subprocess/sandboxed-subprocess.ts'
    - id: sandbox-web
      name: 'dsh-sandbox-linux/src/web/sandboxed-web.ts'
      config:
        searchProvider: deepseek-official
        fetchProvider: http
    - id: sandbox-review
      name: 'dsh-sandbox-linux/src/review/commands.ts'
```

With this composition, model file writes and shell commands land in a private overlay; the
real workspace is untouched until `/sandbox-apply` publishes the frozen candidate under CAS.
`/sandbox-review` lists the pending changes and `/sandbox-discard` drops them.

Inspect the composed tree without booting:

```sh
pnpm dsh --profile web --dump-config
```

## Requirements

The harness packages this plugin imports must be resolvable from its `node_modules`. The plugin runs
inside the dsh source launch (tsx ESM hook), which transpiles `src/*.ts`.
