# dsh-sandbox-plugin

A standalone [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that provides the
cross-platform process sandbox. It registers `ctx.sandbox` with a PAL-backed provider: each host
platform's runner chain (Linux `bwrap` then Landlock, macOS Seatbelt, Windows the ACL
restricted-token runner) is owned by a platform backend that reports what the host can enforce and
wraps argv for a file-effect policy.

This project is the plugin source; the provider and its platform backends were extracted from the
harness's `packages/sandbox/sandbox-local` so the plugin can live outside the monorepo and be loaded
by a dsh profile.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | Plugin entry: `CrossPlatformSandboxProvider` (default export), `ctx.sandbox` |
| `src/backends.ts` | Platform backends: runner chains, functional probes, capability profiles, dialects |
| `src/profiles.ts` | Per-platform profile builders: bwrap mounts, Landlock grants, Seatbelt SBPL |

`node_modules` is a symlink to the harness's `sandbox-local` dependency tree so the plugin's
`@deepseek-ai/*` imports resolve during development.

## Loading it in dsh

dsh loads this plugin through the machine-local patch layer, which disables the built-in
`@deepseek-ai/dsh-sandbox-local` row and inserts this plugin in its place. See
`~/.dsh/cordis.patch.yml`:

```yaml
- id: sandbox
  disabled: true
- insert:
    - id: sandbox-plugin
      name: 'dsh-sandbox-plugin'
```

The plugin resolves from the profile's `node_modules`, where `dsh-sandbox-plugin` is symlinked to
this directory. Inspect the composed tree without booting:

```sh
pnpm dsh --profile web --dump-config
```

## Requirements

- The plugin runs inside the dsh source launch (tsx ESM hook), which transpiles `src/index.ts`.
- The harness packages it imports (`@deepseek-ai/dsh-sandbox`, `@deepseek-ai/dsh-sandbox-pal`,
  `@deepseek-ai/dsh-sandbox-windows-acl`, `@deepseek-ai/node-addon-system`, `@deepseek-ai/cordis`,
  `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session`,
  `@deepseek-ai/dsh-util-values`) must be resolvable from the plugin's `node_modules`.
