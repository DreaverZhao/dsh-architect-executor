import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, resolveSettings } from '../index.js'

const BASE = { provider: 'p', model: 'm' }

const tick = () => new Promise((resolve) => setImmediate(resolve))

function createCtx() {
  const listeners = new Map()
  const tools = []
  const sections = []
  const logs = []
  const activations = []
  const messages = []
  let seq = 0

  const ctx = {
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return { dispose() {} }
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      const entry = { listener }
      list.push(entry)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(entry)
        if (index >= 0) list.splice(index, 1)
      }
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    subagents: {
      async startActivation(spec) {
        const childId = `child-${++seq}`
        let resolve
        const result = new Promise((settle) => {
          resolve = settle
        })
        const entry = {
          childId,
          spec,
          result,
          resolve,
          disposed: 0,
          dispose: async () => {
            entry.disposed += 1
          },
        }
        activations.push(entry)
        return { childId, result, dispose: entry.dispose }
      },
      async sendMessage(...args) {
        messages.push(args)
        await Promise.resolve()
        return 'message-1'
      },
    },
  }

  const disposers = []
  return { ctx, listeners, tools, sections, logs, activations, messages, disposers }
}

function emitEnd(listeners, overrides = {}) {
  const info = {
    runId: 'run-1',
    provider: 'spawn',
    id: 'child-1',
    local: true,
    stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'Status: done' }],
    ...overrides,
  }
  for (const entry of listeners.get('subagent/end') ?? []) entry.listener(info)
}

function execute(tool, args, signal = new AbortController().signal) {
  return tool.execute(args, { agent: { id: 'architect-1' }, signal })
}

test('AC1: a new task blocks until the settlement and returns the report', async () => {
  const { ctx, tools, activations, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  let settled = false
  const pending = execute(tool, { description: 'blocking', prompt: 'BuildBrief' })
  pending.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  await tick()

  assert.equal(activations.length, 1)
  assert.equal(activations[0].spec.delivery, 'caller', 'caller delivery suppresses the settlement message')
  assert.equal(activations[0].spec.provider, 'spawn')
  assert.equal(activations[0].spec.request.agentPreset, 'implementer')
  assert.equal(activations[0].spec.request.agentOptions.provider, 'p')
  assert.equal(settled, false, 'the tool must not return an activation receipt')

  emitEnd(listeners)
  const value = await pending
  assert.equal(value.status, 'completed')
  assert.equal(value.childId, 'child-1')
  assert.equal(value.stopReason, 'completed')
  assert.match(value.report, /BuildReport from implementer child-1/)
  assert.match(value.report, /Status: done/)
  assert.equal(tool.output.render({}, value)[0].text, value.report)
})

test('AC2: a child that settles before the wait is returned, never hanging', async () => {
  const { ctx, tools, listeners } = createCtx()
  apply(ctx, BASE)
  const start = ctx.subagents.startActivation
  ctx.subagents.startActivation = async (spec) => {
    const activation = await start(spec)
    emitEnd(listeners, { id: activation.childId, lastAssistantMessage: [{ type: 'text', text: 'early report' }] })
    return activation
  }
  const tool = tools[0]

  const value = await execute(tool, { prompt: 'BuildBrief' })
  assert.equal(value.status, 'completed')
  assert.match(value.report, /early report/)
})

test('AC3: the wait limit returns status running without disposing the child', async () => {
  const { ctx, tools, activations, listeners } = createCtx()
  apply(ctx, { ...BASE, waitTimeoutMs: 30 })
  const tool = tools[0]

  const value = await execute(tool, { prompt: 'BuildBrief' })
  assert.equal(value.status, 'running')
  assert.equal(value.childId, 'child-1')
  assert.match(value.report, /still running after 30ms/)
  assert.match(value.report, /"subagentId":"child-1","wait":true/)
  assert.equal(activations[0].disposed, 0, 'a wait limit must not cancel the implementer')

  emitEnd(listeners, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'late report' }] })
  const waited = await execute(tool, { subagentId: 'child-1', wait: true })
  assert.equal(waited.status, 'completed')
  assert.match(waited.report, /late report/)
})

test('AC4: continuing a child sends the delta brief then blocks for the next settlement', async () => {
  const { ctx, tools, activations, messages, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  const first = execute(tool, { prompt: 'BuildBrief' })
  await tick()
  emitEnd(listeners, { id: 'child-1' })
  await first

  let settled = false
  const second = execute(tool, { subagentId: 'child-1', prompt: 'fix AC2' })
  second.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  await tick()

  assert.equal(activations.length, 1, 'continuing must not start another child')
  assert.equal(messages.length, 1)
  assert.equal(messages[0][0].id, 'architect-1', 'the live architect authors the message')
  assert.equal(messages[0][1], 'child-1')
  assert.match(messages[0][2][0].text, /fix AC2/)
  assert.equal(settled, false, 'a continuation must block too')

  emitEnd(listeners, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'fixed' }] })
  const value = await second
  assert.equal(value.status, 'completed')
  assert.match(value.report, /fixed/)
})

