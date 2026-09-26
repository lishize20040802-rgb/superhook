import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assignment, boot } from './support.ts'

test('background report is collected using the official job_output tool', async (t) => {
  const { ctx, owner, provider, call } = await boot(t)
  let disposed = false
  provider(async () => ({
    id: SessionId(randomUUID()),
    localAgent: undefined,
    result: Promise.resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'Reviewed' }],
    }),
    dispose: async () => {
      disposed = true
    },
  }))
  const result = await call('superhook_run', { tasks: [assignment], run_in_background: true })
  assert.equal(result.isError, false, JSON.stringify(result))
  const job = ctx.jobs.list(owner.agent.id)[0]
  assert.ok(job)
  const collected = await call('job_output', { job_id: job.id, wait: true, timeout_ms: 1000 })
  assert.equal(collected.isError, false, JSON.stringify(collected))
  assert.match(JSON.stringify(collected), /Reviewed/)
  assert.equal(ctx.jobs.get(job.id, owner.agent.id).status, 'completed')
  assert.equal(disposed, true)
})

test('official job_kill cancels the child and waits for its cleanup', async (t) => {
  const { ctx, owner, provider, call } = await boot(t)
  const started = Promise.withResolvers<void>()
  let disposed = false
  provider(async (request) => ({
    id: SessionId(randomUUID()),
    localAgent: undefined,
    result: new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => resolve({ stopReason: 'aborted', output: [] }),
        { once: true },
      )
      started.resolve()
    }),
    dispose: async () => {
      disposed = true
    },
  }))
  await call('superhook_run', { tasks: [assignment], run_in_background: true })
  await started.promise
  const job = ctx.jobs.list(owner.agent.id)[0]
  assert.ok(job)
  const killed = await call('job_kill', { job_id: job.id })
  assert.equal(killed.isError, false, JSON.stringify(killed))
  await ctx.jobs.wait(job.id, 1000, owner.agent.id)
  assert.equal(ctx.jobs.get(job.id, owner.agent.id).status, 'killed')
  assert.equal(disposed, true)
})

test('background lifetime survives cancellation of the launching tool call', async (t) => {
  const { ctx, owner, provider, call } = await boot(t)
  const finish = Promise.withResolvers<void>()
  let childAborted = false
  provider(async (request) => {
    request.signal.addEventListener(
      'abort',
      () => {
        childAborted = true
      },
      { once: true },
    )
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      result: finish.promise.then(() => ({
        stopReason: 'completed' as const,
        output: [{ type: 'text' as const, text: 'Done' }],
      })),
      dispose: async () => {},
    }
  })
  const launcher = new AbortController()
  await call('superhook_run', { tasks: [assignment], run_in_background: true }, launcher.signal)
  launcher.abort()
  finish.resolve()
  const job = ctx.jobs.list(owner.agent.id)[0]
  assert.ok(job)
  await ctx.jobs.wait(job.id, 1000, owner.agent.id)
  assert.equal(childAborted, false)
  assert.equal(ctx.jobs.get(job.id, owner.agent.id).status, 'completed')
})

test('workspace exclusion rejects overlapping teams before a second child starts', async (t) => {
  const { provider, call } = await boot(t)
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let starts = 0
  provider(async () => {
    starts++
    started.resolve()
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      result: finish.promise.then(() => ({
        stopReason: 'completed' as const,
        output: [{ type: 'text' as const, text: 'Done' }],
      })),
      dispose: async () => {},
    }
  })
  const first = call('superhook_run', { tasks: [assignment] })
  await started.promise
  try {
    const second = await call('superhook_run', { tasks: [assignment] })
    assert.equal(second.isError, true)
    assert.match(JSON.stringify(second), /Another Superhook team/)
    assert.equal(starts, 1)
  } finally {
    finish.resolve()
    await first
  }
})

test('malformed plans and missing providers start no child through the registry', async (t) => {
  const { provider, call } = await boot(t)
  let starts = 0
  provider(async () => {
    starts++
    throw new Error('Must not start')
  })
  for (const tasks of [
    [{ ...assignment, dependsOn: ['missing'] }],
    [{ ...assignment, provider: 'grok' }],
    [{ ...assignment, prompt: 42 }],
  ]) {
    const result = await call('superhook_run', { tasks })
    assert.equal(result.isError, true)
  }
  assert.equal(starts, 0)
})

test('unloading the Superhook fiber drains its active child and removes its tools', async (t) => {
  const { ctx, provider, call } = await boot(t, false, true)
  const entry = await ctx.loader.create({ name: new URL('../src/index.ts', import.meta.url).href })
  await ctx.loader.await()
  const started = Promise.withResolvers<void>()
  let disposed = false
  provider(async (request) => ({
    id: SessionId(randomUUID()),
    localAgent: undefined,
    result: new Promise((resolve) => {
      request.signal.addEventListener(
        'abort',
        () => resolve({ stopReason: 'aborted', output: [] }),
        { once: true },
      )
      started.resolve()
    }),
    dispose: async () => {
      disposed = true
    },
  }))
  const execution = call('superhook_run', { tasks: [assignment] })
  await started.promise
  ctx.loader.remove(entry)
  await ctx.loader.await()
  await execution
  assert.equal(disposed, true)
  assert.equal(ctx.tools.get('superhook_run'), undefined)
  assert.equal(ctx.tools.get('superhook_agents'), undefined)
})

test('cleanup failure quarantines the workspace instead of admitting another team', async (t) => {
  const { provider, call } = await boot(t)
  let starts = 0
  provider(async () => {
    starts++
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      result: Promise.resolve({ stopReason: 'completed', output: [] }),
      dispose: async () => {
        throw new Error('Could not establish quiescence')
      },
    }
  })
  const first = await call('superhook_run', { tasks: [assignment] })
  assert.match(JSON.stringify(first), /cleanupFailed.*true/)
  const second = await call('superhook_run', { tasks: [assignment] })
  assert.equal(second.isError, true)
  assert.match(JSON.stringify(second), /earlier cleanup failed/)
  assert.equal(starts, 1)
})
