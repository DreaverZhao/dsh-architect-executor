import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { name, apply, resolveSettings } from '../index.js'

const BASE = { provider: 'p', model: 'm' }

function createCtx() {
  const effects = []
  const listeners = new Map()
  const tools = []
  const sections = []
  const logs = []
  const activations = []
  const ctx = {
    effect(fn) {
      effects.push(fn())
      return { dispose() {} }
    },
    on(event, listener) {
      const entry = { listener }
      const list = listeners.get(event) ?? []
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
      async startActivation(...args) {
        activations.push(args)
        return { childId: 'child-1' }
      },
    },
  }
  return { ctx, effects, listeners, tools, sections, logs, activations }
}

function getListener(listeners) {
  const list = listeners.get('agent/request-error') ?? []
  assert.equal(list.length, 1, 'expected one agent/request-error listener')
  return list[0].listener
}

function failurePayload(code, overrides = {}) {
  const controller = new AbortController()
  return {
    controller,
    payload: {
      agent: { id: 'agent-default' },
      turn: 1,
      step: 1,
      provider: 'test-provider',
      failure: { code, message: 'upstream request failed' },
      retryPolicy: undefined,
      signal: controller.signal,
      ...overrides,
    },
  }
}

test('AC1: registers exactly one implementer tool and the protocol section', () => {
  assert.equal(name, 'architect-executor')
  const { ctx, tools, sections, listeners } = createCtx()
  apply(ctx, BASE)
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'implementer')
  assert.equal(typeof tools[0].execute, 'function')
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'architect-executor:protocol')
  assert.equal((listeners.get('agent/request-error') ?? []).length, 1)
})

test('AC2: resolveSettings supplies retry defaults and respects overrides', () => {
  const settings = resolveSettings({ provider: 'p', model: 'm' })
  assert.deepEqual(settings.retry, {
    enabled: true,
    maxRetries: 10,
    delayMs: 30000,
    codes: ['PI_AI_ERROR'],
  })
  assert.equal(settings.provider, 'p')
  assert.equal(settings.agentPreset, 'implementer')

  const partial = resolveSettings({ ...BASE, retry: { maxRetries: 3 } })
  assert.deepEqual(partial.retry, {
    enabled: true,
    maxRetries: 3,
    delayMs: 30000,
    codes: ['PI_AI_ERROR'],
  })

  const overridden = resolveSettings({
    ...BASE,
    retry: { enabled: false, maxRetries: 2, delayMs: 5, codes: ['PI_AI_ERROR', 'RATE_LIMIT'] },
  })
  assert.deepEqual(overridden.retry, {
    enabled: false,
    maxRetries: 2,
    delayMs: 5,
    codes: ['PI_AI_ERROR', 'RATE_LIMIT'],
  })
})

test('AC3: retries up to the same turn/step budget then delegates', async () => {
  const { ctx, listeners } = createCtx()
  apply(ctx, { ...BASE, retry: { maxRetries: 2, delayMs: 5 } })
  const listener = getListener(listeners)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(undefined)
  }
  const { payload } = failurePayload('PI_AI_ERROR')

  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  assert.equal(nextCalls, 0)
  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  assert.equal(nextCalls, 0)
  assert.equal(await listener(payload, next), undefined)
  assert.equal(nextCalls, 1)
})

test('AC4: applies the configured fixed delay, not exponential backoff', async () => {
  const { ctx, listeners } = createCtx()
  const delayMs = 40
  apply(ctx, { ...BASE, retry: { maxRetries: 3, delayMs } })
  const listener = getListener(listeners)
  const next = () => Promise.resolve(undefined)
  const { payload } = failurePayload('PI_AI_ERROR')

  let started = performance.now()
  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  const firstElapsed = performance.now() - started
  assert.ok(firstElapsed >= delayMs - 5, `first retry resolved early: ${firstElapsed}ms`)

  started = performance.now()
  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  const secondElapsed = performance.now() - started
  assert.ok(secondElapsed >= delayMs - 5, `second retry resolved early: ${secondElapsed}ms`)
  assert.ok(secondElapsed < delayMs * 1.75, `retry delay looks exponential: ${secondElapsed}ms`)
})

test('AC5: non-target codes delegate immediately without consuming the budget', async () => {
  const { ctx, listeners } = createCtx()
  apply(ctx, { ...BASE, retry: { maxRetries: 1, delayMs: 5 } })
  const listener = getListener(listeners)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(undefined)
  }

  const { payload: authPayload } = failurePayload('AUTH')
  const started = performance.now()
  assert.equal(await listener(authPayload, next), undefined)
  assert.equal(nextCalls, 1)
  assert.ok(performance.now() - started < 20, 'AUTH should delegate immediately')

  const { payload } = failurePayload('PI_AI_ERROR')
  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  assert.equal(nextCalls, 1)
  assert.equal(await listener(payload, next), undefined)
  assert.equal(nextCalls, 2)
})

