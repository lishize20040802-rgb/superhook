// A native protocol peer, not a substitute for the real official Team/Agent runtime in tests.
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync } from 'node:fs'
const protocol = process.argv[2]
let endpoint
let secret = ''
let rounds = 0
let waiting
const write = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const reply = (id, result) => write({ id, result })
const notify = (method, params) => write({ method, params })
async function tool(name, args = {}) {
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      Authorization: endpoint.auth,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rounds,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const result = await response.json()
  if (result.error || result.result?.isError) throw new Error(JSON.stringify(result))
  return JSON.parse(result.result.content[0].text)
}
function finish(id, text, cancelled = false) {
  writeFileSync(`native-${protocol}.json`, JSON.stringify({ secret, rounds }))
  if (protocol === 'acp') {
    if (!cancelled)
      notify('session/update', {
        sessionId: 'native-fixture',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      })
    reply(id, { stopReason: cancelled ? 'cancelled' : 'end_turn' })
  } else {
    if (!cancelled)
      notify('item/completed', {
        threadId: 'native-fixture',
        turnId: String(rounds),
        item: { type: 'agentMessage', text },
      })
    notify('turn/completed', {
      threadId: 'native-fixture',
      turn: { id: String(rounds), status: cancelled ? 'interrupted' : 'completed' },
    })
  }
}
async function handle({ id, method, params = {} }) {
  if (method === 'initialize')
    return reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
      authMethods: [],
    })
  if (method === 'initialized') return
  if (['session/new', 'thread/start', 'session/load', 'thread/resume'].includes(method)) {
    if (method === 'session/load' || method === 'thread/resume') {
      const saved = JSON.parse(readFileSync(`native-${protocol}.json`, 'utf8'))
      secret = saved.secret
      rounds = saved.rounds
    }
    endpoint =
      protocol === 'acp'
        ? { url: params.mcpServers[0].url, auth: params.mcpServers[0].headers[0].value }
        : {
            url: params.config.mcp_servers['superhook-team'].url,
            auth: params.config.mcp_servers['superhook-team'].http_headers.Authorization,
          }
    return reply(
      id,
      protocol === 'acp' ? { sessionId: 'native-fixture' } : { thread: { id: 'native-fixture' } },
    )
  }
  if (method === 'session/set_model') return reply(id, {})
  if (method === 'session/cancel' || method === 'turn/interrupt') {
    if (waiting) {
      finish(waiting, '', true)
      waiting = undefined
    }
    if (id !== undefined) reply(id, {})
    return
  }
  if (method !== 'session/prompt' && method !== 'turn/start')
    throw new Error(`Unsupported ${method}`)
  rounds++
  if (protocol === 'codex') {
    notify('turn/started', { threadId: 'native-fixture', turn: { id: String(rounds) } })
    reply(id, { turn: { id: String(rounds) } })
  }
  const text = protocol === 'acp' ? params.prompt[0].text : params.input[0].text
  const incoming = JSON.parse(text.split('New incoming messages:\n')[1])
  const prompt = incoming.map((message) => JSON.stringify(message.content)).join('\n')
  if (prompt.includes('WAIT_FOREVER')) {
    waiting = id
    return
  }
  if (prompt.includes('REMEMBER_SAFFRON')) secret = 'saffron'
  let status = ''
  if (prompt.includes('DO_BOARD_WORK')) {
    const created = await tool('team_task_create', {
      subject: 'Native task',
      description: 'Real teammate-owned work',
    })
    const claimed = await tool('team_task_update', {
      task_id: created.id,
      expected_revision: created.revision,
      action: 'claim',
    })
    const completed = await tool('team_task_update', {
      task_id: created.id,
      expected_revision: claimed.revision,
      action: 'complete',
    })
    status = `${completed.status}:${completed.ownerName}`
    await tool('send_message', { target: 'lead', message: 'NATIVE_REPORT' })
  }
  finish(id, prompt.includes('TOOLS_ONLY') ? '' : `ROUND_${rounds} MEMORY_${secret} ${status}`)
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  void handle(message).catch((error) =>
    write({ id: message.id, error: { code: -32603, message: error.message } }),
  )
})
