/** Grok ACP provider: adds the explicit cached-token authentication required by Grok Build. */
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  NO_START_CAPABILITIES,
  resolveChildCwd,
  settleRunResult,
  subprocessRunHandle,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'

export const name = 'superhook-grok'
export const inject = ['subagents', 'subprocess']

/** Deployment controls; authentication remains inside the installed Grok CLI. */
export interface Config {
  command?: string
  args?: string[]
  providerName?: string
  permission?: 'reject' | 'allow'
  startupTimeoutMs?: number
  disposeGraceMs?: number
  maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  command: z.string().min(1).default('grok'),
  args: z.array(z.string()).default(['agent', '--no-leader', 'stdio']),
  providerName: z.string().min(1).default('grok'),
  permission: z.union(['reject', 'allow'] as const).default('reject'),
  startupTimeoutMs: z.number().step(1).min(1).max(2147483647).default(30000),
  disposeGraceMs: z.number().step(1).min(1).max(2147483647).default(3000),
  maxOutputBytes: z.number().step(1).min(1024).max(1048576).default(131072),
})

/** Register a one-shot external provider through the official DSH registry.
 * @param ctx - Official subagent and subprocess services.
 * @param config - Executable, permission and resource limits.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = {
    command: config.command ?? 'grok',
    args: config.args ?? ['agent', '--no-leader', 'stdio'],
    providerName: config.providerName ?? 'grok',
    permission: config.permission ?? 'reject',
    startupTimeoutMs: config.startupTimeoutMs ?? 30000,
    disposeGraceMs: config.disposeGraceMs ?? 3000,
    maxOutputBytes: config.maxOutputBytes ?? 131072,
  }
  for (const value of [
    settings.startupTimeoutMs,
    settings.disposeGraceMs,
    settings.maxOutputBytes,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
      throw new Error('Invalid Grok resource limit')
  }
  if (!settings.command.trim() || !settings.providerName.trim())
    throw new Error('Grok command and provider name must be nonempty')
  ctx.subagents.registerProvider({
    name: settings.providerName,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    async start(request) {
      request.signal.throwIfAborted()
      const prompt = request.prompt.map((block) => {
        if (block.type !== 'text') throw new Error('Grok delegation accepts text tasks only')
        return { type: 'text' as const, text: block.text }
      })
      const cwd = resolveChildCwd(name, undefined, request.parent.session.header.cwd)
      const child = ctx.subprocess.spawn({
        argv: [settings.command, ...settings.args],
        cwd,
        graceMs: settings.disposeGraceMs,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
      })
      const stopped = Promise.withResolvers<never>()
      // A rejection is consumed even when startup has not yet begun racing it.
      void stopped.promise.catch(() => undefined)
      let cancelled = false
      let overflow = false
      let output = ''
      let sessionId: string | undefined
      let stage = 'initialize'
      const onAbort = () => {
        cancelled = true
        stopped.reject(new Error('Grok delegation cancelled'))
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()
      const exited = child.done.then(
        () => {
          throw new Error('Grok process exited before protocol completion')
        },
        () => {
          throw new Error('Grok process failed')
        },
      )
      void exited.catch(() => undefined)
      const collectOutput = () => (output ? [{ type: 'text' as const, text: output }] : [])
      const teardown = async () => {
        child.stdin?.end()
        if (await child.waitForExit(AbortSignal.timeout(settings.disposeGraceMs))) return
        child.terminate()
        if (!(await child.waitForExit(AbortSignal.timeout(settings.disposeGraceMs)))) {
          throw new Error('Grok managed process did not exit')
        }
      }
      let startupTimer: ReturnType<typeof setTimeout> | undefined
      try {
        if (!child.stdin || !child.stdout) throw new Error('Grok protocol pipes unavailable')
        const connection = client({ name: 'dsh-superhook' })
          .onNotification(methods.client.session.update, ({ params }) => {
            if (
              params.sessionId !== sessionId ||
              params.update.sessionUpdate !== 'agent_message_chunk'
            )
              return Promise.resolve()
            if (params.update.content.type === 'text') {
              const text = params.update.content.text
              if (Buffer.byteLength(output) + Buffer.byteLength(text) > settings.maxOutputBytes) {
                overflow = true
                stopped.reject(new Error('Grok output limit exceeded'))
              } else output += text
            }
            return Promise.resolve()
          })
          .onRequest(methods.client.session.requestPermission, ({ params }) => {
            const option =
              settings.permission === 'allow' && params.sessionId === sessionId
                ? params.options.find((option) => option.kind === 'allow_once')
                : undefined
            return Promise.resolve(
              option
                ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
                : { outcome: { outcome: 'cancelled' as const } },
            )
          })
          .connect(
            ndJsonStream(
              Writable.toWeb(child.stdin),
              Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
            ),
          ).agent
        const race = <T>(operation: Promise<T>) =>
          Promise.race([operation, stopped.promise, exited])
        startupTimer = setTimeout(
          () => stopped.reject(new Error('Grok startup timed out')),
          settings.startupTimeoutMs,
        )
        const initialized = await race(
          connection.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
          }),
        )
        stage = 'authenticate'
        if (!initialized.authMethods?.some((method) => method.id === 'cached_token')) {
          throw new Error('Grok cached login is unavailable; run grok login interactively')
        }
        await race(
          connection.request(methods.agent.authenticate, {
            methodId: 'cached_token',
            _meta: { headless: true },
          }),
        )
        stage = 'new-session'
        const session = await race(
          connection.request(methods.agent.session.new, { cwd, mcpServers: [] }),
        )
        sessionId = session.sessionId
        clearTimeout(startupTimer)
        stage = 'prompt'
        return subprocessRunHandle({
          id: SessionId(randomUUID()),
          signal: request.signal,
          onAbort,
          requestCancel: onAbort,
          teardown,
          result: settleRunResult({
            signal: request.signal,
            onAbort,
            cancelled: () => cancelled,
            collectOutput,
            collectDiagnostic: () =>
              `Grok delegation failed at ${stage}${overflow ? ' (output limit)' : ''}`,
            onError: (error) => ctx.logger.warn('Grok delegation failed', error),
            attempt: async (): Promise<SubagentResult> => {
              const response = await race(
                connection.request(methods.agent.session.prompt, {
                  sessionId: session.sessionId,
                  prompt,
                }),
              )
              if (
                !response ||
                typeof response !== 'object' ||
                !('stopReason' in response) ||
                typeof response.stopReason !== 'string'
              ) {
                throw new Error('Grok returned an invalid prompt response')
              }
              const reason = response.stopReason
              return {
                output: collectOutput(),
                stopReason:
                  reason === 'end_turn'
                    ? 'completed'
                    : reason === 'cancelled'
                      ? 'aborted'
                      : reason === 'max_tokens'
                        ? 'max-tokens'
                        : reason === 'refusal'
                          ? 'refusal'
                          : 'error',
              }
            },
          }),
        })
      } catch (error: unknown) {
        clearTimeout(startupTimer)
        request.signal.removeEventListener('abort', onAbort)
        ctx.logger.warn('Grok startup failed', error)
        const failure = new Error(
          `Grok startup failed at ${stage}; check CLI login and host diagnostics`,
        )
        try {
          await teardown()
        } catch (cleanupError: unknown) {
          throw new AggregateError([failure, cleanupError], 'Grok startup and cleanup failed')
        }
        throw failure
      }
    },
  })
}
