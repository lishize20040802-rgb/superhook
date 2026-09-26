import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-agent'

export async function boot(t: TestContext, team = false, disableSuperhook = false) {
  const ctx = new Context()
  const cwd = await mkdtemp(join(tmpdir(), 'superhook-test-'))
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  })
  await ctx.plugin(Loader, { baseUrl: new URL('./fixtures/', import.meta.url).href })
  await ctx.plugin(Include, {
    path: new URL('./fixtures/cordis.yml', import.meta.url).href,
    patches: [
      ...(team
        ? [
            {
              insert: [
                {
                  id: 'persistence',
                  name: '@deepseek-ai/dsh-session-persistence-jsonl',
                  config: { root: join(cwd, 'sessions'), compression: 'none' },
                },
                { id: 'team', name: '@deepseek-ai/dsh-experimental-agent-team' },
                { id: 'team-tools', name: '@deepseek-ai/dsh-experimental-tool-agent-team' },
                { id: 'query', name: '@deepseek-ai/dsh-session-query' },
                { id: 'team-bridge', name: new URL('../src/agent-team.ts', import.meta.url).href },
              ],
            },
          ]
        : []),
      ...(disableSuperhook ? [{ id: 'superhook', disabled: true }] : []),
    ],
  })
  await ctx.loader.await()
  const owner = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd } })
  function provider(start: SubagentProvider['start'], name = 'codex') {
    return ctx.subagents.registerProvider({
      name,
      capabilities: NO_START_CAPABILITIES,
      inheritsParentContext: false,
      start,
    })
  }
  function call(name: string, args: unknown, signal = new AbortController().signal) {
    return ctx.tools.execute({
      callId: ToolCallId(randomUUID()),
      name,
      arguments: args,
      agent: owner.agent,
      signal,
    })
  }
  return { ctx, owner, provider, call }
}

export const assignment = {
  id: 'work',
  provider: 'codex',
  prompt: 'Review the code',
  dependsOn: [],
}
