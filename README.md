# pi-delegate-workers

A local pi package that adds a `delegate_tasks` tool for model-directed delegation.

It launches separate `pi --mode rpc` worker processes, runs configured tasks in parallel, asks each worker to synthesize its own findings, and returns compact summaries to the main session.

## What it does

- `delegate_tasks` with parent-agent-selected `fast`, `balanced`, or `deep` profiles
- `/cancel-worker 13` to cancel the running worker shown as `w13` in the live widget (the `w13` form is also accepted)
- optional per-task deadlines covering investigation and synthesis; tasks have no timeout by default
- per-profile model and thinking level configuration
- automatic model-set selection from the active parent model
- per-task model-set overrides for aligned or cross-model delegation
- global, Git-repository, and current-directory JSON configuration
- live per-worker widget with a stable goal line and changing current activity
- progress text and current tool activity streamed from each worker over RPC
- per-worker synthesis before returning results to the parent
- worker token and cost usage added to the parent session totals
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
      "thinkingLevel": "low"
    },
    "balanced": {
      "thinkingLevel": "medium"
    },
    "deep": {
      "thinkingLevel": "high"
    }
  },
  "defaultModelSet": "diverse",
  "modelSets": {
    "claude": {
      "profiles": {
        "fast": { "model": "anthropic/claude-haiku" },
        "balanced": { "model": "anthropic/claude-sonnet" },
        "deep": { "model": "anthropic/claude-opus" }
      }
    },
    "diverse": {
      "profiles": {
        "fast": { "model": "provider/astra" },
        "balanced": { "model": "provider/sol" },
        "deep": { "model": "provider/sol" }
      }
    }
  },
  "parentModelRoutes": [
    {
      "models": ["anthropic/claude-*"],
      "modelSet": "claude"
    }
  ]
}
```

Valid thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Models must use an exact `provider/model` identifier. Parent model routes use minimatch-compatible `provider/model` patterns and the first matching route wins. The extension resolves configured worker models through pi's model registry and verifies model-specific thinking-level support before spawning workers.

Model sets overlay the top-level profiles. In the example, each set supplies worker models while the top-level profiles supply shared thinking levels. Existing configurations without model sets keep their current behavior.

For each task, model-set selection uses this precedence:

1. The task's explicit `modelSet`
2. The first `parentModelRoutes` match for the active parent model
3. `defaultModelSet`
4. The top-level profile without a model set

Switching the active parent model updates automatic routing immediately. A transient message shows the initial configured model set and any later effective set change; configurations that use only baseline profiles do not add a startup message or persistent status item.

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

Set a profile property to `null` to clear an inherited value and use pi's startup default:

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

Named model sets are deeply merged across scopes. Set a model-set entry to `null` to remove it, or set `defaultModelSet` to `null` to clear the inherited default. `parentModelRoutes` is ordered, so a narrower scope replaces the complete inherited route list; set it to `null` to clear all inherited routes.

## Tool usage

The current tool schema uses structured tasks:

```json
{
  "tasks": [
    { "task": "Locate the auth middleware", "profile": "fast" },
    { "task": "Trace token refresh failures", "profile": "balanced" },
    { "task": "Review migration safety", "profile": "deep" },
    {
      "task": "Run an independent cross-model review",
      "profile": "deep",
      "modelSet": "diverse",
      "timeoutMs": 1800000
    }
  ],
  "sharedContext": "Optional context shared by every worker"
}
```

The profile is optional and falls back to `defaultProfile`. Leave `modelSet` out to infer it from the active parent model. Empty or whitespace-only values also use automatic routing. A non-empty task model set overrides automatic routing only for that task; unknown names are rejected. Legacy calls containing string tasks are normalized automatically.

`timeoutMs` is optional per task and must be an integer from 1 to 2,147,483,647 milliseconds. It covers both the investigation and synthesis passes, starting when the worker is launched. Without it, the task has no deadline. An expired task stops its worker process and reports `timed out` separately from cancellation and other errors; usage recorded before expiry is still included.

Each worker starts with the resolved profile on its command line:

```bash
pi --mode rpc --no-session --model provider/model --thinking medium --tools ...
```

The same model and thinking level are used for investigation and the worker's synthesis pass. Usage from both passes, nested worker tools, and worker compaction is aggregated into the `delegate_tasks` tool result. Pi includes it in the parent session footer, `/session`, and RPC session totals.

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
- Worker stderr retained for error reports is limited to its last 8,192 characters. Error messages indicate when earlier stderr was truncated.
- The parent extension captures at most the first 32,768 characters of investigation assistant text and 16,384 characters of synthesis assistant text. Clipped fallback or synthesis reports are marked. This does not limit the worker's conversation context or tool results.
- The live parent widget keeps each worker's assigned goal and ID visible on a stable line while RPC events update a separate current-activity line. Use `/cancel-worker <id>` to stop one worker without stopping the others.
- Worker extension UI requests are proxied to the parent UI and parallel dialogs are queued. While a proxied dialog is open, the parent emits `herdr:blocked` so the authoritative TUI integration reports that it is waiting for input.
- Tool-guard is reused from a parent extension argument or an adjacent `pi-tool-guard` checkout when available. Worker extension discovery stays enabled by default so extension-provided models remain available; set `PI_DELEGATE_TOOL_GUARD_ISOLATE=1` only when duplicate guard discovery is a problem.
- Read-only workers can be configured with `PI_DELEGATE_TOOLS=read,grep,find,ls`.
