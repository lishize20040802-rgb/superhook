import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { boot } from './support.ts'

for (const scenario of ['success', 'refusal', 'overflow', 'exit', 'hang']) {
  test(`Grok provider: authenticated ACP ${scenario}`, async (t) => {
    const { ctx, owner } = await boot(t)
    await ctx.loader.create({ name: '@deepseek-ai/dsh-subprocess-local' })
    await ctx.loader.create({
      name: new URL('../src/grok.ts', import.meta.url).href,
      config: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/grok-acp.mjs', import.meta.url)), scenario],
        maxOutputBytes: 1024,
        disposeGraceMs: 1000,
      },
    })
    await ctx.loader.await()
    const cancellation = new AbortController()
    const run = await ctx.subagents.start('grok', {
      parent: owner.agent,
      prompt: [{ type: 'text', text: 'test' }],
      signal: cancellation.signal,
    })
    if (scenario === 'hang') cancellation.abort()
    try {
      const result = await run.result
      assert.equal(
        result.stopReason,
        scenario === 'success'
          ? 'completed'
          : scenario === 'refusal'
            ? 'refusal'
            : scenario === 'hang'
              ? 'aborted'
              : 'error',
      )
      assert.doesNotMatch(JSON.stringify(result.output), /Wrong session/)
      if (scenario === 'success')
        assert.equal(result.output[0]?.type === 'text' && result.output[0].text, 'Grok result')
    } finally {
      await run.dispose()
      await run.dispose()
    }
  })
}
