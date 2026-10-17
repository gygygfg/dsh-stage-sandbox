# VM conformance tests (ebk)

Disposable-VM tests for the Linux sandbox backends a developer host cannot fully cover, driven by
[ephemeral-build-kit](https://github.com/anomalyco/ephemeral-build-kit) (Docker + KVM).

## Linux (`ubuntu`)

`linux-package/run-tests.sh` checks bubblewrap's read-only root, private PID namespace, and writable
workspace bind, plus the Landlock launcher. `qemus/qemu` has no OEM auto-run, so run it inside the
guest (SSH once the VM is up) and copy the result to the shared 9p mount:

```sh
node /path/to/ebk-compose.mjs --os-id ubuntu --run-id sbx --test-dir ebk/linux-shared \
  --package-dir ebk/linux-package --ssh-port 2222 --web-port 8077 --out ebk/linux-compose.yml
docker compose -f ebk/linux-compose.yml up -d
# wait for the guest, then run /mnt/pkg/run-tests.sh over SSH and read the result from the shared mount
docker compose -f ebk/linux-compose.yml down -v
```

The Linux backend is also exercised end-to-end on the host (`scripts/e2e.ts` runs a real
bubblewrap-confined command through the full dry-run/commit flow) and by
`scripts/runtime-conformance.ts` (minimal root, network isolation, seccomp, overlay delta, selective
publish, resident server, cgroup OOM).

## Full suite in a container (`scripts/test-in-container.sh`)

The `qemus/qemu` Linux guests are interactive ISO installers with no unattended
auto-run, so the ebk VM path cannot be driven headlessly for the whole suite
without manual install and SSH. For a non-interactive, reproducible run of
**everything** (typecheck + 241 unit tests + smoke + e2e + runtime conformance +
security/escape conformance) the repo ships a Docker-container runner:

```sh
scripts/test-in-container.sh                 # build if needed, run, collect, remove
scripts/test-in-container.sh --build --keep  # force rebuild, keep the container
```

It uses an isolated Debian image with `bubblewrap`/`python3`
(`scripts/container/Dockerfile`), bind-mounts the working tree and harness, runs
`scripts/container/run-tests.sh`, and collects per-stage logs plus
`RESULT_<runId>.json` into `ebk/container-artifacts/`. The container needs
`--privileged --cgroupns=host` and a tmpfs `TMPDIR` (overlayfs cannot be nested
on the container's overlay root); the driver sets these. Host readiness and
artifact collection use the ebk skills' `probe`/`collect` helpers when present.

## Run results

Results are run artifacts and are **not** committed: the container driver writes
`RESULT_<runId>.json` plus per-stage logs into `ebk/container-artifacts/`
(gitignored). Re-run `scripts/test-in-container.sh` to regenerate them.
