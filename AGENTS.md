# Project Instructions

## Project overview

`pi-delegate-workers` is a TypeScript pi package that delegates tasks to parallel `pi --mode rpc` worker processes. It provides the `/delegate` command and the `delegate_tasks` tool, supports `fast`, `balanced`, and `deep` worker profiles, and merges global, repository, and directory-scoped configuration.

## Repository layout

- `extensions/index.ts` — extension entry point, command/tool registration, worker orchestration, and parent UI integration.
- `extensions/rpc-worker.ts` — RPC worker process management and event handling.
- `extensions/config.ts` — scoped configuration types, validation, merging, and loading.
- `extensions/ui-dialog-queue.ts` — serialization of worker UI requests.
- `tests/*.test.ts` — Node test suite.
- `README.md` — user-facing installation, configuration, and usage documentation.

## Development

- The project uses strict TypeScript, ES modules, and NodeNext module resolution.
- Keep explicit `.ts` extensions in local imports.
- Run `npm test` after behavioral changes.
- Run `npm run typecheck` after TypeScript changes.
- Add or update tests for bug fixes and behavior changes.
- Keep `README.md` synchronized with changes to commands, tool schemas, configuration, or environment variables.
- Preserve backward compatibility for documented configuration and tool inputs unless a breaking change is intentional.

## Versioning

Use `npm version` to create new versions of this package. Do not update the version in `package.json` or `package-lock.json` manually.
