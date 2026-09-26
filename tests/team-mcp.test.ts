import assert from 'node:assert/strict'
import test from 'node:test'
import { serveTeamTools } from '../src/team-mcp.ts'
import { boot } from './support.ts'

test('native MCP is scoped, authenticated, guarded and inactive outside a turn', async (t) => {
  const { ctx, owner } = await boot(t, true)
  const mcp = await serveTeamTools(ctx, owner.agent)
  t.after(() => mcp.dispose())
  const headers = {
    Authorization: `Bearer ${mcp.endpoint.token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  const request = (method: string, params: object) =>
    fetch(mcp.endpoint.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }).then((response) => response.json())
  assert.equal((await fetch(mcp.endpoint.url, { method: 'POST' })).status, 403)
  assert.equal(
    (
      await fetch(mcp.endpoint.url, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://untrusted.example' },
      })
    ).status,
    403,
  )
  const listing = await request('tools/list', {})
  assert.ok(listing.result.tools.some((tool: { name: string }) => tool.name === 'send_message'))
  assert.ok(!listing.result.tools.some((tool: { name: string }) => tool.name === 'superhook_run'))
  const args = {
    name: 'team_task_create',
    arguments: { subject: 'Scoped task', description: 'Test' },
  }
  assert.ok((await request('tools/call', args)).error)
  mcp.enter(new AbortController().signal)
  const removeGuard = ctx.tools.guard((execution) =>
    execution.name === 'team_task_create' ? 'Denied by deployment' : undefined,
  )
  assert.equal((await request('tools/call', args)).result.isError, true)
  assert.equal(ctx.agentTeams.listTasks(owner.agent).length, 0)
  removeGuard()
  assert.equal((await request('tools/call', args)).result.isError, false)
  assert.equal(ctx.agentTeams.listTasks(owner.agent).length, 1)
  assert.ok((await request('tools/call', { name: 'superhook_run', arguments: {} })).error)
  await mcp.leave()
  assert.ok((await request('tools/call', args)).error)
  assert.equal(ctx.agentTeams.listTasks(owner.agent).length, 1)
})
