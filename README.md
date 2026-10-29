# Architect / Implementer workflow

A DSH bundle that gives one session two models with a strict handoff:

- **Architect** (the session model, e.g. `openai/gpt-6-astra`) plans, defines
  acceptance criteria, and verifies the result.
- **Implementer** (a child agent, e.g. `deepseek-account/deepseek-flash`) reads
  code, edits files, runs commands and tests, and returns evidence.

The architect never edits code through the filesystem tool. The implementer is
an independent preset with no delegation, no user-question tool, and a fixed
model. The `implementer` call **blocks** until the child reports: its result is
the BuildReport, and the same child is continued by passing its `subagentId` back
with a delta brief. Nothing is added to the architect's context while it waits.

## Files

| Path | Purpose |
|---|---|
| `index.js` | Blocking `implementer` tool, architect protocol section, settlement cache, and retry policy. |
| `cordis.patch.yml` | Declares the `implementer` and `architect` agent presets. |
| `skills/architect-executor/SKILL.md` | Full BuildBrief/BuildReport protocol loaded on demand. |
| `examples/profile.cordis.patch.yml` | Rows to merge into a new machine's profile patch. |
| `.github/workflows/test.yml` | Runs `node --check` and `npm test` on push. |

## Test

```sh
npm test
```

The suite covers the blocking handoff (settlement, wait limit, continuation,
detach, failed and empty reports), argument validation, and the fixed-delay
`PI_AI_ERROR` retry budget.

## Install in a profile

```sh
dsh plugin --profile web add /absolute/path/to/architect-executor
# or install straight from git:
dsh plugin --profile web add git+https://host/you/dsh-architect-executor.git
```

The bundle is installed as a profile dependency and selected as a profile
layer. Then set the architect session model as the profile default and make
`architect` the default preset in
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: openai
    model: gpt-6-astra

- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
    selectedDefault: architect
