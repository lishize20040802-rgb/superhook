/** Model-input validation and deterministic dependency ordering. */
import type { Limits, Task } from './types.ts'

/** Validate the entire plan before any provider starts, then sort dependencies first.
 * @param tasks - Model-supplied assignments.
 * @param limits - Deployment limits and provider allowlist.
 * @returns A stable topological ordering.
 */
export function orderPlan(tasks: readonly Task[], limits: Limits): Task[] {
  if (tasks.length === 0 || tasks.length > limits.maxTasks) {
    throw new Error(`Provide between 1 and ${limits.maxTasks} tasks`)
  }
  if (Buffer.byteLength(JSON.stringify(tasks)) > limits.maxPlanBytes) {
    throw new Error('Team plan exceeds maxPlanBytes')
  }
  const byId = new Map<string, Task>()
  for (const task of tasks) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(task.id) || byId.has(task.id)) {
      throw new Error('Task ids must be unique, 1–64 letters, digits, underscores or hyphens')
    }
    if (!limits.providers.includes(task.provider))
      throw new Error(`Provider is not enabled: ${task.provider}`)
    if (!task.prompt.trim()) throw new Error(`Task ${task.id} has an empty prompt`)
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      throw new Error(`Task ${task.id} repeats a dependency`)
    byId.set(task.id, task)
  }
  for (const task of tasks) {
    if (task.dependsOn.some((id) => !byId.has(id)))
      throw new Error(`Task ${task.id} has an unknown dependency`)
  }
  const ordered: Task[] = []
  const remaining = new Map(byId)
  const done = new Set<string>()
  while (remaining.size) {
    const ready = [...remaining.values()].find((task) => task.dependsOn.every((id) => done.has(id)))
    if (!ready) throw new Error('Team plan contains a dependency cycle')
    ordered.push(ready)
    done.add(ready.id)
    remaining.delete(ready.id)
  }
  return ordered
}
