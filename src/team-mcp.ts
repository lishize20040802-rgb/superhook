/** A private MCP endpoint bound to one exact official teammate, never a caller-supplied identity. */
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { NativeEndpoint } from './types.ts'

const TEAM_TOOLS = new Set([
  'list_agents',
  'send_message',
  'wait_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
])

/** Start an authenticated loopback server; only admit calls during this member's native turn. */
export async function serveTeamTools(ctx: Context, initialAgent: Agent) {
  let agent = initialAgent
  const token = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  let turnSignal: AbortSignal | undefined
  let turnEnd: AbortController | undefined
  let completedCalls = 0
  const pending = new Set<Promise<void>>()
  const connections = new Set<Server>()
  const server = createServer((req, res) => {
    if (lifetime.signal.aborted || pending.size >= 32) {
      res.writeHead(503).end()
      return
    }
    const operation = (async () => {
      if (
        req.headers.origin ||
        req.headers.authorization !== `Bearer ${token}` ||
        req.url !== '/mcp'
      ) {
        res.writeHead(403).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (Number(req.headers['content-length'] ?? 0) > 65536) {
        res.writeHead(413).end()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk as Uint8Array)
        bytes += buffer.length
        if (bytes > 65536) {
          res.writeHead(413).end()
          return
        }
        chunks.push(buffer)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const mcp = new Server(
        { name: 'superhook-team', version: '0.2.0' },
        { capabilities: { tools: {} } },
      )
      connections.add(mcp)
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })
      mcp.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: ctx.tools
          .schemas(agent)
          .filter((tool) => TEAM_TOOLS.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { ...tool.parameters, type: 'object' as const },
            annotations: {
              readOnlyHint: [
                'list_agents',
                'wait_agent',
                'team_task_list',
                'team_task_get',
              ].includes(tool.name),
              destructiveHint: false,
              openWorldHint: false,
            },
          })),
      }))
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        if (
          !turnSignal ||
          turnSignal.aborted ||
          lifetime.signal.aborted ||
          ctx.agents.get(agent.id) !== agent
        )
          throw new Error('This teammate has no active native turn')
        ctx.agentTeams.membership(agent)
        if (!TEAM_TOOLS.has(request.params.name) || !ctx.tools.get(request.params.name, agent))
          throw new Error('Team tool is unavailable in this member scope')
        const result = await ctx.tools.execute({
          callId: ToolCallId(randomUUID()),
          agent,
          name: request.params.name,
          arguments: request.params.arguments ?? {},
          signal: AbortSignal.any([turnSignal, lifetime.signal]),
        })
        if (!result.isError) completedCalls++
        return {
          isError: result.isError,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.isError ? result.content : result.value),
            },
          ],
        }
      })
      try {
        // SDK 1.30.1 exposes optional callbacks differently with exactOptionalPropertyTypes.
        await mcp.connect(transport as Transport)
        const finished = new Promise<void>((resolve) => {
          res.once('finish', resolve)
          res.once('close', resolve)
        })
        await transport.handleRequest(req, res, body)
        await finished
      } finally {
        await mcp.close()
        connections.delete(mcp)
      }
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400)
      res.end()
    })
    pending.add(operation)
    void operation.finally(() => pending.delete(operation))
  })
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing MCP listener address')
  const endpoint: NativeEndpoint = { url: `http://127.0.0.1:${address.port}/mcp`, token }
  return {
    endpoint,
    get completedCalls() {
      return completedCalls
    },
    bind(next: Agent) {
      if (next.id !== initialAgent.id || turnSignal)
        throw new Error('Cannot rebind an active or different teammate')
      agent = next
    },
    enter(signal: AbortSignal) {
      completedCalls = 0
      turnEnd = new AbortController()
      turnSignal = AbortSignal.any([signal, turnEnd.signal])
    },
    async leave() {
      turnEnd?.abort()
      turnSignal = undefined
      await Promise.all([...pending])
    },
    async dispose() {
      lifetime.abort()
      turnSignal = undefined
      server.closeAllConnections()
      await Promise.all([...connections].map((connection) => connection.close()))
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await Promise.all([...pending])
    },
  }
}