```

New sessions then use the architect preset and `gpt-6-astra`. The implementer
route is fixed by the `architect-executor` row in `cordis.patch.yml`:

```yaml
provider: deepseek-account
model: deepseek-flash
reasoningEffort: high
```

Change those fields to use another fast model. The model must be registered as
an LLM route in the profile.

## Deploy on another machine

The bundle is self-contained: `package.json`, the preset patch
(`cordis.patch.yml`), the plugin (`index.js`), the skill, and tests. There is
no build step and no runtime dependency.

1. Clone it and install the bundle into the target profile:

   ```sh
   git clone <repo-url> ~/src/dsh-architect-executor
   dsh plugin --profile web add ~/src/dsh-architect-executor
   ```

   `add` runs pnpm inside the profile, records the bundle in
   `~/.dsh/profiles/web/package.json` (`link:` for a directory), and applies
   the bundle's patch layer — the `architect` and `implementer` presets — on the
   next boot.

2. Register the model routes and select the preset. Merge the rows from
   [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml) into
   `~/.dsh/profiles/web/cordis.patch.yml`, replacing the placeholder endpoint
   and model ids with routes that machine actually has.

3. Restart `dsh web` and start a new session. Existing sessions keep the
   composition they started with.

4. Verify the install:

   ```sh
   dsh --profile web --dump-config | grep -A12 'id: architect-executor'
   ```

   should print the `waitTimeoutMs` and `retry` block, and the first delegated
   task should show exactly one blocking `implementer` call.

The implementer route is fixed by the `architect-executor` row in this repo's
`cordis.patch.yml` (`deepseek-account/deepseek-flash`). A row nested inside a
preset has no profile-level override, so edit that file in the clone before
installing when the machine uses another fast route.

### Updating a deployed copy

```sh
git -C ~/src/dsh-architect-executor pull
```

For a `link:` install the working tree is the installed code, so the pull is
enough; restart `dsh web` to load it. A git-URL install keeps its own copy, so
re-run `dsh plugin --profile web add <url>` and restart.

## Use

1. Start a new session (new preset/model defaults apply to new sessions only).
   The profile in this workspace is already configured with `gpt-6-astra` as
   the default model and `architect` as the default preset. If the preset does
   not appear, restart the running `dsh web` process so the profile is composed
   again.
2. Ask for a coding task. The architect loads the `architect-executor` skill,
   states a plan and acceptance criteria, then calls `implementer`.
3. The call blocks while the implementer works in a child session. When the
   child settles, the tool result is its BuildReport; the turn resumes with the
   report already in context. The architect verifies, continues the same child
   with a delta brief if needed, and reports the final result.
4. Open the child session from the conversation to inspect the implementer's
   raw work.

A small first test:

> Add a `--version` flag to the CLI, with a test. Plan first, delegate the
> implementation to the implementer, and verify the acceptance criteria before
> reporting.

## Blocking handoff

`implementer` starts or continues a child with `delivery: 'caller'`, then waits
for its settlement. The architect issues no model request during the wait, so a
two-minute implementation costs zero architect tokens while it runs, and the
BuildReport enters history once, next to the plan and acceptance criteria that
verify it.

This replaces the earlier fire-and-forget shape, where the tool returned
`started implementer <id>` and the report arrived later as a separate turn. In
that gap the architect had no legitimate step, so models filled it with
`list_agents`, `bash sleep`, or "status?" messages — each one a full-context
request that bought no information, and each nudge a `steer` injected into the
implementer's own context.

A call ends in one of four results:

- `status: completed` — the result text is the BuildReport. A child that ended
  for any other reason (error, cancellation, token limit) or produced no report
  is an `isError` result carrying whatever it did produce.
- `status: running` — the wait limit expired. The child keeps running; call
  `implementer` again with the same `subagentId` and `wait: true`. If the child
  settles in the meantime, the next wait returns immediately from the cache.
- `status: idle` — `wait: true` named a child with no run in flight (its last
  report was already returned, or it belongs to a previous process). The call
  returns immediately; pass a delta brief to continue that child.
- `status: detached` — the wait was aborted (turn stop or plugin disposal). The
  child is not cancelled. The tool layer rewrites an aborted call to
  `tool call aborted` before it reaches the model, so in practice this status is
  not visible: treat an aborted wait as a detached child, and stop it with
  `interrupt_agent` if it is no longer wanted.

`prompt` together with `wait: true` is accepted: the prompt wins, so the call
continues the child and blocks like any continuation. `wait` only matters when
no prompt is given.

Each settlement is consumed by at most one wait, and at most 64 finished
children are cached for the detached/`running` recovery path. `send_message` is
still available, but only to steer a child whose brief is actually wrong — never
as a progress check.

The wait limit is `waitTimeoutMs` (default 15 minutes); `0` waits without a
limit. It is a delivery deadline, not a hard tool deadline: nothing is killed
when it fires.

## Automatic `PI_AI_ERROR` retry

The plugin retries a failed architect model request itself, on the agent loop's
`agent/request-error` recovery hook. When a request fails with a configured
code, it waits a fixed delay and asks the loop to retry. The loop re-runs the
same turn and step against the existing durable history: nothing is appended to
the session, no new turn or subagent starts, and the conversation context is
unchanged.

The budget counts retries **after** the initial failed attempt, so
`maxRetries: 10` allows up to 11 provider requests total. The in-memory budget
is tracked per architect agent/session and per turn/step, so simultaneous
architect sessions do not share or consume each other's retries. Defaults are
used when `retry` is omitted:

```yaml
retry:
  enabled: true
  maxRetries: 10
  delayMs: 30000
  codes:
    - PI_AI_ERROR
```

Override the block on the `architect-executor` row in `cordis.patch.yml`:

```yaml
- id: architect-executor
  name: '@local/dsh-architect-executor'
  config:
    subagentProvider: spawn
    agentPreset: implementer
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
    maxDepth: 1
    waitTimeoutMs: 900000
    retry:
      enabled: true
      maxRetries: 10
      delayMs: 30000
      codes:
        - PI_AI_ERROR
