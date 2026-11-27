# pi-delegate-workers

A local pi package that adds a `delegate_tasks` tool for model-directed delegation.

The agent decides what to delegate from normal prompts. Work that needs reasoning runs in `pi --mode rpc` workers and returns compact summaries. Shell commands run directly in the current working directory without starting Pi or using a model. Both kinds of work can run in parallel, either blocking or in the background.

## What it does

- `delegate_tasks` with parent-agent-selected `fast`, `balanced`, or `deep` profiles
- background jobs return IDs immediately after authorization and report results separately as they finish; `delegate_wait` collects their results when needed
- direct Bash and PowerShell commands authorized by `pi-tool-guard`
- `/cancel-worker 13` to cancel the queued or running job shown as `w13` in the live widget (the `w13` form is also accepted)
- optional deadlines starting when a job launches; jobs have no timeout by default
- session-wide coordinator queues jobs across overlapping calls and limits concurrent execution
- one-level nested delegation by default, with a shared coordinator and descendant cancellation
- per-profile model and thinking level configuration
- ordered model tiers with blocking, tool-free advisor consultations for eligible workers
- persistent `/advisor` selection for the parent agent without changing its session model
- automatic model-set selection from the active parent model
- per-task model-set overrides for aligned or cross-model delegation
- global, Git-repository, and current-directory JSON configuration
- live per-worker widget with a stable goal line and changing current activity
- progress text and current tool activity streamed from each worker over RPC
- per-worker synthesis before returning results to the parent
- worker token and cost usage added to the parent session totals
- default worker tools include `codemode` and `tool_search`, plus `consult_advisor` where eligible and `delegate_tasks` for depth-one workers; depth-two workers cannot delegate; optional per-task tool subsets

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
      "tiers": [
        { "id": "quick", "model": "anthropic/claude-haiku", "thinkingLevel": "low" },
        { "id": "standard", "model": "anthropic/claude-sonnet", "thinkingLevel": "medium" },
        { "id": "thorough", "model": "anthropic/claude-opus", "thinkingLevel": "high" },
        { "id": "advisor", "model": "anthropic/claude-opus", "thinkingLevel": "max", "advisorOnly": true }
      ],
      "profiles": {
        "fast": "quick",
        "balanced": "standard",
        "deep": "thorough"
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

Model sets overlay the top-level profiles. `modelSets.<name>.tiers` is an ordered array from lowest to highest rank. Each tier has an `id` and exact `model`, with optional `thinkingLevel` and `advisorOnly`. An advisor-only tier is available for consultation, not as a worker profile. Profile strings are aliases to tier IDs in that set; the `claude` example maps the three worker profiles to tiers and reserves the last tier for advice. A tier alias uses the tier's model and thinking level, not the top-level profile. If the tier omits the thinking level, Pi uses its startup setting for a worker and the provider default for a consultation.

Legacy profile objects remain supported, including configurations without model sets. In the `diverse` example, model-set profile objects supply models while top-level profiles supply thinking levels. For a named legacy model set without explicit tiers, advisor tiers are inferred from explicitly resolved models in `fast`, `balanced`, `deep` order. In an explicitly tiered set, a profile that uses a legacy object instead of a tier alias has no known rank, so it cannot use worker tier escalation.

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

Named model sets are deeply merged across scopes. Arrays replace inherited arrays rather than merging their entries: a narrower scope replaces the complete `tiers` or `parentModelRoutes` list. Set a model-set entry to `null` to remove it, or set `defaultModelSet` to `null` to clear the inherited default. Set `parentModelRoutes` to `null` to clear all inherited routes.

## What to prompt

Use a normal prompt, for example: “Run `yarn testBlabla` in the background while you review the config change.” There is no launch command. Use the live widget to see which jobs are queued or running and `/cancel-worker <id>` to stop one.

Direct commands require [`pi-tool-guard`](https://github.com/petereichinger/pi-tool-guard) v0.15.0 or later. For local testing, load both checkouts with `pi -e /path/to/pi-delegate-workers -e /path/to/pi-tool-guard`. If the guard is missing or does not respond, command delegation is disabled; agent delegation still works.

## Tool usage

The agent calls `delegate_tasks` with structured agent tasks, direct commands, or both. It waits for results unless it selects `"mode": "background"`. For example:

```json
{
  "mode": "background",
  "commands": [{ "command": "yarn testBlabla", "shell": "bash", "timeoutMs": 300000 }],
  "tasks": [{ "task": "Review the config change without editing files", "profile": "fast" }]
}
```

- Commands default to Bash. Use `"shell": "powershell"` on Windows if that tool is available. The tool guard checks each command before the batch is queued. A required approval can pause submission, but not the background run.
- Commands use the local shell backend, with bounded combined stdout/stderr and an exit code. Agent jobs and command jobs share the same concurrency limits. A command job does not use a worker profile or `sharedContext`.
- Background jobs survive cancellation of the parent turn. Switching sessions, reloading, or exiting cancels them. Each job posts a status notification immediately. Its result enters the originating session when Pi can append it without interrupting an active turn. Completion does not start a new model turn. Background agent usage is recorded with its result, not added to Pi’s built-in usage totals.
- Background agents cannot open parent dialogs or delegate further. Nested calls support blocking agent tasks only.
- In Pi’s terminal UI, finished Bash and PowerShell jobs show one line each with status, exit code, duration, and an output preview. Agent jobs show their status and statistics plus up to three rows of output. Use Pi’s tool output shortcut (`Ctrl+O` by default) to expand or collapse the results. The model still receives the full result, subject to the existing output limits.

A blocking agent-only batch can use the existing form:

```json
{
  "tasks": [
    { "task": "Locate the auth middleware without making changes", "profile": "fast", "tools": ["read", "codemode", "tool_search"] },
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

The profile is optional and falls back to `defaultProfile`. Leave `modelSet` out to infer it from the active parent model. Empty or whitespace-only values also use automatic routing. A non-empty task model set overrides automatic routing only for that task; unknown names are rejected. Tasks must use the structured object format shown above.

`timeoutMs` is optional per task and must be an integer from 1 to 2,147,483,647 milliseconds. It covers both the investigation and synthesis passes, starting when the worker is launched, not while it waits in the queue. Without it, the task has no deadline. An expired task stops its worker process and reports `timed out` separately from cancellation and other errors; usage recorded before expiry is still included.

`tools` is an optional non-empty array of distinct tool names for one task. It must be a subset of `PI_DELEGATE_TOOLS` (or the default `read,write,edit,bash,codemode,tool_search,delegate_tasks,consult_advisor` for eligible depth-one workers; depth-two workers cannot delegate, and `consult_advisor` is available only where a higher tier exists). For read-only tasks, use `"tools": ["read", "codemode", "tool_search"]` when all three tools are in the worker allowlist. Do not exclude `codemode` or `tool_search` just because the task is read-only. Add `bash` only when command access is needed. Explicit tool restrictions remain authoritative; no tools are added automatically. `codemode` runs JavaScript scripts that call available tools; `tool_search` finds and declares deferred tools, such as MCP tools. Both are available by default at either depth. To allow file search tools (`grep`, `find`, or `ls`) in a subset, first add them to `PI_DELEGATE_TOOLS`. Omitting `tools` preserves the current worker behavior.

Each worker starts with the resolved profile on its command line:

```bash
pi --mode rpc --no-session --model provider/model --thinking medium --tools ...
```

The same model and thinking level are used for investigation and the worker's synthesis pass. For blocking calls, usage from both passes, nested worker tools, and worker compaction is aggregated into the `delegate_tasks` tool result. Pi includes it in the parent session footer, `/session`, and RPC session totals.

### Consult an advisor

An eligible worker can call `consult_advisor` with `{ "question": "Check this conclusion" }`. The default target is the next higher tier in its resolved model set. To jump to a specific higher tier, use `{ "question": "Check this conclusion", "target": "advisor" }`, where `target` is a tier ID. Workers at the top tier have no advisor. Explicit global (`PI_DELEGATE_TOOLS`) and per-task (`tools`) allowlists remain authoritative: include `consult_advisor` in each explicit list that applies to enable it where eligible. It is not added to restricted lists automatically.

A consultation makes one blocking, tool-free model call with a five-minute timeout. It does not change the worker's model or start another delegation. Advisors cannot call tools, consult another advisor, or recursively escalate.

The parent agent also has `consult_advisor`, controlled by `/advisor`:

- `/advisor <set>/<tier>` selects a named model-set tier, including a tier from another provider.
- `/advisor auto` uses the current parent model at its next supported thinking level, or the same level if there is no higher supported level. This is the default.
- `/advisor off` disables parent consultations.
- `/advisor` with no arguments shows the saved selection and its current resolution.

The parent selection persists in `getAgentDir()/extensions/delegate-advisor.json` (`<agent-dir>/extensions/delegate-advisor.json`). Resolution is dynamic: changes to the active parent model or thinking level affect `auto` without changing the saved selection. Selecting or consulting an advisor never changes the parent session model. Parent selection is separate from worker tier escalation.

Both parent and worker consultations send the question and bounded recent text from the active conversation to the target model's provider. This includes tool-result text, but not tool arguments, images, or reasoning. Conversation text is not automatically redacted; choose advisor providers accordingly. A worker tier or explicit parent selection can send this text to a different provider. Do not enable those routes for conversations you cannot share with that provider.

### Query job status

The main agent can call `delegate_status` with `{}` to list active jobs or with `{ "id": "w3" }` to look up one job. The tool returns a snapshot immediately; it does not wait for workers. It covers direct agent and shell jobs, not nested workers. The snapshot includes the job ID, state, a short label, and progress or the worker tool name when available. `cancelling` means a cancellation was requested but the job has not stopped yet.

Lookup by ID also covers the last 50 finished jobs in the current session. Session switches and reloads clear this history. A missing ID does not imply the job is still running.

### Wait for job results

Use `delegate_wait` after doing work in parallel with background jobs. Call it with `{}` to wait for all direct jobs that are queued or running at the time of the call. This also returns recent background results that `delegate_wait` has not yet returned, so jobs that finished early are not missed. Jobs submitted later are not included.

Use `{ "ids": ["w1", "w3"] }` to wait for only those jobs, including jobs that already finished. An unknown ID is an error. Finished results are available for the last 50 jobs in the session. The tool returns full results, including failures, cancellations, and timeouts. Cancelling the wait does not cancel the jobs.

## Environment settings

- `PI_DELEGATE_PI_BIN` — worker pi binary/path (default: `pi`)
- `PI_DELEGATE_TOOLS` — comma-separated worker tool allowlist (default: `read,write,edit,bash,codemode,tool_search,delegate_tasks` at depth one; `read,write,edit,bash,codemode,tool_search` at depth two, plus `consult_advisor` where eligible at either depth). An explicit value replaces these defaults; include `consult_advisor` to permit eligible worker consultations.
- `PI_DELEGATE_MAX_WORKERS` — maximum total agent tasks and command jobs per batch (default: `5`)
- `PI_DELEGATE_MAX_ACTIVE_WORKERS` — maximum concurrently running jobs in one parent session (default: `10`)
- `PI_DELEGATE_MAX_LIVE_WORKERS` — maximum live delegated jobs in one parent session, including workers that yield their active slot (default: `30`; must be at least the active limit, and at least `2` for nesting)
- `PI_DELEGATE_MAX_DEPTH` — maximum delegation depth: `2` (default; allow one nested level) or `1` (disable nesting)
- `PI_DELEGATE_EXTRA_ARGS` — additional worker CLI arguments
- `PI_DELEGATE_TOOL_GUARD` — tool-guard auto-loading mode; set `0`/`false` to disable or `1`/`required` to force
- `PI_DELEGATE_TOOL_GUARD_EXTENSION` — explicit tool-guard extension source/path
- `PI_DELEGATE_TOOL_GUARD_ISOLATE` — set to `1`/`true` to add `--no-extensions` when explicitly loading tool-guard (default: off); enabling isolation also disables other discovered worker extensions, including custom model providers
- `PI_DELEGATE_COORDINATOR_ENDPOINT`, `PI_DELEGATE_WORKER_TOKEN`, `PI_DELEGATE_WORKER_DEPTH` — internal: inherited by workers to use the parent's coordinator; do not set them manually

When a resolved profile controls the model or thinking level, conflicting `--provider`, `--model`, and `--thinking` entries are removed from `PI_DELEGATE_EXTRA_ARGS`. When a task specifies `tools`, conflicting `--tools` entries are also removed so extra arguments cannot widen its subset. Other extra arguments remain.

## Notes

- Workers run in the same CWD as the main session.
- The session coordinator uses a private local socket (a named pipe on Windows). By default depth-one workers can call `delegate_tasks`. Set `PI_DELEGATE_MAX_DEPTH=1` to disable nesting. The default worker tool allowlist includes `delegate_tasks` at depth one; an explicit `PI_DELEGATE_TOOLS` or per-task `tools` list must include it to allow delegation. Depth-two workers cannot delegate. An active worker counts toward both limits; one waiting for children keeps its live-process slot but releases its active slot until its children finish. Root workers reserve one live-process slot for children, so the live-process cap cannot prevent all nested work. Cancelling a parent stops its queued and running descendants. Parallel nested `delegate_tasks` calls in the same worker are rejected; other tool calls must finish before that worker releases its active slot. Top-level queued tasks appear in the parent's live widget and can be cancelled with `/cancel-worker <id>`. The live widget groups nested tasks immediately below their parent (for example, `w1`, `w1.1`, `w1.2`, `w2`); nested tasks also appear in their worker's tool result. Cancelling a top-level parent also cancels its descendants. Results include `queue_wait_ms`. Closing the session stops its coordinator and workers.
- Worker stderr retained for error reports is limited to its last 8,192 characters. Error messages indicate when earlier stderr was truncated.
- RPC stdout records are limited to 16 MiB each. An oversized record stops that worker and returns a protocol error instead of leaving its task waiting for completion.
- A worker cannot start another prompt until an aborted prompt has settled. Task cancellation and deadlines dispose the worker process.
- The parent extension captures at most the first 32,768 characters of investigation assistant text and 16,384 characters of synthesis assistant text. Clipped fallback or synthesis reports are marked. This does not limit the worker's conversation context or tool results.
- The live parent widget keeps each worker's assigned goal and ID visible on a stable line while RPC events update a separate current-activity line. Streamed text updates are throttled to at most one widget refresh per second; state changes refresh immediately. Use `/cancel-worker <id>` to stop one worker without stopping the others.
- Worker extension UI requests are proxied to the parent UI and parallel dialogs are queued. Disposing a worker dismisses its open dialog and skips its queued dialogs. While a proxied dialog is open, the parent emits `herdr:blocked` so the authoritative TUI integration reports that it is waiting for input.
- Tool-guard is reused from a parent extension argument or an adjacent `pi-tool-guard` checkout when available. Worker extension discovery stays enabled by default so extension-provided models remain available; set `PI_DELEGATE_TOOL_GUARD_ISOLATE=1` only when duplicate guard discovery is a problem. Isolation or `--no-extensions` also disables the built-in `codemode` and `tool_search` extensions. To retain them, add `-e builtin:codemode -e builtin:tool-search` to `PI_DELEGATE_EXTRA_ARGS`.
- For read-only tasks, select `"tools": ["read", "codemode", "tool_search"]` when allowed and instruct the worker not to make changes through scripts, shell commands, or discovered tools. Tool selection is not a read-only sandbox; `bash` permits writes. To allow `grep`, `find`, or `ls`, include them in `PI_DELEGATE_TOOLS` first. A reading and search configuration can use `PI_DELEGATE_TOOLS=read,grep,find,ls,codemode,tool_search`; enforce strict read-only access with permissions or a sandbox.
