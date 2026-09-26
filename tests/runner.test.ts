import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { orderPlan } from '../src/plan.ts'
import { runTeam } from '../src/runner.ts'
import type { StartTask } from '../src/runner.ts'
import type { Limits, Task } from '../src/types.ts'

const limits: Limits = {
  providers: ['codex'],
  maxTasks: 8,
  taskTimeoutMs: 1000,
  maxPlanBytes: 65536,
  maxResultBytes: 32768,
}
const task = (id: string, dependsOn: string[] = []): Task => ({
  id,
  dependsOn,
  provider: 'codex',
  prompt: `Do ${id}`,
})
const fail = (error: unknown) => {
  throw error
}

test('validates unknown ids, cycles, duplicates and allowlist before starting', () => {
  for (const tasks of [
    [task('a', ['missing'])],
    [task('a', ['b']), task('b', ['a'])],
    [task('a'), task('a')],
    [{ ...task('a'), provider: 'other' }],
    [],
  ]) {
    assert.throws(() => orderPlan(tasks, limits))
  }
  assert.deepEqual(
    orderPlan([task('b', ['a']), task('a')], limits).map((t) => t.id),
    ['a', 'b'],
  )
})

test('disposes a task before its successor and passes only declared dependency answers', async () => {
  const events: string[] = []
  const start: StartTask = async (t, prompt) => {
    events.push(t.id)
    if (t.id === 'b') assert.match(prompt, /answer-a/)
    if (t.id === 'c') assert.doesNotMatch(prompt, /answer-a/)
    return {
      id: SessionId(t.id),
      localAgent: undefined,
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: `answer-${t.id}` }],
      }),
      dispose: async () => {
        await delay(1)
        events.push(`dispose-${t.id}`)
      },
    }
  }
  const result = await runTeam(
    [task('a'), task('b', ['a']), task('c')],
    limits,
    start,
    new AbortController().signal,
    fail,
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(events, ['a', 'dispose-a', 'b', 'dispose-b', 'c', 'dispose-c'])
})

test('failed dependencies skip descendants but independent work continues', async () => {
  const start: StartTask = async (t) => ({
    id: SessionId(t.id),
    localAgent: undefined,
    result: Promise.resolve({
      stopReason: t.id === 'a' ? 'error' : 'completed',
      output: [{ type: 'text', text: 'partial' }],
    }),
    dispose: async () => {},
  })
  const result = await runTeam(
    [task('a'), task('b', ['a']), task('c')],
    limits,
    start,
    new AbortController().signal,
    fail,
  )
  assert.deepEqual(
    result.tasks.map((t) => t.status),
    ['failed', 'skipped', 'completed'],
  )
  assert.equal(result.tasks[0]?.output, 'partial')
})

test('an empty successful protocol turn fails and blocks dependent tasks', async () => {
  let disposed = false
  const start: StartTask = async (t) => ({
    id: SessionId(t.id),
    localAgent: undefined,
    result: Promise.resolve({ stopReason: 'completed', output: [] }),
    dispose: async () => {
      disposed = true
    },
  })
  const result = await runTeam(
    [task('a'), task('b', ['a'])],
    limits,
    start,
    new AbortController().signal,
    fail,
  )
  assert.equal(result.status, 'failed')
  assert.equal(disposed, true)
  assert.match(result.tasks[0]?.detail ?? '', /no textual result/)
  assert.equal(result.tasks[1]?.status, 'skipped')
})

test('deadline cancels the provider and waits for cleanup before continuing', async () => {
  let disposed = false
  const start: StartTask = async (t, _prompt, signal) => ({
    id: SessionId(t.id),
    localAgent: undefined,
    result: new Promise((resolve) =>
      signal.addEventListener('abort', () => resolve({ stopReason: 'aborted', output: [] }), {
        once: true,
      }),
    ),
    dispose: async () => {
      await delay(5)
      disposed = true
    },
  })
  const result = await runTeam(
    [task('a')],
    { ...limits, taskTimeoutMs: 5 },
    start,
    new AbortController().signal,
    fail,
  )
  assert.equal(disposed, true)
  assert.equal(result.status, 'failed')
  assert.equal(result.tasks[0]?.detail, 'Task deadline exceeded')
})

test('cleanup failure stops independent work and is not hidden by cancellation', async () => {
  const errors: unknown[] = []
  const start: StartTask = async (t) => ({
    id: SessionId(t.id),
    localAgent: undefined,
    result: Promise.resolve({ stopReason: 'completed', output: [] }),
    dispose: async () => {
      throw new Error('cleanup failed')
    },
  })
  const result = await runTeam(
    [task('a'), task('b')],
    limits,
    start,
    new AbortController().signal,
    (e) => errors.push(e),
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.tasks[0]?.cleanupFailed, true)
  assert.equal(result.tasks[1]?.status, 'skipped')
  assert.equal(errors.length, 1)
})

test('bounds the entire JSON report including Unicode and JSON escaping', async () => {
  const start: StartTask = async (t) => ({
    id: SessionId(t.id),
    localAgent: undefined,
    result: Promise.resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: '\u0000"😀中文'.repeat(20000) }],
    }),
    dispose: async () => {},
  })
  const result = await runTeam(
    [task('a'), task('b')],
    limits,
    start,
    new AbortController().signal,
    fail,
  )
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= limits.maxResultBytes)
  assert.ok(result.tasks.every((t) => t.outputTruncated))
  assert.ok(result.tasks.every((t) => t.output.isWellFormed()))
})