```

Notes:

- The delay is fixed: no exponential backoff, no jitter, and no provider
  `Retry-After` override.
- `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, and `EMPTY_RESPONSE` are
  already retried by the built-in `dsh-llm-retry` policy, so they are not in
  the default code list. Add `RATE_LIMIT` to `codes` only if you also want this
  plugin's fixed-delay budget for it.
- A retry stops when the request is aborted or the plugin is disposed; the
  pending wait is cancelled and no timer is left behind.

## Context budget

The architect's compaction trigger is:

```text
floor(min(W × thresholdRatio, W - O - headroomTokens))
```

where `W` is the model's context window, `O` is the request's output-token
reservation (`maxTokens`), and `headroomTokens` is the compaction headroom.

The previous configuration had `W = 272000`, `O = 128000`, and the default
`headroomTokens = 65536`, so the trigger was:

```text
272000 - 128000 - 65536 = 78464 tokens ≈ 28.8% of W
```

That is why compaction started around 30% usage. The output reservation is the
largest term: a 128k output cap is reserved out of the same 272k window on every
request, even when the response is small.

The current setup uses:

- GPT model `maxTokens: 32768`
- architect compaction `headroomTokens: 16384`
- `thresholdRatio: 0.8`
- `retainTokens: 16000` for the recent verbatim tail
- a more aggressive tool-result pruner (`4096 / 2048 / 512` characters)

So the trigger becomes `min(217600, 272000 - 32768 - 16384) = 217600` tokens,
or 80% of the window. If a task genuinely needs very long single responses,
raise `maxTokens`; the compaction trigger will move earlier again.

`retainTokens` is the other half of the savings calculation. A compaction pass
can only shadow history older than that recent tail; it cannot touch the system
prompt, tool schemas, the retained tail, or an indivisible tool call/result
pair. The default tail was 16% of `W - O`, about 38k tokens, which left a large
part of a long single turn uncompacted. The current 16k tail lets each pass
shadow more older history.

Only the implementer's final BuildReport crosses into the architect's context,
and now exactly once per call: no activation receipt, settlement notice, polling
result, or nudge is appended around it. Its tool calls, file reads, and
intermediate output stay in the child session. Keep reports compact, and keep
architect exploration to decision-critical reads. Wait time itself is free — the
architect's turn is suspended inside the tool call, so a long implementation no
longer grows the context or triggers an early compaction between the plan and
its verification.

## Rollback

```sh
dsh plugin --profile web remove @local/dsh-architect-executor
```

Then restore `agent-default-model` and `agent-preset-registry` in the profile
patch to their previous values. Existing sessions keep the composition they
started with.

## Limitations

- The no-edit rule for the architect is enforced for `write`/`edit`; `bash`
  remains available for verification commands and is prompt-constrained.
- A blocking call holds the architect's turn open. New user messages queue for
  the next step. Interrupting the turn aborts the wait but does not stop the
  implementer: the tool layer replaces the result with `tool call aborted`, so
  the model loses the handle to the child id. The child keeps working and is
  visible in the session; use `interrupt_agent` to stop it.
- The wait limit is per call and returns `status: running`; it never kills the
  child. A child that genuinely hangs must be stopped with `interrupt_agent`.
- Waits are per process. A `wait: true` for a child created before a restart has
  no settlement to receive and returns `status: idle` immediately instead of
  blocking; continue it with a delta brief.
- `list_agents` is deliberately not mounted for the architect. The only status
  surface is the blocking call, so a model cannot fall back to polling; re-add
  the row in `cordis.patch.yml` if a multi-child workflow needs it.
- The implementer inherits the session's permission scope. Operations that
  require interactive approval fail in the child; the implementer should return
  a blocker rather than retry.
- The implementer is capped at one delegation level (its own preset has no
  delegation tools), so it cannot recursively spawn more agents.
- The architect should use one implementer child per task; starting several in
  the same workspace can cause file conflicts.
