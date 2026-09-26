/** Native external agents participating in the official durable Agent Teams runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { NO_START_CAPABILITIES } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { NativeSession } from './native-session.ts'
import { serveTeamTools } from './team-mcp.ts'
import { nativeStateStore } from './native-state.ts'
import type { NativeProviderConfig, TeammatesConfig } from './types.ts'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'

export const name = 'superhook-teammates'
export const inject = [
  'agents',
  'agentTeams',
  'subagents',
  'subprocess',
  'llm',
  'tools',
  'sessions',
  'systemPrompt',
]
export type Config = TeammatesConfig
export const Config: z<Config> = z.object({
  stateDirectory: z.string().min(1).required(),
  providers: z
    .array(
      z.object({
        name: z.string().min(1),
        protocol: z.union(['codex', 'acp'] as const),
        command: z.string().min(1),
        args: z.array(z.string()).default([]),
        env: z.dict(z.string()),
        model: z.string(),
        authMethod: z.string(),
        permission: z.union(['reject', 'review', 'allow'] as const).default('reject'),
      }),
    )
    .default([]),
  startupTimeoutMs: z.number().step(1).min(1).max(2147483647).default(60000),
  turnTimeoutMs: z.number().step(1).min(1).max(2147483647).default(600000),
  disposeGraceMs: z.number().step(1).min(1).max(30000).default(3000),
  maxOutputBytes: z.number().step(1).min(1024).max(1048576).default(131072),
  maxSessions: z.number().step(1).min(1).max(64).default(8),
})

/** Mount providers, a native model route, and a Lead-only factory using public DSH seams. */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.stateDirectory)) throw new Error('Native stateDirectory must be absolute')
  const routes = new Map<string, NativeProviderConfig>()
  for (const provider of config.providers) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(provider.name) || routes.has(`superhook-${provider.name}`))
      throw new Error('Native teammate names must be unique lowercase identifiers')
    routes.set(`superhook-${provider.name}`, provider)
  }
  if (!routes.size) return
  const lifetime = new AbortController()
  const bindings = new Map<SessionId, Promise<Awaited<ReturnType<typeof connect>>>>()
  const active = new Set<Promise<unknown>>()
  const routeOf = (agent: Agent) => {
    const membership = ctx.agentTeams.tryMembership(agent)
    return membership?.role === 'teammate'
      ? ctx.agentTeams.listMembers(agent).find((member) => member.id === agent.id)?.provider
      : undefined
  }
  // Desktop presets interpolate these before agent/request resolves the native route.
  // Scope the identity to this member so it never inherits the Lead's model label.
  ctx.on('agent/created', ({ agent }) => {
    const route = routeOf(agent)
    const provider = route ? routes.get(route) : undefined
    if (!provider) return
    agent.ctx.systemPrompt.variable('provider', () => provider.name)
    agent.ctx.systemPrompt.variable('model', () => provider.model ?? `${provider.name} CLI default`)
    return undefined
  })

  async function connect(agent: Agent, provider: NativeProviderConfig, signal: AbortSignal) {
    const mcp = await serveTeamTools(ctx, agent)
    const cwd = agent.session.header.cwd
    if (!cwd) {
      await mcp.dispose()
      throw new Error('Native teammate requires a workspace')
    }
    let native: NativeSession | undefined
    let disposed: Promise<void> | undefined
    const dispose = () =>
      (disposed ??= (async () => {
        const results = await Promise.allSettled([native?.dispose(), mcp.dispose()])
        const errors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        )
        if (errors.length) throw new AggregateError(errors, 'Native teammate cleanup failed')
      })())
    try {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ provider, cwd }))
        .digest('hex')
      const store = nativeStateStore(config.stateDirectory, agent.id, fingerprint)
      const saved = await store.read()
      const seen = new Set(saved?.messageIds ?? [])
      native = new NativeSession(
        ctx,
        provider,
        cwd,
        config.disposeGraceMs ?? 3000,
        config.maxOutputBytes ?? 131072,
      )
      const nativeId = await native.initialize(
        cwd,
        mcp.endpoint,
        AbortSignal.any([
          lifetime.signal,
          signal,
          AbortSignal.timeout(config.startupTimeoutMs ?? 60000),
        ]),
        saved?.nativeId,
      )
      const save = () => store.write({ version: 1, fingerprint, nativeId, messageIds: [...seen] })
      if (!saved) await save()
      // Official continuation Activations are released after every idle turn. The native
      // conversation belongs to the durable member under its Lead, not that short activation.
      ctx.agentTeams.membership(agent).root.ctx.effect(
        () => async () => {
          await dispose()
          bindings.delete(agent.id)
        },
        'superhook.nativeSession()',
      )
      return { native, mcp, seen, save, dispose }
    } catch (error) {
      try {
        await dispose()
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Native startup and cleanup failed')
      }
      throw error
    }
  }

  class NativeAdapter extends LlmAdapter {
    override providerRetryPolicy() {
      return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'superhook')
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const agent = options.sessionId ? ctx.agents.get(options.sessionId) : undefined
      if (!agent || options.purpose)
        throw new Error('Native route requires a live teammate conversation')
      const member = ctx.agentTeams.membership(agent)
      const providerId = routeOf(agent)
      const provider = providerId ? routes.get(providerId) : undefined
      if (member.role !== 'teammate' || !provider)
        throw new Error('Native route is only available to its official teammate')
      const signal = AbortSignal.any([
        lifetime.signal,
        options.signal ?? new AbortController().signal,
        AbortSignal.timeout(config.turnTimeoutMs ?? 600000),
      ])
      const operation = (async () => {
        let binding = bindings.get(agent.id)
        if (!binding) {
          if (bindings.size >= (config.maxSessions ?? 8))
            throw new Error('Native teammate session limit reached')
          binding = connect(agent, provider, signal)
          bindings.set(agent.id, binding)
        }
        const runtime = await binding
        signal.throwIfAborted()
        runtime.mcp.bind(agent)
        const incoming = options.messages.filter(
          (message) => message.role === 'user' && (!message.id || !runtime.seen.has(message.id)),
        )
        if (!incoming.length)
          throw new Error('No new teammate message; native work is never retried automatically')
        const ids = incoming.flatMap((message) => (message.id ? [message.id] : []))
        // Commit delivery intent before native execution: a failed turn cannot silently replay writes.
        for (const id of ids) runtime.seen.add(id)
        await runtime.save()
        const context = options.messages.filter(
          (message) => message.role === 'system' || message.role === 'developer',
        )
        const prompt = `You are an official DSH teammate named ${member.name}. Use the superhook-team MCP tools to read the roster, exchange messages, and manage the shared task board. Your native conversation persists between turns. Use send_message for explicit communication with the Lead and peers; DSH also reports your turn settlement to the Lead. Respect task ownership, revision checks and write scopes. Finish each turn with a brief text summary.\n\nDSH context:\n${JSON.stringify(context)}\n\nNew incoming messages:\n${JSON.stringify(incoming)}`
        runtime.mcp.enter(signal)
        try {
          const output = await runtime.native.prompt(prompt, signal)
          if (!output.trim())
            throw new Error(
              `Native teammate returned no text after ${runtime.mcp.completedCalls} successful team calls; inspect the board and native CLI diagnostics before continuing`,
            )
          return output
        } finally {
          await runtime.mcp.leave()
        }
      })()
      active.add(operation)
      try {
        const text = await operation
        if (text) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        active.delete(operation)
      }
    }
  }
  ctx.llm.registerAdapter(['superhook-native'], new NativeAdapter())
  ctx.on('agent/request', async ({ agent }, next) => {
    const route = routeOf(agent)
    if (!route || !routes.has(route)) return next()
    return { provider: 'superhook-native', model: route }
  })
  for (const [id, provider] of routes) {
    ctx.subagents.registerProvider({
      name: id,
      capabilities: NO_START_CAPABILITIES,
      inheritsParentContext: false,
      async prepareContinuable(request) {
        request.signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        await ctx.subprocess.resolveExecutable(provider.command, provider.env, request.signal)
        return {}
      },
      async start() {
        throw new Error('Use superhook_spawn_teammate for a durable native teammate')
      },
    })
  }
  ctx.tools.register(
    defineTool({
      name: 'superhook_spawn_teammate',
      description: `Create a real, durable official teammate powered by a native external agent. Providers: ${config.providers.map((provider) => provider.name).join(', ')}. Lead only. The member appears in list_agents and uses the official send_message, task board, wait_agent and interrupt_agent workflow. Each member retains its native conversation. Use this instead of superhook_run when a teammate is wanted.`,
      parameters: {
        provider: { type: 'string', required: true, description: 'Native provider name.' },
        name: { type: 'string', required: true, description: 'Unique official teammate name.' },
        description: { type: 'string', required: true, description: 'Short role description.' },
        prompt: {
          type: 'string',
          required: true,
          description: 'Initial task and collaboration instructions.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (!exec.agent) throw new Error('An official Team Lead is required')
        if (!routes.has(`superhook-${args.provider}`))
          throw new Error('Unknown native teammate provider')
        if (
          !ctx.tools.get('send_message', exec.agent) ||
          !ctx.tools.get('team_task_list', exec.agent)
        )
          throw new Error('Enable the official Agent Teams tools before creating native teammates')
        const result = await ctx.agentTeams.spawnTeammate(exec.agent, {
          name: args.name,
          description: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          context: 'fresh',
          provider: `superhook-${args.provider}`,
          signal: exec.signal,
        })
        return { member: { ...result.member } }
      },
    }),
  )
  ctx.effect(
    () => async () => {
      lifetime.abort()
      await Promise.allSettled([...active])
      const results = await Promise.allSettled(
        [...bindings.values()].map(async (binding) => {
          // Failed startup already drained its resources and surfaced its failure in the turn.
          const runtime = await binding.catch(() => undefined)
          await runtime?.dispose()
        }),
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      )
      if (failures.length) throw new AggregateError(failures, 'Native teammate shutdown failed')
    },
    'superhook.teammates()',
  )
}
