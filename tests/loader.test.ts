import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent'

test('real YAML Loader registers team tools, executes official subagent lifecycle, and unloads', async () => {
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'superhook-loader-'))
  try {
    await ctx.plugin(Loader, { baseUrl: new URL('./fixtures/', import.meta.url).href })
    const include = await ctx.plugin(Include, {
      path: new URL('./fixtures/cordis.yml', import.meta.url).href,
    })
    await ctx.loader.await()
    assert.ok(ctx.tools.get('superhook_run'))
    const tools = ctx.tools
    assert.ok(ctx.agents)
    const owner = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd } })
    const events: string[] = []
    ctx.on('subagent/start', () => {
      events.push('start')
    })
    ctx.on('subagent/end', () => {
      events.push('end')
    })
    for (const name of ['codex', 'kimi', 'grok']) {
      ctx.subagents.registerProvider({
        name,
        capabilities: NO_START_CAPABILITIES,
        inheritsParentContext: false,
        async start(request) {
          assert.equal(request.parent, owner.agent)
          const result: SubagentResult = {
            stopReason: 'completed',
            output: [{ type: 'text', text: `Result from ${name}` }],
          }
          return {
            id: SessionId(randomUUID()),
            localAgent: undefined,
            result: Promise.resolve(result),
            dispose: async () => {
              events.push('dispose')
            },
          }
        },
      })
    }
    const result = await ctx.tools.execute({
      callId: ToolCallId(randomUUID()),
      name: 'superhook_run',
      agent: owner.agent,
      signal: new AbortController().signal,
      arguments: {
        tasks: ['codex', 'kimi', 'grok'].map((provider, i) => ({
          id: `task${i}`,
          provider,
          prompt: 'Review the assignment',
          dependsOn: i ? [`task${i - 1}`] : [],
        })),
      },
    })
    assert.equal(result.isError, false, JSON.stringify(result))
    assert.deepEqual(events, Array.from({ length: 3 }, () => ['start', 'end', 'dispose']).flat())
    assert.match(JSON.stringify(result.value), /Result from grok/)
    await include.dispose()
    assert.equal(tools.get('superhook_run'), undefined)
  } finally {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
