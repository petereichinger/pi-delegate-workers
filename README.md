# pi-delegate-workers

A local pi package that adds a `/delegate` command and a `delegate_tasks` tool.

It launches separate `pi --mode rpc` worker processes, runs configured tasks in parallel, asks each worker to synthesize its own findings, and returns compact summaries to the main session.

## What it does

- `/delegate [fast] task A | [deep] task B`
- `delegate_tasks` with parent-agent-selected `fast`, `balanced`, or `deep` profiles
- per-profile model and thinking level configuration
- global, Git-repository, and current-directory JSON configuration
- live per-worker activity widget
- progress text and current tool activity streamed from each worker over RPC
- per-worker synthesis before returning results to the parent
- normal pi worker tool set by default (`read,write,edit,bash`)

The parent agent selects profiles using this rubric:

- `fast` — lookups, searches, summaries, and isolated checks
- `balanced` — multi-file tracing, routine changes, and test diagnosis
- `deep` — architecture, security, migrations, and ambiguous root causes

## Install

From a checkout:

```bash
pi -e /home/pete/Projects/code/pi-delegate-workers
```

As a local package:

```bash
pi install /home/pete/Projects/code/pi-delegate-workers
```

## Configuration

All files are optional. They are deeply merged in this order:

1. Global: `<agent-dir>/extensions/delegate-workers.json`
2. Repository: `<git-common-dir>/pi-delegate-workers.json`
3. Directory: `<cwd>/<CONFIG_DIR_NAME>/delegate-workers.json`

`<agent-dir>` honors `PI_CODING_AGENT_DIR`. The repository config is shared by linked worktrees. The directory scope is the exact pi working directory; intermediate directories are not searched. Repository and directory configs are loaded only for trusted projects.

```json
{
  "version": 1,
  "defaultProfile": "balanced",
  "profiles": {
    "fast": {
      "model": "provider/small-model",
      "thinkingLevel": "low"
    },
    "balanced": {
      "model": "provider/standard-model",
      "thinkingLevel": "medium"
    },
    "deep": {
      "model": "provider/strong-model",
      "thinkingLevel": "high"
    }
  }
}
```

Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Models must use an exact `provider/model` identifier. The extension resolves configured models through pi's model registry and verifies model-specific thinking-level support before spawning workers.

A narrower scope can override one property while inheriting the rest:

```json
{
  "profiles": {
    "balanced": {
      "thinkingLevel": "high"
    }
  }
}
```

Set a property to `null` to clear an inherited value and use pi's startup default:

```json
{
  "profiles": {
    "fast": {
      "model": null,
      "thinkingLevel": null
    }
  }
}
```

## Tool usage

The current tool schema uses structured tasks:

```json
{
  "tasks": [
    { "task": "Locate the auth middleware", "profile": "fast" },
    { "task": "Trace token refresh failures", "profile": "balanced" },
    { "task": "Review migration safety", "profile": "deep" }
  ],
  "sharedContext": "Optional context shared by every worker"
}
```

The profile is optional and falls back to `defaultProfile`. Legacy calls containing string tasks are normalized automatically.

Each worker starts with the resolved profile on its command line:

```bash
pi --mode rpc --no-session --model provider/model --thinking medium --tools ...
```

The same model and thinking level are used for investigation and the worker's synthesis pass.

## Environment settings

- `PI_DELEGATE_PI_BIN` — worker pi binary/path (default: `pi`)
- `PI_DELEGATE_TOOLS` — comma-separated worker tool allowlist (default: `read,write,edit,bash`)
- `PI_DELEGATE_MAX_WORKERS` — maximum tasks per batch (default: `5`)
- `PI_DELEGATE_EXTRA_ARGS` — additional worker CLI arguments
- `PI_DELEGATE_TOOL_GUARD` — tool-guard auto-loading mode; set `0`/`false` to disable or `1`/`required` to force
- `PI_DELEGATE_TOOL_GUARD_EXTENSION` — explicit tool-guard extension source/path
- `PI_DELEGATE_TOOL_GUARD_ISOLATE` — set to `1`/`true` to add `--no-extensions` when explicitly loading tool-guard (default: off); enabling isolation also disables other discovered worker extensions, including custom model providers

When a resolved profile controls the model or thinking level, conflicting `--provider`, `--model`, and `--thinking` entries are removed from `PI_DELEGATE_EXTRA_ARGS`. Other extra arguments remain.

## Notes

- Workers run in the same CWD as the main session.
- Worker RPC events update a live parent widget with the latest progress message or tool activity for each agent.
- Worker extension UI requests are proxied to the parent UI and parallel dialogs are queued.
- Tool-guard is reused from a parent extension argument or an adjacent `pi-tool-guard` checkout when available. Worker extension discovery stays enabled by default so extension-provided models remain available; set `PI_DELEGATE_TOOL_GUARD_ISOLATE=1` only when duplicate guard discovery is a problem.
- Read-only workers can be configured with `PI_DELEGATE_TOOLS=read,grep,find,ls`.
