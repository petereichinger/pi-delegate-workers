# pi-delegate-workers

A local pi package that adds a `/delegate` command and a `delegate_tasks` tool.

It launches separate `pi --mode rpc` worker processes, runs configured tasks in parallel, asks each worker to synthesize its own findings, and brings those compact summaries back to your main session.

## What it does

- `/delegate task A | task B | task C`
- `delegate_tasks(tasks)` custom tool for model-driven delegation
- worker status widget + footer status
- per-worker synthesis pass before returning results to the parent session
- `/delegate` always sends the compact worker summaries back into the main chat for a final synthesis
- normal pi worker tool set by default (`read,write,edit,bash`)

## Load it once

```bash
pi -e /home/pete/Projects/code/pi-delegate-workers
```

## Install it as a local package

```bash
pi install /home/pete/Projects/code/pi-delegate-workers
```

## Usage

```text
/delegate inspect auth flow | find flaky test causes | review migration safety
```

When the workers finish, the extension returns compact per-worker summaries to the main session and asks the parent agent to synthesize them, so parent-context usage stays smaller.

## Environment knobs

- `PI_DELEGATE_PI_BIN` - path/binary used to launch worker pi processes (default: `pi`)
- `PI_DELEGATE_TOOLS` - comma-separated worker tool allowlist (default: `read,write,edit,bash`)
- `PI_DELEGATE_MAX_WORKERS` - max tasks per batch (default: `5`)
- `PI_DELEGATE_EXTRA_ARGS` - extra args appended to spawned worker `pi --mode rpc` commands, useful for explicitly loading extensions such as `-e /path/to/pi-tool-guard`
- `PI_DELEGATE_TOOL_GUARD` - auto-load `pi-tool-guard` into worker processes when the parent was launched with a `pi-tool-guard` extension arg or when a sibling checkout is found (default: auto). Set to `0`/`false` to disable, or `1`/`required` to force `-e pi-tool-guard` if no local path is found.
- `PI_DELEGATE_TOOL_GUARD_EXTENSION` - explicit extension source/path to pass as `--extension` for worker `pi-tool-guard` loading.
- `PI_DELEGATE_TOOL_GUARD_ISOLATE` - when loading `pi-tool-guard` explicitly, add `--no-extensions` so an older globally installed guard cannot also load and double/block prompts (default: on). Set to `0`/`false` to keep normal extension discovery.

## Notes

- Workers use pi's normal tool set by default, including `bash` for small independent scripts and `write`/`edit` for file changes. To make workers read-only, set `PI_DELEGATE_TOOLS=read,grep,find,ls`.
- Since worker `bash` is enabled by default, any guard/approval extension you rely on must be loaded inside the worker process too. This extension reuses a parent `-e ...pi-tool-guard...` arg or auto-adds a sibling `../pi-tool-guard` checkout when present. When it does, it also uses `--no-extensions` by default to avoid loading a second/older globally installed guard. Otherwise install it globally/as a pi package, set `PI_DELEGATE_TOOL_GUARD_EXTENSION=/path/to/pi-tool-guard`, or use `PI_DELEGATE_EXTRA_ARGS='-e /path/to/pi-tool-guard'`.
- Worker RPC extension UI requests are proxied back to the parent UI, so guard prompts from worker processes can be answered in the main session. Dialog requests from parallel workers are queued and shown one at a time.
- Workers run in the same cwd as the main session.
- The extension expects `pi` to be available on your PATH unless `PI_DELEGATE_PI_BIN` is set.
