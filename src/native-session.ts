/** Persistent native sessions over the public Codex app-server and ACP protocols. */
import type { Context } from '@deepseek-ai/cordis'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { NativeEndpoint, NativeProviderConfig } from './types.ts'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid native protocol object')
  return value as Record<string, unknown>
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing native session identity')
  return value
}

/** One process and one native conversation, retained between official teammate turns. */
export class NativeSession {
  private readonly child: SubprocessHandle
  private readonly rpc: JsonRpcLineTransport
  private readonly failed = Promise.withResolvers<never>()
  private nativeId = ''
  private turnId = ''
  private output = ''
  private finalOutput = ''
  private completion: ReturnType<typeof Promise.withResolvers<void>> | undefined
  private active = false
  private turnSignal: AbortSignal | undefined
  private poisoned = false
  private closing: Promise<void> | undefined

  constructor(
    ctx: Context,
    private readonly config: NativeProviderConfig,
    cwd: string,
    private readonly graceMs: number,
    private readonly maxOutputBytes: number,
  ) {
    this.child = ctx.subprocess.spawn({
      argv: [config.command, ...config.args],
      cwd,
      env: config.env,
      graceMs,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 4096 } },
    })
    if (!this.child.stdin || !this.child.stdout)
      throw new Error('Native protocol pipes unavailable')
    this.rpc = new JsonRpcLineTransport(this.child.stdout, this.child.stdin)
    void this.failed.promise.catch(() => undefined)
    void this.child.done.then(
      () => this.fail(new Error('Native teammate process exited')),
      () => this.fail(new Error('Native teammate process failed')),
    )
    this.rpc.onNotification((method, params) => {
      try {
        this.notification(method, params)
      } catch (error) {
        this.fail(error)
      }
    })
    this.rpc.onRequest(async (method, params) => {
      if (method === 'session/request_permission') {
        const options = Array.isArray(params.options) ? params.options.map(record) : []
        const choice =
          this.active &&
          !this.turnSignal?.aborted &&
          params.sessionId === this.nativeId &&
          config.permission === 'allow'
            ? options.find((option) => option.kind === 'allow_once')
            : undefined
        return {
          outcome: choice
            ? { outcome: 'selected', optionId: choice.optionId }
            : { outcome: 'cancelled' },
        }
      }
      if (method.endsWith('/requestApproval')) return { decision: 'decline' }
      throw new Error('Native teammate requested an unsupported interactive operation')
    })
    this.rpc.start()
  }

  private fail(error: unknown) {
    this.poisoned = true
    this.failed.reject(error)
  }

  private append(text: string) {
    if (Buffer.byteLength(this.output) + Buffer.byteLength(text) > this.maxOutputBytes)
      throw new Error('Native teammate output limit exceeded')
    this.output += text
  }

  private notification(method: string, params: Record<string, unknown>) {
    if (!this.active) return
    if (this.config.protocol === 'acp') {
      if (method !== 'session/update' || params.sessionId !== this.nativeId) return
      const update = record(params.update)
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = record(update.content)
        if (content.type === 'text' && typeof content.text === 'string') this.append(content.text)
      }
      return
    }
    if (params.threadId !== this.nativeId) return
    if (method === 'turn/started') this.turnId = identity(record(params.turn).id)
    if (this.turnId && typeof params.turnId === 'string' && params.turnId !== this.turnId) return
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string')
      this.append(params.delta)
    if (method === 'item/completed') {
      const item = record(params.item)
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        if (Buffer.byteLength(item.text) > this.maxOutputBytes)
          throw new Error('Native output limit exceeded')
        this.finalOutput = item.text
      }
    }
    if (method === 'turn/completed') {
      const turn = record(params.turn)
      if (this.turnId && turn.id !== this.turnId) return
      if (turn.status === 'completed') this.completion?.resolve()
      else this.completion?.reject(new Error(`Codex turn ended: ${String(turn.status)}`))
    }
  }

  /** Establish or resume the same native identity. Unsupported restoration fails explicitly. */
  async initialize(
    cwd: string,
    endpoint: NativeEndpoint,
    signal: AbortSignal,
    resumeId?: string,
  ): Promise<string> {
    const request = (method: string, params: object) =>
      Promise.race([this.rpc.request(method, params, signal), this.failed.promise])
    if (this.config.protocol === 'codex') {
      await request('initialize', {
        clientInfo: { name: 'superhook', version: '0.2.0' },
        capabilities: {},
      })
      this.rpc.notify('initialized')
      const response = record(
        await request(resumeId ? 'thread/resume' : 'thread/start', {
          ...(resumeId ? { threadId: resumeId } : {}),
          cwd,
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(this.config.permission === 'review'
            ? {
                approvalPolicy: 'on-request',
                approvalsReviewer: 'auto_review',
                sandbox: 'workspace-write',
              }
            : {
                approvalPolicy: 'never',
                sandbox: this.config.permission === 'allow' ? 'danger-full-access' : 'read-only',
              }),
          config: {
            mcp_servers: {
              'superhook-team': {
                url: endpoint.url,
                http_headers: { Authorization: `Bearer ${endpoint.token}` },
              },
            },
          },
        }),
      )
      this.nativeId = identity(record(response.thread).id)
    } else {
      const initialized = record(
        await request('initialize', {
          protocolVersion: 1,
          clientInfo: { name: 'superhook', version: '0.2.0' },
          clientCapabilities: {},
        }),
      )
      if (this.config.authMethod)
        await request('authenticate', {
          methodId: this.config.authMethod,
          _meta: { headless: true },
        })
      const capabilities = record(initialized.agentCapabilities ?? {})
      if (!record(capabilities.mcpCapabilities ?? {}).http)
        throw new Error('This ACP client does not support HTTP MCP team tools')
      if (resumeId && !capabilities.loadSession)
        throw new Error(
          'This ACP client cannot restore a native session after unload; create a new teammate explicitly',
        )
      const params = {
        cwd,
        mcpServers: [
          {
            type: 'http',
            name: 'superhook-team',
            url: endpoint.url,
            headers: [{ name: 'Authorization', value: `Bearer ${endpoint.token}` }],
          },
        ],
      }
      const response = record(
        await request(resumeId ? 'session/load' : 'session/new', {
          ...params,
          ...(resumeId ? { sessionId: resumeId } : {}),
        }),
      )
      this.nativeId = resumeId ?? identity(response.sessionId)
      if (this.config.model)
        await request('session/set_model', { sessionId: this.nativeId, modelId: this.config.model })
    }
    if (resumeId && this.nativeId !== resumeId)
      throw new Error('Native client changed the resumed session identity')
    return this.nativeId
  }

  /** Run one turn; interruption drains or terminates the process before returning. Never retry a turn. */
  async prompt(text: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    if (this.active || this.poisoned || this.closing)
      throw new Error('Native session is busy or unavailable; no automatic retry')
    this.active = true
    this.turnSignal = signal
    this.output = ''
    this.finalOutput = ''
    this.turnId = ''
    this.completion = Promise.withResolvers<void>()
    void this.completion.promise.catch(() => undefined)
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      if (this.config.protocol === 'acp')
        this.rpc.notify('session/cancel', { sessionId: this.nativeId })
      else if (this.turnId)
        void this.rpc
          .request('turn/interrupt', { threadId: this.nativeId, turnId: this.turnId })
          .catch(() => undefined)
      killTimer ??= setTimeout(() => {
        void this.dispose().catch((error) => this.fail(error))
      }, this.graceMs)
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const operation = (async () => {
        if (this.config.protocol === 'acp') {
          const response = record(
            await this.rpc.request('session/prompt', {
              sessionId: this.nativeId,
              prompt: [{ type: 'text', text }],
            }),
          )
          if (response.stopReason !== 'end_turn')
            throw new Error(`ACP turn ended: ${String(response.stopReason)}`)
        } else {
          const response = record(
            await this.rpc.request('turn/start', {
              threadId: this.nativeId,
              input: [{ type: 'text', text, text_elements: [] }],
            }),
          )
          this.turnId = identity(record(response.turn).id)
          if (signal.aborted) cancel()
          await this.completion!.promise
        }
      })()
      await Promise.race([operation, this.failed.promise])
      signal.throwIfAborted()
      const output = this.finalOutput || this.output
      return output
    } catch (error) {
      // Uncertain partial native work must not be replayed or restarted silently.
      if (!signal.aborted) this.poisoned = true
      if (this.poisoned) await this.dispose()
      throw error
    } finally {
      clearTimeout(killTimer)
      signal.removeEventListener('abort', cancel)
      this.active = false
      this.turnSignal = undefined
    }
  }

  /** Idempotent managed-process teardown. */
  dispose(): Promise<void> {
    return (this.closing ??= (async () => {
      this.rpc.close()
      this.child.stdin?.end()
      if (!(await this.child.waitForExit(AbortSignal.timeout(this.graceMs)))) {
        this.child.terminate()
        if (!(await this.child.waitForExit(AbortSignal.timeout(this.graceMs))))
          throw new Error('Native teammate process did not exit')
      }
    })())
  }
}
