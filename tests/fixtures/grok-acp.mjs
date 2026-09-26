// Fake external CLI: real stdio JSON-RPC, no network or credentials.
import { createInterface } from 'node:readline'
const scenario = process.argv[2] ?? 'success'
let authenticated = false
const lines = createInterface({ input: process.stdin })
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
lines.on('line', (line) => {
  const message = JSON.parse(line)
  const { id, method } = message
  if (method === 'initialize')
    send({
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: 'cached_token', name: 'Saved CLI login' }],
      },
    })
  if (method === 'authenticate') {
    authenticated =
      message.params.methodId === 'cached_token' && message.params._meta.headless === true
    send({ id, result: {} })
  }
  if (method === 'session/new') {
    if (authenticated) send({ id, result: { sessionId: 'test-session' } })
    else send({ id, error: { code: -32000, message: 'Authentication required' } })
  }
  if (method === 'session/prompt') {
    if (scenario === 'hang') return
    if (scenario === 'exit') {
      process.exitCode = 1
      lines.close()
      process.stdin.destroy()
      return
    }
    send({
      method: 'session/update',
      params: {
        sessionId: 'other-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Wrong session' },
        },
      },
    })
    send({
      method: 'session/update',
      params: {
        sessionId: 'test-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: scenario === 'overflow' ? 'x'.repeat(5000) : 'Grok result',
          },
        },
      },
    })
    send({ id, result: { stopReason: scenario === 'refusal' ? 'refusal' : 'end_turn' } })
  }
})
