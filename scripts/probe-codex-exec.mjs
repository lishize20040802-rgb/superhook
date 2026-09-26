// Explicit Windows execution diagnostic: no model call, login, or permission repair.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'

if (process.platform !== 'win32' || !process.argv[2])
  throw new Error('Usage on Windows: node scripts/probe-codex-exec.mjs <codex.exe> [workspace]')
const executable = await realpath(resolve(process.argv[2]))
const workspace = await realpath(resolve(process.argv[3] ?? process.cwd()))
const cwd = await mkdtemp(join(workspace, '.superhook-exec-'))
const ctx = new Context()
let child
try {
  const token = randomUUID()
  await writeFile(join(cwd, 'input.txt'), token)
  await ctx.plugin(Subprocess)
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$value = Get-Content -LiteralPath 'input.txt' -Raw",
    "[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'output.txt'), $value)",
    "Write-Output 'SUPERHOOK_EXEC_OK'",
  ].join('\n')
  child = ctx.subprocess.spawn({
    argv: [
      executable,
      'sandbox',
      '-c',
      'sandbox_mode="workspace-write"',
      '--',
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      '-NoProfile',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64'),
    ],
    cwd,
    signal: AbortSignal.timeout(30000),
    graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
  })
  const outcome = await child.done
  assert.equal(
    outcome.exitCode,
    0,
    child.collected.stderr?.readFrom(0).text ?? 'Codex sandbox failed',
  )
  assert.match(child.collected.stdout?.readFrom(0).text ?? '', /SUPERHOOK_EXEC_OK/)
  assert.equal(await readFile(join(cwd, 'output.txt'), 'utf8'), token)
  console.log(JSON.stringify({ executed: true, read: true, wrote: true, modelCall: false }))
} finally {
  // Never remove the working directory until its managed execution has stopped.
  if (child && !(await child.waitForExit(AbortSignal.timeout(1000)))) {
    child.terminate()
    if (!(await child.waitForExit(AbortSignal.timeout(3000))))
      throw new Error(`Codex did not stop; diagnostic files retained in ${cwd}`)
  }
  await ctx.fiber.dispose()
  await rm(join(cwd, 'input.txt'), { force: true })
  await rm(join(cwd, 'output.txt'), { force: true })
  await rmdir(cwd)
}
