/** One self-contained assignment and the results it consumes. */
export interface Task {
  readonly id: string
  readonly provider: string
  readonly prompt: string
  readonly dependsOn: readonly string[]
}

/** Deployment-owned execution and size limits. */
export interface Limits {
  readonly providers: readonly string[]
  readonly maxTasks: number
  readonly taskTimeoutMs: number
  readonly maxPlanBytes: number
  readonly maxResultBytes: number
}

/** Task outcomes preserve partial answers separately from successful completion. */
export interface TaskResult {
  id: string
  provider: string
  status: 'completed' | 'failed' | 'cancelled' | 'skipped'
  output: string
  detail: string
  outputTruncated: boolean
  cleanupFailed: boolean
}

/** Ordered report, including tasks that never started. */
export interface TeamResult {
  status: 'completed' | 'failed' | 'cancelled'
  tasks: TaskResult[]
}
/** Deployment-owned native teammate routes. Login stays inside each CLI. */
export interface NativeProviderConfig {
  name: string
  protocol: 'codex' | 'acp'
  command: string
  args: string[]
  env?: Record<string, string>
  model?: string
  authMethod?: string
  permission?: 'reject' | 'review' | 'allow'
}

export interface TeammatesConfig {
  providers: NativeProviderConfig[]
  stateDirectory: string
  startupTimeoutMs?: number
  turnTimeoutMs?: number
  disposeGraceMs?: number
  maxOutputBytes?: number
  maxSessions?: number
}

export interface NativeState {
  version: 1
  fingerprint: string
  nativeId: string
  messageIds: string[]
}

export interface NativeEndpoint {
  url: string
  token: string
}
