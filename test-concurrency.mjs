#!/usr/bin/env node
// test-concurrency.mjs — the HONEST multi-writer test. It spawns TWO separate server processes that
// share ONE SQLite DB file and fires concurrent writes at both. This is the case a shared JSON file
// cannot survive: two processes doing a read-then-write (op.set's version bump) would lose updates
// without SQLite's WAL + BEGIN IMMEDIATE + busy_timeout serializing them. (A single-process test would
// prove nothing here — node:sqlite is synchronous, so one process can't interleave two mutations.)
// Self-contained: seeds a scratch DB, runs, and tears both servers + the DB down. Touches no real data.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const FLAG = '--experimental-sqlite'
const node = process.execPath
const DB = join(tmpdir(), `agent-ops-conc-${process.pid}.db`)
const PORTS = [8781, 8782]
const env = p => ({ ...process.env, AGENT_OPS_DB: DB, PORT: String(p) })
const servers = []
let pass = 0, fail = 0
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n) } else { fail++; console.log('  ✗ ' + n + (e ? '  — ' + e : '')) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const post = (port, action, payload, chat) => fetch(`http://127.0.0.1:${port}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, chat }) }).then(r => r.json()).catch(e => ({ error: String(e) }))
const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`).then(r => r.json())

async function main() {
  await new Promise((res, rej) => { const c = spawn(node, [FLAG, 'seed.mjs', '--reset'], { cwd: ROOT, env: env(PORTS[0]), stdio: 'ignore' }); c.on('exit', x => x === 0 ? res() : rej(new Error('seed exit ' + x))) })
  for (const p of PORTS) servers.push(spawn(node, [FLAG, 'server.mjs'], { cwd: ROOT, env: env(p), stdio: 'ignore' }))
  for (const p of PORTS) { for (let i = 0; i < 40; i++) { try { if ((await get(p, '/health')).ok) break } catch {} await sleep(150) } }
  console.log(`  (two server processes on ${PORTS.join(', ')} sharing one DB)`)

  const N = 40
  // 1. N concurrent task.add split across BOTH processes — every insert must land with a unique id.
  const before = (await get(PORTS[0], '/tasks')).length
  const r1 = await Promise.all(Array.from({ length: N }, (_, i) => post(PORTS[i % 2], 'task.add', { title: 'c' + i, owner: 'stress', priority: 3 }, 'p' + (i % 2))))
  const ids = r1.filter(r => r.ok).map(r => r.result.id)
  ok(`${N} concurrent task.add across 2 processes all succeeded`, r1.every(r => r.ok), r1.filter(r => !r.ok).length + ' failed')
  ok('unique ids — no cross-process lost insert', new Set(ids).size === N, new Set(ids).size + '/' + N)
  ok('count grew by exactly N', (await get(PORTS[0], '/tasks')).length === before + N)

  // 2. THE key test: N concurrent op.set version bumps (a read-then-write) split across BOTH processes.
  //    Must end at exactly N+1 — every bump serialized, none lost. A JSON file would lose most of these.
  await post(PORTS[0], 'op.set', { name: '__conc', category: 'x', summary: 's', prompt: 'p', deps: [] }, 'seed')
  await Promise.all(Array.from({ length: N }, (_, i) => post(PORTS[i % 2], 'op.set', { name: '__conc', category: 'x', summary: 's', prompt: 'p' + i, deps: [] }, 'p' + (i % 2))))
  const op = await get(PORTS[0], '/op/__conc')
  ok('cross-process op.set bumps serialized, none lost', op.version === N + 1, 'version ' + op.version + ' (expected ' + (N + 1) + ')')

  // 3. N concurrent upserts to one knowledge key across both processes → exactly one row.
  await Promise.all(Array.from({ length: N }, (_, i) => post(PORTS[i % 2], 'knowledge.set', { category: '__conc', key: 'shared', value: 'v' + i }, 'p' + (i % 2))))
  const rows = await get(PORTS[0], '/knowledge?category=__conc')
  ok('concurrent cross-process upserts leave exactly one row', rows.length === 1, rows.length + ' rows')
}

main().catch(e => { fail++; console.log('  ✗ threw: ' + e.message) }).finally(async () => {
  console.log(`\n${pass} passed, ${fail} failed`)
  for (const s of servers) { try { await new Promise(res => { s.once('exit', res); try { s.kill() } catch { res() } }) } catch {} }
  for (let i = 0; i < 10; i++) { let left = false; for (const suf of ['', '-wal', '-shm']) { try { rmSync(DB + suf) } catch (e) { if (e.code !== 'ENOENT') left = true } } if (!left) break; await sleep(150) }
  process.exitCode = fail ? 1 : 0
})
