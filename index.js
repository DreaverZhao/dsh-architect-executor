export const name = 'architect-executor'

export const inject = ['tools', 'subagents', 'systemPrompt']

const DEFAULTS = {
  subagentProvider: 'spawn',
  agentPreset: 'implementer',
  maxDepth: 1,
  waitTimeoutMs: 15 * 60 * 1000,
}

const RETRY_DEFAULTS = {
  enabled: true,
  maxRetries: 10,
  delayMs: 30000,
  codes: ['PI_AI_ERROR'],
}

const RETRY_BUDGET_LIMIT = 64

const SETTLEMENT_CACHE_LIMIT = 64

const PROTOCOL = `You are the architect and verifier. You own the plan, acceptance criteria, and final verdict. You do not edit code: every code change goes through the \`implementer\` tool. Read only the minimum code needed to decide; do not duplicate the implementer's full code reading. Before delegating, state a concise plan and concrete, checkable acceptance criteria, then send a self-contained brief. Load the \`architect-executor\` skill for the full protocol and templates.

The \`implementer\` call blocks until the implementer reports, and its result is the BuildReport. While it runs you have no step to take: do not poll, do not sleep in \`bash\`, and do not send status questions. After the report arrives, verify each criterion against its evidence and the diff. If it fails, continue the same child with \`implementer\` and a delta brief (\`subagentId\` plus the failed criteria); do not rewrite the code yourself. If a call returns \`status: running\` after the wait limit, you may wait once more for the same child (\`subagentId\` and \`wait: true\`); after that, report the in-flight state and the decision the user must make. Report the final result with evidence, residual risks, and how to run it.`

const TOOL_DESCRIPTION = `Delegate implementation work to the fast implementer subagent and block until it reports. The implementer shares the workspace, can read/write files and run commands, and cannot see this conversation. Provide a complete, self-contained BuildBrief: goal, context, scope, ordered steps, acceptance criteria with verification commands, and constraints.

The call returns the implementer's BuildReport as its result. Do not poll, sleep, or send status messages while it runs; there is nothing to do until the report arrives. If the wait limit expires, the result is \`status: running\` with the child id: wait again with \`{"subagentId": "...", "wait": true}\` at most once, then report the in-flight state to the user. A wait for a child with no run in flight returns \`status: idle\` immediately; pass a delta brief to continue that child instead.

Continue a child with \`subagentId\` and a delta brief (\`prompt\`); this blocks the same way and returns the next report. Use \`send_message\` only to steer a running child when the brief is actually wrong, never for progress checks. A child that ends without \`completed\` is reported as an error with whatever report it produced.`

/** Resolve and validate the plugin-local automatic retry policy. */
function resolveRetry(value) {
  if (value === undefined) {
    return { ...RETRY_DEFAULTS, codes: [...RETRY_DEFAULTS.codes] }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('architect-executor: retry must be an object')
  }
  const enabled = value.enabled === undefined ? RETRY_DEFAULTS.enabled : value.enabled
  if (typeof enabled !== 'boolean') {
    throw new Error('architect-executor: retry.enabled must be a boolean')
  }
  const maxRetries = value.maxRetries === undefined ? RETRY_DEFAULTS.maxRetries : value.maxRetries
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new Error('architect-executor: retry.maxRetries must be a non-negative safe integer')
  }
  const delayMs = value.delayMs === undefined ? RETRY_DEFAULTS.delayMs : value.delayMs
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('architect-executor: retry.delayMs must be a non-negative safe integer')
  }
  const codes = value.codes === undefined ? [...RETRY_DEFAULTS.codes] : value.codes
  if (!Array.isArray(codes) || codes.length === 0) {
    throw new Error('architect-executor: retry.codes must be a non-empty array of unique non-empty strings')
  }
  const seen = new Set()
  for (const code of codes) {
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('architect-executor: retry.codes must be a non-empty array of unique non-empty strings')
    }
    if (seen.has(code)) {
      throw new Error(`architect-executor: retry.codes contains duplicate code "${code}"`)
    }
    seen.add(code)
  }
  return { enabled, maxRetries, delayMs, codes: [...codes] }
}