test('AC5: a settlement raised during sendMessage is not lost', async () => {
  const { ctx, tools, messages, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  const first = execute(tool, { prompt: 'BuildBrief' })
  await tick()
  emitEnd(listeners, { id: 'child-1' })
  await first

  ctx.subagents.sendMessage = async (...args) => {
    messages.push(args)
    emitEnd(listeners, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'instant' }] })
    return 'message-2'
  }

  const value = await execute(tool, { subagentId: 'child-1', prompt: 'delta' })
  assert.equal(value.status, 'completed')
  assert.match(value.report, /instant/)
})

test('AC6: aborting the wait detaches the child and a later wait returns its report', async () => {
  const { ctx, tools, activations, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]
  const controller = new AbortController()

  const pending = execute(tool, { prompt: 'BuildBrief' }, controller.signal)
  await tick()
  controller.abort()

  const value = await pending
  assert.equal(value.status, 'detached')
  assert.equal(value.childId, 'child-1')
  assert.equal(activations[0].disposed, 0, 'detaching must not cancel the implementer')

  emitEnd(listeners, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'detached report' }] })
  const waited = await execute(tool, { subagentId: 'child-1', wait: true })
  assert.equal(waited.status, 'completed')
  assert.match(waited.report, /detached report/)
})

test('AC7: a non-completed child is an error carrying the partial report', async () => {
  const { ctx, tools, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  const pending = execute(tool, { prompt: 'BuildBrief' })
  await tick()
  emitEnd(listeners, {
    id: 'child-1',
    stopReason: 'error',
    lastAssistantMessage: [{ type: 'text', text: 'half done' }],
  })

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /stopReason "error"/)
    assert.match(error.message, /half done/)
    return true
  })
})

test('AC8: a completed child without a report is an error, not a pass', async () => {
  const { ctx, tools, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  const pending = execute(tool, { prompt: 'BuildBrief' })
  await tick()
  emitEnd(listeners, { id: 'child-1', lastAssistantMessage: [] })

  await assert.rejects(pending, /finished without a report/)
})

test('AC9: argument validation rejects ambiguous modes before any side effect', async () => {
  const { ctx, tools, activations, messages } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  await assert.rejects(execute(tool, {}), /requires `prompt`/)
  await assert.rejects(execute(tool, { wait: true }), /requires the `subagentId`/)
  await assert.rejects(execute(tool, { subagentId: 'child-1' }), /requires `prompt` with a delta brief/)
  await assert.rejects(execute(tool, { prompt: 'brief', wait: 'yes' }), /`wait` must be a boolean/)
  assert.equal(activations.length, 0)
  assert.equal(messages.length, 0)
})

test('AC9b: a prompt with wait continues the child instead of dropping the brief', async () => {
  const { ctx, tools, messages, listeners } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  const first = execute(tool, { prompt: 'BuildBrief' })
  await tick()
  emitEnd(listeners, { id: 'child-1' })
  await first

  let settled = false
  const second = execute(tool, { subagentId: 'child-1', prompt: 'delta', wait: true })
  second.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  await tick()

  assert.equal(messages.length, 1)
  assert.match(messages[0][2][0].text, /delta/)
  assert.equal(settled, false, 'the prompt wins and the call still blocks')

  emitEnd(listeners, { id: 'child-1', lastAssistantMessage: [{ type: 'text', text: 'continued' }] })
  const value = await second
  assert.equal(value.status, 'completed')
  assert.match(value.report, /continued/)
})

test('AC9c: waiting on a child with no run in flight returns idle at once', async () => {
  const { ctx, tools, activations } = createCtx()
  apply(ctx, { ...BASE, waitTimeoutMs: 300 })
  const tool = tools[0]

  const started = performance.now()
  const value = await execute(tool, { subagentId: 'child-unknown', wait: true })
  const elapsed = performance.now() - started

  assert.equal(value.status, 'idle', 'a stale wait must not block until the wait limit')
  assert.ok(elapsed < 200, `stale wait took ${elapsed}ms`)
  assert.match(value.report, /no run in flight/)
  assert.equal(activations.length, 0)
})

test('AC10: configuration validates the wait limit and keeps the retry defaults', () => {
  const settings = resolveSettings(BASE)
  assert.equal(settings.waitTimeoutMs, 15 * 60 * 1000)
  assert.deepEqual(settings.retry, {
    enabled: true,
    maxRetries: 10,
    delayMs: 30000,
    codes: ['PI_AI_ERROR'],
  })
  assert.equal(resolveSettings({ ...BASE, waitTimeoutMs: 0 }).waitTimeoutMs, 0)
  assert.throws(() => resolveSettings({ ...BASE, waitTimeoutMs: -1 }), /waitTimeoutMs/)
  assert.throws(() => resolveSettings({ ...BASE, waitTimeoutMs: 1.5 }), /waitTimeoutMs/)
})

test('AC11: disposal cancels a pending wait instead of leaving it hanging', async () => {
  const { ctx, tools, disposers } = createCtx()
  apply(ctx, BASE)
  const tool = tools[0]

  const pending = execute(tool, { prompt: 'BuildBrief' })
  await tick()
  for (const dispose of disposers) await dispose()

  const value = await pending
  assert.equal(value.status, 'detached')
})
