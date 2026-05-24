# pi-delegate-workers

A local pi package that adds a `/delegate` command and a `delegate_tasks` tool.

It launches separate `pi --mode rpc` worker processes, runs read-only tasks in parallel, asks each worker to synthesize its own findings, and brings those compact summaries back to your main session.

## What it does

- `/delegate task A | task B | task C`
- `delegate_tasks(tasks)` custom tool for model-driven delegation
- worker status widget + footer status
- per-worker synthesis pass before returning results to the parent session
- read-only workers by default (`read,grep,find,ls`)

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

When the workers finish, the extension returns compact per-worker summaries to the main session so parent-context usage stays smaller.

## Environment knobs

- `PI_DELEGATE_PI_BIN` - path/binary used to launch worker pi processes (default: `pi`)
- `PI_DELEGATE_TOOLS` - comma-separated worker tool allowlist (default: `read,grep,find,ls`)
- `PI_DELEGATE_MAX_WORKERS` - max tasks per batch (default: `5`)

## Notes

- This MVP is intentionally read-only.
- Workers run in the same cwd as the main session.
- The extension expects `pi` to be available on your PATH unless `PI_DELEGATE_PI_BIN` is set.
