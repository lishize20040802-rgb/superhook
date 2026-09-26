import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const ctx = new Context()
try {
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  await ctx.plugin(Include, {
    path: new URL('./fixtures/cordis.yml', import.meta.url).href,
    patches: [{ id: 'superhook', name: new URL('../lib/index.js', import.meta.url).href }],
  })
  await ctx.loader.await()
  const result = await ctx.tools.execute({
    callId: ToolCallId('built-smoke'),
    name: 'superhook_agents',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.deepEqual(
    result.value,
    ['codex', 'kimi', 'grok'].map((provider) => ({ provider, available: false })),
  )
  console.log('Built ESM plugin loaded and executed through official YAML Loader.')
} finally {
  await ctx.fiber.dispose()
}
