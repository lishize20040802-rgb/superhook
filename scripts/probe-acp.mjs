// Development diagnostic; --smoke optionally sends a bounded, tool-free prompt.
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'

const provider = process.argv[2]
const smoke = process.argv.includes('--smoke')
const argv =
  provider === 'kimi'
    ? ['kimi', 'acp']
    : provider === 'grok'
      ? ['grok', 'agent', '--no-leader', 'stdio']
      : undefined
if (!argv) throw new Error('Usage: node scripts/probe-acp.mjs kimi|grok')
const ctx = new Context()
let child
let lines
let timer
try {
  await ctx.plugin(Subprocess)
  child = ctx.subprocess.spawn({
    argv,
    cwd: process.cwd(),
    graceMs: 1000,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
  })
  const pending = new Map()
  let nextId = 0
  lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (smoke && message.method === 'session/update')
      console.log(JSON.stringify(message.params.update))
    if (message.method === 'session/request_permission')
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { outcome: { outcome: 'cancelled' } },
        }) + '\n',
      )
    const waiter = pending.get(message.id)
    if (waiter) {
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(`ACP error code ${message.error.code}`))
      else waiter.resolve(message.result)
    }
  })
  const rejectPending = (error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  void child.done.then(
    () => rejectPending(new Error('ACP process exited')),
    () => rejectPending(new Error('ACP process failed')),
  )
  timer = setTimeout(() => {
    rejectPending(new Error('ACP probe timed out'))
    child.terminate()
  }, 20000)
  function request(method, params) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  console.log(
    JSON.stringify({
      provider,
      initialized: true,
      protocolVersion: initialized.protocolVersion,
      authMethods: initialized.authMethods?.map((method) => method.id),
    }),
  )
  if (provider === 'grok') {
    if (!initialized.authMethods?.some((method) => method.id === 'cached_token'))
      throw new Error('Run grok login first')
    await request('authenticate', { methodId: 'cached_token', _meta: { headless: true } })
    console.log(JSON.stringify({ provider, authenticated: true, method: 'cached_token' }))
  }
  const session = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
  if (provider === 'kimi') {
    const model = session.configOptions?.find((option) => option.id === 'model')
    console.log(JSON.stringify({ provider, currentModel: model?.currentValue }))
  }
  if (smoke)
    console.log(
      JSON.stringify(
        await request('session/prompt', {
          sessionId: session.sessionId,
          prompt: [
            {
              type: 'text',
              text: 'Do not read or modify files, execute commands, or use tools. Reply with exactly: SUPERHOOK_SMOKE_OK',
            },
          ],
        }),
      ),
    )
  console.log(
    JSON.stringify({
      provider,
      sessionCreated: typeof session.sessionId === 'string',
      promptSent: smoke,
    }),
  )
} catch (error) {
  console.error(JSON.stringify({ provider, verified: false, error: error.message }))
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  lines?.close()
  if (child) {
    child.stdin?.end()
    child.terminate()
    await child.waitForExit()
  }
  await ctx.fiber.dispose()
}
