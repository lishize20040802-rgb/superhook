import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as teammates from '../src/teammates.ts'
import { boot } from './support.ts'

async function idle(latest: () => Agent, turns: number) {
  for (
    let i = 0;
    i < 500 &&
    latest()
      .session.ownEvents()
      .filter((event) => event.type === 'turn/end').length < turns;
    i++
  )
    await delay(10)
  await latest().whenIdle()
  return latest()
}
function text(agent: Agent) {
  return JSON.stringify(
    agent.session.snapshotEvents().filter((event) => event.type === 'assistant/message'),
  )
}

for (const protocol of ['acp', 'codex'] as const) {
  test(`native ${protocol} is an official teammate with memory, board ownership and messages`, async (t) => {
    const { ctx, owner, call } = await boot(t, true)
    // Desktop presets render identity variables before the request-routing hook runs.
    ctx.systemPrompt.section({
      name: 'test:native-identity',
      order: 0,
      text: 'You are powered by {{provider}} / {{model}}.',
    })
    let latestAgent: Agent
    ctx.on('agent/created', ({ agent }) => {
      if (agent.id !== owner.agent.id) latestAgent = agent
      return undefined
    })
    await ctx.plugin((await import('@deepseek-ai/dsh-subprocess-local')).default)
    const config: teammates.Config = {
      stateDirectory: join(owner.agent.session.header.cwd!, 'native-state'),
      providers: [
        {
          name: protocol,
          protocol,
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/native-agent.mjs', import.meta.url)), protocol],
        },
      ],
    }
    const plugin = await ctx.plugin(teammates, config)
    const spawned = await call('superhook_spawn_teammate', {
      provider: protocol,
      name: 'engineer',
      description: 'Native engineer',
      prompt: 'REMEMBER_SAFFRON DO_BOARD_WORK',
    })
    assert.equal(spawned.isError, false, JSON.stringify(spawned))
    const member = ctx.agentTeams
      .listMembers(owner.agent)
      .find((member) => member.name === 'engineer')!
    let agent = await idle(() => latestAgent, 1)
    assert.equal(member.role, 'teammate')
    assert.match(text(agent), /ROUND_1 MEMORY_saffron completed:engineer/)
    const tasks = ctx.agentTeams.listTasks(owner.agent)
    assert.equal(tasks[0]?.ownerName, 'engineer')
    assert.equal(tasks[0]?.status, 'completed')
    assert.match(JSON.stringify(owner.agent.session.snapshotEvents()), /NATIVE_REPORT/)
    await delay(50)
    await ctx.agentTeams.sendMessage(owner.agent, {
      target: 'engineer',
      content: [{ type: 'text', text: 'RECALL' }],
      signal: new AbortController().signal,
    })
    agent = await idle(() => latestAgent, 2)
    assert.match(
      text(agent),
      /ROUND_2 MEMORY_saffron/,
      JSON.stringify({
        child: agent.session.snapshotEvents().slice(-10),
        parent: owner.agent.session.snapshotEvents().slice(-8),
        members: ctx.agentTeams.listMembers(owner.agent),
      }),
    )
    await ctx.agentTeams.sendMessage(owner.agent, {
      target: 'engineer',
      content: [{ type: 'text', text: 'WAIT_FOREVER' }],
      signal: new AbortController().signal,
    })
    for (
      let i = 0;
      i < 100 &&
      latestAgent!.session.ownEvents().filter((event) => event.type === 'turn/start').length < 3;
      i++
    )
      await delay(10)
    await delay(50)
    ctx.agentTeams.interrupt(owner.agent, 'engineer')
    await idle(() => latestAgent, 3)
    await ctx.agentTeams.sendMessage(owner.agent, {
      target: 'engineer',
      content: [{ type: 'text', text: 'RECALL_AGAIN' }],
      signal: new AbortController().signal,
    })
    agent = await idle(() => latestAgent, 4)
    assert.match(
      text(agent),
      /ROUND_4 MEMORY_saffron/,
      JSON.stringify(agent.session.snapshotEvents().slice(-12)),
    )
    // Natural idle deactivates the official Agent; unloading also closes native processes.
    for (let i = 0; i < 100 && ctx.agents.get(member.id); i++) await delay(10)
    await plugin.dispose()
    await ctx.plugin(teammates, config)
    await ctx.agentTeams.sendMessage(owner.agent, {
      target: 'engineer',
      content: [{ type: 'text', text: 'RECALL_AFTER_RESTART' }],
      signal: new AbortController().signal,
    })
    agent = await idle(() => latestAgent, 5)
    assert.match(text(agent), /ROUND_5 MEMORY_saffron/)
  })
}
