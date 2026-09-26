/** DSH tools for one-shot teamwork through deployment-selected official providers. */
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { orderPlan } from './plan.ts'
import { runTeam } from './runner.ts'
import type { Limits } from './types.ts'

export const name = 'superhook'
export const inject = ['tools', 'subagents']

/** Limits and allowlist belong to the deployment, never to model arguments. */
export interface Config {
  providers?: string[]
  maxTasks?: number
  taskTimeoutMs?: number
  maxPlanBytes?: number
  maxResultBytes?: number
}

export const Config: z<Config> = z.object({
  providers: z.array(z.string()).default(['codex', 'kimi', 'grok']),
  maxTasks: z.number().step(1).min(1).max(32).default(8),
  taskTimeoutMs: z.number().step(1).min(1).max(2147483647).default(600000),
  maxPlanBytes: z.number().step(1).min(1024).max(1048576).default(65536),
  maxResultBytes: z.number().step(1).min(32768).max(1048576).default(131072),
})

// Shared across plugin instances in one host, including different agent sessions.
const workspaces = new Map<string, 'running' | 'cleanup-failed'>()

function resolveConfig(config: Config): Limits {
  const limits = {
    providers: config.providers ?? ['codex', 'kimi', 'grok'],
    maxTasks: config.maxTasks ?? 8,
    taskTimeoutMs: config.taskTimeoutMs ?? 600000,
    maxPlanBytes: config.maxPlanBytes ?? 65536,
    maxResultBytes: config.maxResultBytes ?? 131072,
  }
  for (const [key, min, max] of [
    ['maxTasks', 1, 32],
    ['taskTimeoutMs', 1, 2147483647],
    ['maxPlanBytes', 1024, 1048576],
    ['maxResultBytes', 32768, 1048576],
  ] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < min || limits[key] > max)
      throw new Error(`Invalid ${key}`)
  }
  if (
    !limits.providers.length ||
    new Set(limits.providers).size !== limits.providers.length ||
    limits.providers.some((provider) => !/^[a-zA-Z0-9_-]{1,64}$/.test(provider))
  ) {
    throw new Error(
      'providers must contain unique, nonempty provider names (maximum 64 characters)',
    )
  }
  return limits
}

/** Register tools on the owning fiber and drain accepted work on unload.
 * @param ctx - DSH services supplied by the host or agent preset.
 * @param config - Deployment allowlist and limits.
 */
export function apply(ctx: Context, config: Config): void {
  const limits = resolveConfig(config)
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  ctx.effect(
    () => async () => {
      lifetime.abort()
      await Promise.allSettled(active)
    },
    'superhook.drain()',
  )

  ctx.tools.register(
    defineTool({
      name: 'superhook_agents',
      description:
        'List enabled team members and whether their agent provider is registered. Registration does not verify login or executable availability.',
      parameters: {},
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string', required: true },
              available: { type: 'boolean', required: true },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      execute: async () =>
        limits.providers.map((provider) => ({
          provider,
          available: ctx.subagents.getProvider(provider) !== undefined,
        })),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'superhook_run',
      description:
        'Execute a team plan in the current workspace. Each task is a fresh agent conversation. Supply complete instructions and explicit dependency ids; completed dependency answers are passed to the dependent task. Tasks run sequentially, and failed dependencies skip downstream tasks. No automatic retries or rollback. Waits for results unless run_in_background is true. Use superhook_agents first.',
      parameters: {
        run_in_background: {
          type: 'boolean',
          description:
            'Return an official DSH Job id immediately; collect with job_output and cancel with job_kill. Default false.',
        },
        tasks: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true, description: 'Unique short assignment id.' },
              provider: {
                type: 'string',
                required: true,
                description: 'An enabled, registered provider from superhook_agents.',
              },
              prompt: {
                type: 'string',
                required: true,
                description: 'Complete task, scope, expected deliverable and acceptance checks.',
              },
              dependsOn: {
                type: 'array',
                required: true,
                items: { type: 'string' },
                description:
                  'Task ids whose successful results are required; [] for an independent task.',
              },
            },
          },
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                status: { type: 'string', required: true },
                tasks: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      provider: { type: 'string', required: true },
                      status: { type: 'string', required: true },
                      output: { type: 'string', required: true },
                      detail: { type: 'string', required: true },
                      outputTruncated: { type: 'boolean', required: true },
                      cleanupFailed: { type: 'boolean', required: true },
                    },
                  },
                },
              },
            },
          ],
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      presentCall: (args) => ({ card: 'generic', title: `Superhook · ${args.tasks.length} tasks` }),
      execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error('Superhook requires a calling DSH agent')
        const tasks = orderPlan(args.tasks, limits)
        for (const task of tasks) {
          if (!ctx.subagents.getProvider(task.provider))
            throw new Error(`Provider is not registered: ${task.provider}`)
        }
        const launch = (cancellation: AbortSignal) => {
          const signal = AbortSignal.any([cancellation, lifetime.signal])
          const operation = (async () => {
            signal.throwIfAborted()
            const cwd = parent.session.header.cwd
            if (!cwd) throw new Error('Superhook requires a workspace directory')
            const resolved = await realpath(cwd)
            const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved
            signal.throwIfAborted()
            const existing = workspaces.get(key)
            if (existing)
              throw new Error(
                existing === 'running'
                  ? 'Another Superhook team is using this workspace'
                  : 'An earlier cleanup failed; inspect child processes and restart the host before retrying',
              )
            workspaces.set(key, 'running')
            try {
              const report = await runTeam(
                tasks,
                limits,
                (task, prompt, childSignal) =>
                  ctx.subagents.start(task.provider, {
                    parent,
                    label: task.id,
                    prompt: [{ type: 'text', text: prompt }],
                    signal: childSignal,
                  }),
                signal,
                (error) => ctx.logger.warn('Superhook child operation failed', error),
              )
              if (report.tasks.some((task) => task.cleanupFailed))
                workspaces.set(key, 'cleanup-failed')
              return report
            } finally {
              if (workspaces.get(key) === 'running') workspaces.delete(key)
            }
          })()
          active.add(operation)
          return operation.finally(() => active.delete(operation))
        }
        exec.signal.throwIfAborted()
        lifetime.signal.throwIfAborted()
        if (args.run_in_background === true) {
          const jobs = ctx.get('jobs')
          if (!jobs)
            throw new Error('Background teamwork requires official DSH Jobs and job control tools')
          const jobId = jobs.start({
            kind: 'subagent',
            label: `Superhook: ${tasks.length} tasks`,
            owner: parent.id,
            outputLimitBytes: limits.maxResultBytes + 4096,
            run: () => {
              const cancellation = new AbortController()
              const done = launch(cancellation.signal).then(
                (report): JobOutcome => ({
                  status: report.status === 'cancelled' ? 'killed' : report.status,
                  result: JSON.stringify(report),
                }),
                (error: unknown): JobOutcome => {
                  ctx.logger.warn('Superhook team startup failed', error)
                  return {
                    status: cancellation.signal.aborted ? 'killed' : 'failed',
                    detail: 'Team could not start; check host diagnostics',
                  }
                },
              )
              return { cancel: () => cancellation.abort(), done }
            },
          })
          return Promise.resolve({ kind: 'background' as const, jobId })
        }
        return launch(exec.signal).then((report) => ({ kind: 'foreground' as const, ...report }))
      },
    }),
  )
}
