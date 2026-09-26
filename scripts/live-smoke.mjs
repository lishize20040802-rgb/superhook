// Explicit live diagnostic. Sends one bounded, tool-free prompt through the real plugin.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const provider = process.argv[2]
const entries = {
  grok: { name: new URL('../lib/grok.js', import.meta.url).href },
  kimi: {
    name: '@deepseek-ai/dsh-subagent-acp',
    config: { providerName: 'kimi', command: 'kimi', args: ['acp'], permission: 'reject' },
  },
  codex: { name: '@deepseek-ai/dsh-subagent-codex' },
}
if (!Object.hasOwn(entries, provider)) throw new Error('Select grok, kimi or codex')
const ctx = new Context()
const cwd = await mkdtemp(join(tmpdir(), 'superhook-live-'))
try {
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  await ctx.plugin(Include, {
    path: new URL('../tests/fixtures/cordis.yml', import.meta.url).href,
    patches: [
      {
        id: 'superhook',
        name: new URL('../lib/index.js', import.meta.url).href,
        config: { taskTimeoutMs: 90000 },
      },
      {
        insert: [
          { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
          { id: 'live-provider', ...entries[provider] },
        ],
      },
    ],
  })
  await ctx.loader.await()
  assert.ok(ctx.subagents.getProvider(provider), 'Provider did not load')
  const owner = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd } })
  const result = await ctx.tools.execute({
    callId: ToolCallId(randomUUID()),
    agent: owner.agent,
    name: 'superhook_run',
    signal: new AbortController().signal,
    arguments: {
      tasks: [
        {
          id: 'smoke',
          provider,
          dependsOn: [],
          prompt:
            'Do not read or modify files, execute commands, or use tools. Reply with exactly: SUPERHOOK_SMOKE_OK',
        },
      ],
    },
  })
  assert.equal(result.isError, false, 'Superhook tool failed')
  console.log(JSON.stringify({ provider, report: result.value }))
  assert.equal(result.value.status, 'completed', 'Live provider did not complete')
  assert.match(result.value.tasks[0].output, /SUPERHOOK_SMOKE_OK/)
} finally {
  await ctx.fiber.dispose()
  await rm(cwd, { recursive: true, force: true })
}
