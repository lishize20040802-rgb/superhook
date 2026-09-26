/** Optional bridge: official team members delegate their claimed board tasks to external agents. */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TeamTaskId } from '@deepseek-ai/dsh-experimental-agent-team'

export const name = 'superhook-agent-team'
export const inject = ['tools', 'agentTeams']

/** Register the optional bridge without creating a second roster or task board.
 * @param ctx - Official team service and guarded tool execution.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'superhook_team_task',
      description:
        'Claim a ready pending task from the official Agent Teams board, delegate its description to an external agent, and complete the task only on success. The calling team member remains the owner. Failures leave the task in progress for inspection and explicit release using official team tools. The external agent is a one-shot worker, not a persistent teammate. Requires superhook_run.',
      parameters: {
        task_id: {
          type: 'string',
          required: true,
          description: 'Official board task id, such as task-1.',
        },
        expected_revision: {
          type: 'number',
          required: true,
          description: 'Current board revision; stale revisions are rejected.',
        },
        provider: {
          type: 'string',
          required: true,
          description: 'Enabled provider from superhook_agents.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            revision: { type: 'number', required: true },
            result: { type: 'json', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error('An official team member must call this tool')
        if (!ctx.tools.get('superhook_run', parent))
          throw new Error('Load Superhook in this agent preset first')
        if (
          !/^task-[1-9]\d*$/.test(args.task_id) ||
          !Number.isSafeInteger(args.expected_revision) ||
          args.expected_revision < 1
        ) {
          throw new Error('Provide a valid official task id and positive integer revision')
        }
        exec.signal.throwIfAborted()
        const taskId = TeamTaskId(args.task_id)
        const task = ctx.agentTeams.getTask(parent, taskId)
        if (task.status !== 'pending' || !task.ready)
          throw new Error('Official task must be pending with completed dependencies')
        const claimed = await ctx.agentTeams.updateTask(parent, {
          taskId,
          expectedRevision: args.expected_revision,
          action: 'claim',
        })
        const result = await ctx.tools.execute({
          callId: ToolCallId(`${exec.callId}:superhook`),
          rootCallId: exec.rootCallId,
          parent: exec.token,
          agent: parent,
          name: 'superhook_run',
          signal: exec.signal,
          arguments: {
            tasks: [
              {
                id: taskId,
                provider: args.provider,
                prompt: `${claimed.subject}\n\n${claimed.description}\n\nAdvisory write scopes: ${JSON.stringify(claimed.writeScopes)}`,
                dependsOn: [],
              },
            ],
          },
        })
        if (result.isError)
          throw new Error(
            'Delegation failed; official task remains in progress. Inspect the workspace before releasing it.',
          )
        const value = result.value
        const succeeded =
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          value.status === 'completed'
        exec.signal.throwIfAborted()
        const updated = succeeded
          ? await ctx.agentTeams.updateTask(parent, {
              taskId,
              expectedRevision: claimed.revision,
              action: 'complete',
            })
          : ctx.agentTeams.getTask(parent, taskId)
        return { taskId, status: updated.status, revision: updated.revision, result: value }
      },
    }),
  )
}
