#!/usr/bin/env node
// bin/agent-ops.mjs — launcher so `npx agent-ops` (or `npx github:RazElbazz/agent-ops`) just works.
// node:sqlite needs --experimental-sqlite on Node 22.x (no-op on 24+). If this process wasn't started
// with the flag, re-exec ourselves with it, then run the server.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const server = join(ROOT, 'server.mjs')
const hasFlag = process.execArgv.some(a => a.includes('experimental-sqlite'))

if (hasFlag) {
  await import(server) // already flagged — just run the server in-process
} else {
  const child = spawn(process.execPath, ['--experimental-sqlite', server, ...process.argv.slice(2)], { stdio: 'inherit' })
  child.on('exit', code => process.exit(code ?? 0))
}
