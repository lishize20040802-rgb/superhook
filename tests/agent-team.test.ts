import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { boot } from './support.ts'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

test('official task is claimed and completed with durable official revisions', async (t) => {
  const { ctx, owner, provider, call } = await boot(t, true)
  provider(async (request) => {
    assert.match(JSON.stringify(request.prompt), /Acceptance: identify missing tests/)
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'Found missing tests' }],
      }),
      dispose: async () => {},
    }
  })
  const task = await ctx.agentTeams.createTask(owner.agent, {
    subject: 'Review',
    description: 'Acceptance: identify missing tests',
    writeScopes: ['src'],
  })
  const result = await call('superhook_team_task', {
    task_id: task.id,
    expected_revision: task.revision,
    provider: 'codex',
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  const completed = ctx.agentTeams.getTask(owner.agent, task.id)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.revision, 3)
  assert.equal(ctx.agentTeams.listMembers(owner.agent).length, 1)
  assert.match(JSON.stringify(result), /Found missing tests/)
})

test('official blocked and stale tasks do not start an external child', async (t) => {
  const { ctx, owner, provider, call } = await boot(t, true)
  let starts = 0
  provider(async () => {
    starts++
    throw new Error('Must not start')
  })
  const first = await ctx.agentTeams.createTask(owner.agent, {
    subject: 'First',
    description: 'Do first',
  })
  const blocked = await ctx.agentTeams.createTask(owner.agent, {
    subject: 'Second',
    description: 'Do second',
    blockedBy: [first.id],
  })
  for (const [taskId, revision] of [
    [blocked.id, blocked.revision],
    [first.id, first.revision + 1],
  ] as const) {
    const result = await call('superhook_team_task', {
      task_id: taskId,
      expected_revision: revision,
      provider: 'codex',
    })
    assert.equal(result.isError, true)
  }
  assert.equal(starts, 0)
  assert.equal(ctx.agentTeams.getTask(owner.agent, first.id).status, 'pending')
})

test('failed external work retains official ownership for manual inspection', async (t) => {
  const { ctx, owner, provider, call } = await boot(t, true)
  provider(async () => ({
    id: SessionId(randomUUID()),
    localAgent: undefined,
    result: Promise.resolve({
      stopReason: 'error',
      output: [{ type: 'text', text: 'Partial changes' }],
    }),
    dispose: async () => {},
  }))
  const task = await ctx.agentTeams.createTask(owner.agent, {
    subject: 'Implement',
    description: 'Implement a feature',
  })
  const result = await call('superhook_team_task', {
    task_id: task.id,
    expected_revision: task.revision,
    provider: 'codex',
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(ctx.agentTeams.getTask(owner.agent, task.id).status, 'in_progress')
  assert.match(JSON.stringify(result), /Partial changes/)
})

test('team bridge cannot bypass policy on the nested Superhook tool', async (t) => {
  const { ctx, owner, provider, call } = await boot(t, true)
  let starts = 0
  provider(async () => {
    starts++
    throw new Error('Must not start')
  })
  ctx.tools.guard((execution) =>
    execution.name === 'superhook_run' ? 'Denied by test deployment' : undefined,
  )
  const task = await ctx.agentTeams.createTask(owner.agent, {
    subject: 'Review',
    description: 'Inspect source',
  })
  const result = await call('superhook_team_task', {
    task_id: task.id,
    expected_revision: task.revision,
    provider: 'codex',
  })
  assert.equal(result.isError, true)
  assert.equal(starts, 0)
  assert.equal(ctx.agentTeams.getTask(owner.agent, task.id).status, 'in_progress')
})

test('a concurrent official task edit prevents stale completion', async (t) => {
  const { ctx, owner, provider, call } = await boot(t, true)
  const task = await ctx.agentTeams.createTask(owner.agent, {
    subject: 'Review',
    description: 'Original scope',
  })
  provider(async () => {
    await ctx.agentTeams.updateTask(owner.agent, {
      taskId: task.id,
      expectedRevision: 2,
      action: 'edit',
      description: 'Changed scope',
    })
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'Done' }],
      }),
      dispose: async () => {},
    }
  })
  const result = await call('superhook_team_task', {
    task_id: task.id,
    expected_revision: 1,
    provider: 'codex',
  })
  assert.equal(result.isError, true)
  const current = ctx.agentTeams.getTask(owner.agent, task.id)
  assert.equal(current.status, 'in_progress')
  assert.equal(current.description, 'Changed scope')
})