/** Resolve and validate the deployment-owned implementer route, wait limit, and retry policy. */
export function resolveSettings(config = {}) {
  const settings = { ...DEFAULTS, ...config }
  for (const field of ['provider', 'model']) {
    if (typeof settings[field] !== 'string' || settings[field].length === 0) {
      throw new Error(`architect-executor: \`${field}\` must be a non-empty string`)
    }
  }
  if (typeof settings.agentPreset !== 'string' || settings.agentPreset.length === 0) {
    throw new Error('architect-executor: `agentPreset` must be a non-empty string')
  }
  if (!Number.isSafeInteger(settings.maxDepth) || settings.maxDepth < 0) {
    throw new Error('architect-executor: `maxDepth` must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(settings.waitTimeoutMs) || settings.waitTimeoutMs < 0) {
    throw new Error('architect-executor: `waitTimeoutMs` must be a non-negative safe integer (0 waits without a limit)')
  }
  if (settings.reasoningEffort !== undefined && (typeof settings.reasoningEffort !== 'string' || settings.reasoningEffort.length === 0)) {
    throw new Error('architect-executor: `reasoningEffort` must be a non-empty string when set')
  }
  settings.retry = resolveRetry(config.retry)
  return settings
}

/** Wait for a fixed delay, resolving false when the fused signal aborts first. */
function cancellableDelay(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Fuse the caller's cancellation with the plugin lifetime. */
function fuseSignals(caller, lifetime) {
  return caller === undefined ? lifetime : AbortSignal.any([caller, lifetime])
}

/** Render the implementer's final assistant output as report text. */
function reportText(result) {
  const parts = []
  for (const block of result.output ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** Derive a short display label when the caller omits `description`. */
function labelOf(prompt) {
  const line = prompt.split('\n').map((value) => value.trim()).find((value) => value.length > 0)
  return line === undefined ? 'implementer task' : line.slice(0, 60)
}

/**
 * Cache settled implementer results and hand one-shot waiters their settlement.
 *
 * A blocking call registers a waiter before it returns; a settlement with no
 * waiter (for example after the architect stopped waiting, or when the child
 * finished before the wait began) is cached instead, so a later `wait: true`
 * returns it immediately instead of hanging or forcing a status check.
 *
 * `live` tracks children this plugin instance has seen start or continue. A
 * `wait: true` for a child outside that set cannot receive a settlement in this
 * process, so it is answered at once instead of blocking until the wait limit.
 */
function createSettlements() {
  const finished = new Map()
  const waiters = new Map()
  const live = new Set()

  function markLive(childId) {
    live.add(childId)
  }

  function unmarkLive(childId) {
    live.delete(childId)
  }

  function isLive(childId) {
    return live.has(childId)
  }

  function take(childId) {
    const cached = finished.get(childId)
    if (cached === undefined) return undefined
    finished.delete(childId)
    return cached
  }

  function record(info) {
    live.delete(info.id)
    const result = { output: info.lastAssistantMessage ?? [], stopReason: info.stopReason }
    const pending = waiters.get(info.id)
    if (pending !== undefined && pending.size > 0) {
      waiters.delete(info.id)
      for (const waiter of [...pending]) waiter.settle({ kind: 'settled', result })
      return
    }
    if (finished.size >= SETTLEMENT_CACHE_LIMIT) finished.delete(finished.keys().next().value)
    finished.set(info.id, result)
  }

  function beginWait(childId, signal, timeoutMs) {
    const cached = take(childId)
    if (cached !== undefined) {
      return { promise: Promise.resolve({ kind: 'settled', result: cached }), cancel() {} }
    }
    if (signal.aborted) {
      return { promise: Promise.resolve({ kind: 'aborted' }), cancel() {} }
    }

    let settleOuter
    const promise = new Promise((resolve) => {
      settleOuter = resolve
    })
    let done = false
    const waiter = {
      settle(value) {
        if (done) return
        done = true
        cleanup()
        settleOuter(value)
      },
    }
    function cleanup() {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      const pending = waiters.get(childId)
      if (pending === undefined) return
      pending.delete(waiter)
      if (pending.size === 0) waiters.delete(childId)
    }
    const onAbort = () => waiter.settle({ kind: 'aborted' })
    const timer = timeoutMs > 0 ? setTimeout(() => waiter.settle({ kind: 'timeout' }), timeoutMs) : undefined
    signal.addEventListener('abort', onAbort, { once: true })
    const pending = waiters.get(childId) ?? new Set()
    pending.add(waiter)
    waiters.set(childId, pending)
    return { promise, cancel: () => waiter.settle({ kind: 'cancelled' }) }
  }

  return { record, beginWait, markLive, unmarkLive, isLive, take }
}

/**
 * Register the blocking implementer tool, the architect protocol, the
 * settlement listener, and the fixed-route retry policy in the calling
 * preset's scope.
 *
 * The tool starts or continues a managed child with `delivery: 'caller'`, then
 * waits for its settlement instead of returning an activation receipt. While
 * the wait runs the architect issues no model request: the report becomes this
 * tool's result, so the architect's turn stays suspended and no polling step or
 * settlement message is added to either context.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const lifetime = new AbortController()
  const settlements = createSettlements()

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'architect-executor:protocol',
    order: 150,
    text: PROTOCOL,
  }))

  function completed(childId, result) {
    const body = reportText(result)
    if (result.stopReason !== 'completed') {
      const partial = body.length > 0 ? `\n\nPartial report:\n${body}` : ''
      throw new Error(`implementer ${childId} ended with stopReason "${result.stopReason}" and did not complete the brief.${partial}`)
    }
    if (body.length === 0) {
      throw new Error(`implementer ${childId} finished without a report; verify the work yourself before claiming completion.`)
    }
    return {
      status: 'completed',
      childId,
      stopReason: result.stopReason,
      report: `BuildReport from implementer ${childId}:\n\n${body}`,
    }
  }

  function timedOut(childId) {
    return {
      status: 'running',
      childId,
      stopReason: 'running',
      report: `implementer ${childId} is still running after ${settings.waitTimeoutMs}ms and has not reported yet.\n\nDo not poll it, do not sleep, and do not send status questions. If there is genuinely nothing else to decide, call implementer with {"subagentId":"${childId}","wait":true} once more; after that, report the in-flight state and the decision the user must make.`,
    }
  }

  function detached(childId) {
    return {
      status: 'detached',
      childId,
      stopReason: 'detached',
      report: `You stopped waiting for implementer ${childId}. The child keeps running; its report is cached and is returned the next time you call implementer with {"subagentId":"${childId}","wait":true}.`,
    }
  }

  function idle(childId) {
    return {
      status: 'idle',
      childId,
      stopReason: 'idle',
      report: `implementer ${childId} has no run in flight, so there is nothing to wait for. Its last report was already returned, or the child is idle. Pass a delta brief with \`subagentId\` and \`prompt\` to continue it, or omit \`subagentId\` to start a new child.`,
    }
  }

  async function settle(childId, waiting) {
    const outcome = await waiting.promise
    if (outcome.kind === 'settled') return completed(childId, outcome.result)
    if (outcome.kind === 'timeout') return timedOut(childId)
    return detached(childId)
  }

  const tool = {
    name: 'implementer',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of a new delegated task, for display. Omit or keep the previous label when continuing a child.',
        },
        prompt: {
          type: 'string',
          description: 'A complete BuildBrief when starting a child, or a delta brief when continuing one. The implementer does not see this conversation, so the starting brief must be self-contained.',
        },
        subagentId: {
          type: 'string',
          description: 'Continue the child returned by an earlier call instead of starting a new one. Keep the child for delta fixes; it retains its code context.',
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the next settlement of `subagentId` without sending a message. Use only after a `status: running` result. When `prompt` is also given, the prompt wins and the call continues the child and blocks.',
        },
        cwd: {
          type: 'string',
          description: 'Initial child working directory for a new child. Relative paths use your current directory; omitted inherits it.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['completed', 'running', 'detached', 'idle'],
          },
          childId: {
            type: 'string',
          },
          stopReason: {
            type: 'string',
          },
          report: {
            type: 'string',
          },
        },
        required: ['status', 'childId', 'stopReason', 'report'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.report,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('implementer requires a calling agent')
      }
      if (args.wait !== undefined && typeof args.wait !== 'boolean') {
        throw new Error('implementer: `wait` must be a boolean')
      }
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      const childId = typeof args.subagentId === 'string' && args.subagentId.length > 0
        ? args.subagentId
        : undefined
      const wantsWait = args.wait === true

      if (childId === undefined && wantsWait) {
        throw new Error('implementer: `wait: true` requires the `subagentId` of a child that is already running')
      }
      if (childId === undefined && prompt.length === 0) {
        throw new Error('implementer requires `prompt` with a complete BuildBrief when starting a new child')
      }
      if (childId !== undefined && prompt.length === 0 && !wantsWait) {
        throw new Error('implementer requires `prompt` with a delta brief when continuing a child; use `wait: true` to only wait')
      }

      const signal = fuseSignals(exec.signal, lifetime.signal)

      if (childId === undefined) {
        const started = await ctx.subagents.startActivation({
          provider: settings.subagentProvider,
          label: typeof args.description === 'string' && args.description.length > 0 ? args.description : labelOf(prompt),
          request: {
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            prompt: [{
              type: 'text',
              text: prompt,
            }],
            parent,
            agentPreset: settings.agentPreset,
            agentOptions: {
              provider: settings.provider,
              model: settings.model,
              ...(settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort }),
            },
            maxDepth: settings.maxDepth,
          },
          signal,
          delivery: 'caller',
        })
        // The settlement event carries the outcome; this only keeps a rare
        // teardown rejection from becoming an unhandled promise rejection.
        started.result.catch(() => {})
        settlements.markLive(started.childId)
        return await settle(started.childId, settlements.beginWait(started.childId, signal, settings.waitTimeoutMs))
      }

      if (wantsWait && prompt.length === 0) {
        if (!settlements.isLive(childId)) {
          const cached = settlements.take(childId)
          if (cached !== undefined) return completed(childId, cached)
          return idle(childId)
        }
        return await settle(childId, settlements.beginWait(childId, signal, settings.waitTimeoutMs))
      }

      const wasLive = settlements.isLive(childId)
      const waiting = settlements.beginWait(childId, signal, settings.waitTimeoutMs)
      settlements.markLive(childId)
      try {
        await ctx.subagents.sendMessage(parent, childId, [{
          type: 'text',
          text: prompt,
        }], { signal })
      } catch (error) {
        waiting.cancel()
        if (!wasLive) settlements.unmarkLive(childId)
        throw error
      }
      return await settle(childId, waiting)
    },
  }

  ctx.effect(() => ctx.tools.register(tool))

  ctx.effect(() => {
    const off = ctx.on('subagent/end', (info) => settlements.record(info))
    return () => {
      off()
      lifetime.abort(new Error('architect-executor plugin disposed'))
    }
  }, 'architect-executor: cache implementer settlements')

  ctx.effect(() => {
    const active = new Set()
    const budget = new Map()

    function track(operation) {
      const tracked = operation.finally(() => active.delete(tracked))
      active.add(tracked)
      return tracked
    }

    async function recover(payload, next) {
      const failure = payload?.failure
      if (!settings.retry.enabled) return next()
      if (typeof failure?.code !== 'string' || !settings.retry.codes.includes(failure.code)) return next()
      const signal = payload.signal
      if (signal?.aborted || lifetime.signal.aborted) return next()

      const agentId = payload.agent?.id ?? payload.agent?.session?.id ?? 'unknown'
      const key = `${agentId}:${payload.turn}:${payload.step}`
      const used = budget.get(key) ?? 0
      if (used >= settings.retry.maxRetries) {
        budget.delete(key)
        ctx.logger.warn(`architect-executor: retry budget exhausted for ${failure.code} on agent ${agentId} after ${used} retries (turn ${payload.turn} step ${payload.step})`)
        return next()
      }

      if (budget.size >= RETRY_BUDGET_LIMIT && !budget.has(key)) budget.clear()
      const attempt = used + 1
      budget.set(key, attempt)
      ctx.logger.warn(`architect-executor: retrying ${failure.code} for provider "${payload.provider}" on agent ${agentId} (attempt ${attempt}/${settings.retry.maxRetries}, turn ${payload.turn} step ${payload.step}) in ${settings.retry.delayMs}ms`)

      const fused = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
      if (!await cancellableDelay(settings.retry.delayMs, fused)) return undefined
      if (fused.aborted) return undefined
      return { kind: 'retry' }
    }

    const disposeListener = ctx.on('agent/request-error', (payload, next) => {
      return track(recover(payload, next))
    })

    return async () => {
      disposeListener()
      lifetime.abort(new Error('architect-executor plugin disposed'))
      await Promise.allSettled([...active])
    }
  }, 'architect-executor: abort and drain automatic retry waits')
}
