# pi-delegate-workers

A local pi package that adds a `/delegate` command and a `delegate_tasks` tool.

It launches separate `pi --mode rpc` worker processes, runs configured tasks through a session-scoped background queue, and lets the parent collect early results or add follow-up workers while other tasks continue.

## What it does

- `/delegate [fast] task A | [deep] task B` starts a background batch
- `/cancel-worker 13` cancels a queued or running worker shown as `w13` (the `w13` form is also accepted)
- `delegate_tasks` starts a batch and returns the first completed result
- `delegate_results` collects available results or waits for the next/all results
- `delegate_add_tasks` adds adaptive follow-up work while existing workers continue
- `delegate_cancel` cancels a worker or batch from the parent agent
- global concurrency scheduling across all active batches
- per-profile model and thinking level configuration
- global, Git-repository, and current-directory JSON configuration
- live per-worker widget with a stable goal line and changing current activity
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

### Start a batch

`delegate_tasks` uses structured tasks, starts every worker, and waits for the first completed result:

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

The first return includes every result that became available at that completion boundary plus the current batch status. The parent can then evaluate the findings, add follow-up tasks, or explicitly wait for the next/all remaining results. The profile is optional and falls back to `defaultProfile`. Legacy calls containing string tasks are normalized automatically.

Use `"background": true` only when detached execution is intentional. Background mode returns immediately with the batch and worker IDs and no initial results.

### Collect results

The parent chooses whether to inspect completed work immediately or wait:

```json
{ "batchId": "b1", "waitFor": "available" }
```

- `available` returns all currently completed, undelivered results immediately.
- `next` waits for at least one new result.
- `all` waits until every task in the batch is completed, failed, or cancelled.

`next` and `all` accept an optional `timeoutMs` up to 300000. If the parent turn is interrupted while waiting, the call returns the current snapshot with `wait_interrupted: true`; it does not fail the turn or cancel background workers, and explicitly tells the parent to collect again. Results are delivered once, in completion order. Every response also reports queued, running, completed, failed, cancelled, and ready-result counts.

Before replying to the user, the parent is instructed to collect every result from batches started for that request. Worker completions are coalesced while the parent is active. If the parent settles with an uncollected result—or a result arrives while it is idle—the extension injects one model-visible follow-up reminder and starts another turn. Reminder turns are deferred until the settled event has fully unwound so Pi installs the new run's cancellation handling correctly. Collecting the available results rearms this wake-up behavior for later completions.

### Add follow-up work

The parent can add tasks to a batch after learning from early results:

```json
{
  "batchId": "b1",
  "tasks": [
    { "task": "Inspect the refresh race reported by w2", "profile": "deep" }
  ],
  "sharedContext": "Extra context for these new tasks"
}
```

Tasks start as global capacity becomes available; existing workers continue uninterrupted.

### Cancel work

```json
{ "workerId": "w3" }
```

or:

```json
{ "batchId": "b1" }
```

Provide exactly one target to `delegate_cancel`.

Each worker starts with the resolved profile on its command line:

```bash
pi --mode rpc --no-session --model provider/model --thinking medium --tools ...
```

The same model and thinking level are used for investigation and the worker's synthesis pass.

## Environment settings

- `PI_DELEGATE_PI_BIN` — worker pi binary/path (default: `pi`)
- `PI_DELEGATE_TOOLS` — comma-separated worker tool allowlist (default: `read,write,edit,bash`)
- `PI_DELEGATE_MAX_WORKERS` — maximum simultaneously running workers globally, and maximum tasks accepted by one start/add call (default: `5`)
- `PI_DELEGATE_EXTRA_ARGS` — additional worker CLI arguments
- `PI_DELEGATE_TOOL_GUARD` — tool-guard auto-loading mode; set `0`/`false` to disable or `1`/`required` to force
- `PI_DELEGATE_TOOL_GUARD_EXTENSION` — explicit tool-guard extension source/path
- `PI_DELEGATE_TOOL_GUARD_ISOLATE` — set to `1`/`true` to add `--no-extensions` when explicitly loading tool-guard (default: off); enabling isolation also disables other discovered worker extensions, including custom model providers

When a resolved profile controls the model or thinking level, conflicting `--provider`, `--model`, and `--thinking` entries are removed from `PI_DELEGATE_EXTRA_ARGS`. Other extra arguments remain.

## Notes

- Workers run in the same CWD as the main session. Background write-enabled workers can conflict with the parent or each other; prefer `PI_DELEGATE_TOOLS=read,grep,find,ls` for exploratory batches.
- Batches and result delivery live for the current session. Session shutdown cancels queued and running work.
- The live parent widget keeps queued/running workers' assigned goals and IDs visible on a stable line while RPC events update a separate current-activity line. A notification announces each terminal worker, and newly available uncollected results wake a settled parent once per collection cycle. Use `/cancel-worker <id>` to stop one worker without stopping the others.
- RPC worker prompts complete on `agent_settled`, not the earlier low-level `agent_end`, so automatic retries, compaction retries, and queued continuations finish before investigation or synthesis output is accepted.
- Worker extension UI requests are proxied to the parent UI and parallel dialogs are queued. While a proxied dialog is open, the parent emits `herdr:blocked` so the authoritative TUI integration reports that it is waiting for input.
- Tool-guard is reused from a parent extension argument or an adjacent `pi-tool-guard` checkout when available. Worker extension discovery stays enabled by default so extension-provided models remain available; set `PI_DELEGATE_TOOL_GUARD_ISOLATE=1` only when duplicate guard discovery is a problem.
- Read-only workers can be configured with `PI_DELEGATE_TOOLS=read,grep,find,ls`.
