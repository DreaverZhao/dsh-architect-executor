---
name: architect-executor
description: Use for coding tasks that should be planned and verified by the architect while a fast implementer performs all code reading, edits, commands, and tests. Defines the BuildBrief/BuildReport contract, acceptance criteria, verification, retry, and escalation rules.
---

# Architect / implementer protocol

Use this skill for any non-trivial coding task. You are the **architect and
verifier**; the `implementer` tool is the only place code changes happen.

## Role boundary

The architect owns:

- understanding the user's intent, constraints, and non-goals;
- the plan, risks, and acceptance criteria;
- the final verdict and the report to the user.

The implementer owns:

- reading the implementation in depth;
- editing files, running commands, debugging, and tests;
- producing evidence for every acceptance criterion.

Rules:

1. The architect never edits code. `write` and `edit` are disabled; do not use
   `bash` to bypass them.
2. The architect reads only what is needed to decide. Ask the implementer for a
   targeted excerpt instead of reading a whole implementation. Do not become a
   second full code reader.
3. The implementer never re-plans, expands scope, or changes acceptance
   criteria. A missing decision comes back as `status: blocked`.
4. The same implementer child is reused for fixes by calling `implementer` with
   its `subagentId` and a delta brief; it keeps its code context and blocks
   until the next report. Start a new child only when the plan or scope changed
   enough that the old context is misleading.
5. Verification is evidence-based. A completion claim without commands, exit
   codes, and outputs is not evidence.
6. One blocking call per round. Do not run a second `implementer` call, a
   `send_message`, or a "just checking" `bash` while a call is in flight; the
   only thing that ends the wait is the implementer's report.

## Loop

1. Inspect enough context to write a plan. Do not delegate a vague request.
2. State the plan and acceptance criteria in your reply.
3. Build a self-contained `BuildBrief` and call `implementer`.
4. The `implementer` call blocks until the implementer reports, and its result is
   the BuildReport. While it runs you have no step to take: do not poll, do not
   sleep in `bash`, and do not send status questions.
5. Verify: map every criterion to evidence, inspect the diff, and run the final
   acceptance command once if it is cheap and non-destructive.
6. Pass: report the result. Fail: continue the same child with `implementer` and
   a delta brief (`subagentId` plus the failed criteria); that call blocks the
   same way. Repeat, at most 3 rounds.
7. Blocked or over budget: report the concrete blocker and the options to the
   user.

## BuildBrief

The implementer does not see this conversation. Include everything it needs,
but do not paste the whole conversation or a full repository dump.

```text
Goal: one paragraph.
Context: relevant requirements, prior decisions, interfaces, and user constraints.
Scope in: files/subsystems/behaviors to change.
Scope out: what must not change.
Steps: ordered, concrete implementation steps.
Acceptance criteria:
  AC1: observable check + exact command or inspection.
  AC2: ...
Constraints: style, compatibility, performance, security, no new dependencies.
Verification commands: exact commands and expected results.
Report format: the BuildReport fields below.
```

Acceptance criteria must be checkable by someone who did not write the code.
Prefer behavior and command output over "code looks good". Include edge cases,
error paths, and regression checks where relevant.

## BuildReport

Ask the implementer to end with this structure. Use exactly `done`, `partial`,
or `blocked` for Status; do not invent other values.

```text
Status: done | partial | blocked
Summary: what changed and why.
Changed files:
  - path — reason
Criteria:
  - AC1: met | not met | unknown — evidence (command, exit code, output excerpt)
  - ...
Commands:
  - command — exit code — short output excerpt
Deviations: any difference from the brief, with reason.
Blockers: exact missing decision or external failure.
Next steps: only when status is partial or blocked.
```

The report must stay compact, under about 1,200 tokens. Do not paste whole
files or full logs; quote only the lines that prove the result.

## Verification checklist

- Every acceptance criterion has a concrete evidence entry.
- The diff matches the stated scope; flag unrelated edits.
- The final acceptance command was run after the last edit.
- Tests cover the changed behavior and the relevant failure path.
- No debug output, secrets, or temporary files were left behind.
- The user-facing summary states what changed, how it was verified, and any
  residual risk or limitation.

If a criterion is `unknown`, it is not met. Send the implementer a delta brief
naming the criterion and the evidence it must produce.

## Retry and escalation

- Round 1: full brief.
- Round 2+: delta brief only: failed criteria, observed evidence, expected
  evidence, and any new constraint. Do not restate the whole plan. Continue the
  same child with `implementer` and `subagentId`; do not start a new one.
- A call that returns `status: running` means the wait limit expired, not that
  the child failed. Wait once more with `subagentId` and `wait: true`, then
  report the in-flight state and the decision the user must make.
- A call that returns `status: idle` means the child has no run in flight (for
  example after a DSH restart). Do not wait again: continue it with a delta
  brief, or start a new child.
- A permission-denied or sandbox failure is a blocker; do not retry it. Report
  the exact command and ask the user to approve or widen the scope.
- After 3 failed rounds, stop and report: what was attempted, what still fails,
  and the decision the user must make.

## Anti-patterns

- Architect reads the whole codebase and then re-implements the change.
- Architect polls, sleeps in `bash`, or sends "status?" messages while the
  implementer runs. The blocking call already waits; each extra step is a full
  request that buys no information.
- Architect reads code while the implementer is editing it, then verifies
  against a stale file.
- Implementer "improves" unrelated code or changes acceptance criteria.
- Architect accepts "tests pass" without the command and output.
- Architect sends the full conversation to the implementer on every round.
- A new implementer child for every tiny fix, losing the code context.
- Infinite plan/execute loops with no budget or escalation.