test('AC6: payload abort during the wait and plugin disposal cancel recovery', async () => {
  const first = createCtx()
  apply(first.ctx, { ...BASE, retry: { maxRetries: 5, delayMs: 60 } })
  const listener = getListener(first.listeners)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(undefined)
  }
  const { payload, controller } = failurePayload('PI_AI_ERROR')
  const pending = listener(payload, next)
  setTimeout(() => controller.abort(), 10)
  assert.equal(await pending, undefined)
  assert.equal(nextCalls, 0)

  const second = createCtx()
  apply(second.ctx, { ...BASE, retry: { maxRetries: 5, delayMs: 100 } })
  const disposingListener = getListener(second.listeners)
  const { payload: disposingPayload } = failurePayload('PI_AI_ERROR')
  let disposingNextCalls = 0
  const pendingDispose = disposingListener(disposingPayload, () => {
    disposingNextCalls += 1
    return Promise.resolve(undefined)
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal((second.listeners.get('agent/request-error') ?? []).length, 1)

  const retryDisposer = second.effects.at(-1)
  await retryDisposer()
  assert.equal((second.listeners.get('agent/request-error') ?? []).length, 0)
  assert.equal(await pendingDispose, undefined)
  assert.equal(disposingNextCalls, 0)
})

test('AC7: retries never append session history, send messages, or start a subagent', async () => {
  const { ctx, listeners, activations } = createCtx()
  apply(ctx, { ...BASE, retry: { maxRetries: 2, delayMs: 5 } })
  const listener = getListener(listeners)
  const session = {
    append() {
      throw new Error('must not append')
    },
  }
  const { payload } = failurePayload('PI_AI_ERROR', { agent: { id: 'agent-ac7', session } })
  const next = () => Promise.resolve(undefined)

  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  assert.deepEqual(await listener(payload, next), { kind: 'retry' })
  assert.equal(activations.length, 0)

  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /session\.append\s*\(/)
  assert.doesNotMatch(source, /send_message\s*\(/)
})

test('AC8: invalid retry config is rejected with a field-naming error', () => {
  const cases = [
    [{ maxRetries: -1 }, /retry\.maxRetries/],
    [{ delayMs: -1 }, /retry\.delayMs/],
    [{ codes: [] }, /retry\.codes/],
    [{ codes: [123] }, /retry\.codes/],
  ]
  for (const [retry, pattern] of cases) {
    assert.throws(() => resolveSettings({ ...BASE, retry }), pattern)
    const { ctx } = createCtx()
    assert.throws(() => apply(ctx, { ...BASE, retry }), pattern)
  }
})

test('AC10: retry budgets are per agent and reset per turn/step', async () => {
  const { ctx, listeners, logs } = createCtx()
  apply(ctx, { ...BASE, retry: { maxRetries: 1, delayMs: 5 } })
  const listener = getListener(listeners)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve(undefined)
  }
  const payloadFor = (id, turn = 1, step = 1) =>
    failurePayload('PI_AI_ERROR', { agent: { id }, turn, step }).payload

  assert.deepEqual(await listener(payloadFor('agent-a'), next), { kind: 'retry' })
  assert.equal(await listener(payloadFor('agent-a'), next), undefined)
  assert.equal(nextCalls, 1)

  assert.deepEqual(await listener(payloadFor('agent-b'), next), { kind: 'retry' })
  assert.equal(nextCalls, 1, 'agent-b must not consume agent-a budget')
  assert.equal(await listener(payloadFor('agent-b'), next), undefined)
  assert.equal(nextCalls, 2)

  assert.deepEqual(await listener(payloadFor('agent-a', 2, 1), next), { kind: 'retry' })
  assert.equal(await listener(payloadFor('agent-a', 2, 1), next), undefined)
  assert.equal(nextCalls, 3)

  assert.deepEqual(await listener(payloadFor('agent-b', 1, 2), next), { kind: 'retry' })
  assert.equal(await listener(payloadFor('agent-b', 1, 2), next), undefined)
  assert.equal(nextCalls, 4)

  assert.ok(logs.some(([, message]) => message.includes('agent agent-a')))
  assert.ok(logs.some(([, message]) => message.includes('agent agent-b')))
})
