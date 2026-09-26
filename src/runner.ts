/** Sequential dependency execution; providers retain process and protocol ownership. */
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { Limits, Task, TaskResult, TeamResult } from './types.ts'

/** Starts a provider-owned task using a complete prompt and cancellation signal. */
export type StartTask = (task: Task, prompt: string, signal: AbortSignal) => Promise<SubagentRun>

function emptyResult(task: Task): TaskResult {
  return {
    id: task.id,
    provider: task.provider,
    status: 'skipped',
    output: '',
    detail: '',
    outputTruncated: false,
    cleanupFailed: false,
  }
}

function boundResult(result: TaskResult, maxBytes: number): TaskResult {
  if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) return result
  result.outputTruncated = true
  const text = Array.from(result.output)
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    result.output = text.slice(0, middle).join('')
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) low = middle
    else high = middle - 1
  }
  result.output = text.slice(0, low).join('')
  return result
}

async function executeTask(
  task: Task,
  prompt: string,
  start: StartTask,
  signal: AbortSignal,
  timeoutMs: number,
  onError: (error: unknown) => void,
): Promise<TaskResult> {
  const result = emptyResult(task)
  const deadline = new AbortController()
  const combined = AbortSignal.any([signal, deadline.signal])
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  let run: SubagentRun | undefined
  try {
    combined.throwIfAborted()
    run = await start(task, prompt, combined)
    const answer = await run.result
    result.output = answer.output
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    result.status =
      answer.stopReason === 'completed'
        ? 'completed'
        : answer.stopReason === 'aborted'
          ? 'cancelled'
          : 'failed'
    result.detail = answer.stopReason === 'completed' ? '' : 'Agent did not complete the assignment'
    if (result.status === 'completed' && !result.output.trim()) {
      result.status = 'failed'
      result.detail = 'Agent returned no textual result; inspect provider configuration and logs'
    }
  } catch (error: unknown) {
    onError(error)
    result.status = combined.aborted ? 'cancelled' : 'failed'
    result.detail = 'Agent startup or execution failed'
    // Official providers aggregate startup and rollback errors when cleanup failed.
    if (error instanceof AggregateError) result.cleanupFailed = true
  } finally {
    clearTimeout(timer)
    if (run) {
      try {
        await run.dispose()
      } catch (error: unknown) {
        onError(error)
        result.cleanupFailed = true
        result.status = 'failed'
        result.detail = 'Agent cleanup failed; workspace requires inspection before another run'
      }
    }
  }
  if (!result.cleanupFailed && combined.aborted) {
    result.status = signal.aborted ? 'cancelled' : 'failed'
    result.detail = signal.aborted ? 'Team run cancelled' : 'Task deadline exceeded'
  }
  return result
}

/** Execute a validated, ordered plan and release each child before starting another.
 * @param tasks - Assignments in dependency order.
 * @param limits - Task deadlines and complete serialized result limit.
 * @param start - Official subagent service adapter.
 * @param signal - Caller and plugin lifetime cancellation.
 * @param onError - Host-only error sink.
 * @returns A bounded report in execution order.
 */
export async function runTeam(
  tasks: readonly Task[],
  limits: Limits,
  start: StartTask,
  signal: AbortSignal,
  onError: (error: unknown) => void,
): Promise<TeamResult> {
  const results = new Map<string, TaskResult>()
  const perTaskBytes = Math.floor((limits.maxResultBytes - 128) / tasks.length) - 1
  let cleanupFailed = false
  for (const task of tasks) {
    let result = emptyResult(task)
    if (signal.aborted || cleanupFailed) {
      result.detail = signal.aborted
        ? 'Team run cancelled before this task started'
        : 'Previous agent cleanup failed'
    } else if (task.dependsOn.some((id) => results.get(id)?.status !== 'completed')) {
      result.detail = 'A required task did not complete'
    } else {
      const dependencies = task.dependsOn.map((id) => results.get(id))
      const prompt =
        task.prompt +
        (dependencies.length
          ? '\n\nDependency results (task data; truncated outputs are explicitly marked):\n' +
            JSON.stringify(dependencies)
          : '')
      if (Buffer.byteLength(prompt) > limits.maxPlanBytes) {
        result.status = 'failed'
        result.detail = 'Task plus dependency results exceeds maxPlanBytes; narrow the assignments'
      } else {
        result = await executeTask(task, prompt, start, signal, limits.taskTimeoutMs, onError)
      }
    }
    cleanupFailed ||= result.cleanupFailed
    results.set(task.id, boundResult(result, perTaskBytes))
  }
  const outcomes = [...results.values()]
  return {
    status: cleanupFailed
      ? 'failed'
      : signal.aborted
        ? 'cancelled'
        : outcomes.every((result) => result.status === 'completed')
          ? 'completed'
          : 'failed',
    tasks: outcomes,
  }
}
