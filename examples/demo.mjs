#!/usr/bin/env node
// examples/demo.mjs — a full, runnable walkthrough of the agent-ops protocol.
//   node examples/demo.mjs
// It spins up an ISOLATED server (its own scratch DB on a temp path, port 8799), seeds the generic
// example data, then role-plays an agent doing one task end-to-end, printing each protocol step:
//   bootstrap (manifest) -> pull an operation + its deps recursively -> pull knowledge -> "execute"
//   -> log a trace (one failing) -> GET /root-cause -> fix the operation via op.set (version bumps).
// Nothing here touches your real data.db. When it finishes it kills the server and deletes the scratch DB.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = 8799
const BASE = `http://localhost:${PORT}`
const DB = join(tmpdir(), `agent-ops-demo-${process.pid}.db`)
const env = { ...process.env, AGENT_OPS_DB: DB, PORT: String(PORT) }
const node = process.execPath
const h = s => `\n\x1b[1m\x1b[36m${s}\x1b[0m` // bold cyan section header
const dim = s => `\x1b[2m${s}\x1b[0m`
const sh = (args) => new Promise((res, rej) => { const c = spawn(node, args, { cwd: ROOT, env, stdio: 'ignore' }); c.on('exit', code => code === 0 ? res() : rej(new Error(args.join(' ') + ' exited ' + code))) })
const get = async p => (await fetch(BASE + p)).json()
const post = (action, payload, chat = 'demo') => fetch(BASE + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, chat }) }).then(r => r.json())

let server
async function main() {
  console.log(dim(`(isolated demo: scratch DB ${DB}, port ${PORT} — your real data is untouched)`))
  await sh(['seed.mjs', '--reset'])                              // seed generic examples into the scratch DB
  server = spawn(node, ['server.mjs'], { cwd: ROOT, env, stdio: 'ignore' })
  for (let i = 0; i < 30; i++) { try { if ((await get('/health')).ok) break } catch {} await new Promise(r => setTimeout(r, 150)) }

  console.log(h('1. Bootstrap — the agent reads the manifest to learn how to work here'))
  const m = await get('/manifest')
  console.log(m.protocol.split('\n').map(l => '   ' + l).join('\n'))
  console.log(dim(`   operations available: ${m.operations.map(o => o.name).join(', ')}`))

  console.log(h('2. Pull the operation for the task ("run an outreach batch") + its deps, recursively'))
  const seen = new Set()
  async function pull(name, depth = 0) {
    if (seen.has(name)) return; seen.add(name)
    const op = await get('/op/' + encodeURIComponent(name))
    console.log(`   ${'  '.repeat(depth)}• ${op.name} (v${op.version}) — ${op.summary}`)
    console.log(dim(`   ${'  '.repeat(depth)}  prompt: ${op.prompt.slice(0, 90)}...`))
    for (const d of op.deps) { console.log(dim(`   ${'  '.repeat(depth)}  depends on -> ${d}`)); await pull(d, depth + 1) }
  }
  await pull('outreach.batch')

  console.log(h('3. Pull the knowledge those operations reference (facts/rules, by category)'))
  for (const c of ['outreach', 'voice', 'format']) { const k = await get('/knowledge?category=' + c); k.forEach(x => console.log(`   [${x.category}] ${x.key}: ${dim(x.value.slice(0, 70) + '...')}`)) }

  console.log(h('4. Execute per those prompts, then log a trace of the chain (this one FAILS)'))
  await post('trace.add', { op: 'outreach.batch', chain: ['lead.find', 'draft.message'], status: 'fail', note: 'draft.message ignored voice.tone; messages sounded generic' })
  console.log(dim('   POST /action trace.add {op:"outreach.batch", chain:["lead.find","draft.message"], status:"fail", note:"..."}'))

  console.log(h('5. Root-cause — ask the API which operation is breaking the chain'))
  const rc = await get('/root-cause')
  console.log(`   likely culprit: \x1b[33m${rc.likelyCulprit.operation}\x1b[0m  (${rc.likelyCulprit.hint})`)

  console.log(h('6. Self-improve — fix that operation via op.set (version bumps automatically)'))
  const before = await get('/op/draft.message')
  await post('op.set', { name: 'draft.message', category: 'writing', summary: before.summary,
    prompt: before.prompt + ' ALWAYS open by pulling knowledge voice.tone and mirror it exactly; never send generic copy.', deps: before.deps })
  const after = await get('/op/draft.message')
  console.log(`   draft.message prompt improved: v${before.version} -> \x1b[32mv${after.version}\x1b[0m`)

  console.log(h('Done.') + ' That is the whole loop: pull → act → trace → root-cause → improve. ' + dim('Every step was a plain HTTP call any agent can make.\n'))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function cleanup() {
  if (server) { await new Promise(res => { server.once('exit', res); try { server.kill() } catch { res() } }) }
  // Windows holds the file briefly after exit; retry a few times.
  for (let i = 0; i < 10; i++) { let left = false; for (const suf of ['', '-wal', '-shm']) { try { rmSync(DB + suf) } catch (e) { if (e.code !== 'ENOENT') left = true } } if (!left) break; await sleep(150) }
}
main().catch(e => console.error('demo error:', e.message)).finally(() => cleanup().finally(() => process.exit(0)))
