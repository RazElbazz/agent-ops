#!/usr/bin/env node
// test.mjs — smoke test. Starts nothing; assumes the server is running (node server.mjs).
//   node test.mjs
const BASE = process.env.AGENT_OPS || 'http://localhost:8791'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) } }
const get = async p => (await fetch(BASE + p)).json()
const post = async (action, payload) => (await fetch(BASE + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, chat: 'test' }) })).json()
const rawPost = bodyStr => fetch(BASE + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr }).then(r => r.status).catch(() => 0)

try {
  const h = await get('/health'); ok('health responds ok', h.ok === true)
  const m = await get('/manifest'); ok('manifest has protocol', typeof m.protocol === 'string' && m.protocol.length > 0)
  ok('manifest lists operations', Array.isArray(m.operations))
  if (m.operations.length) { const o = await get('/op/' + encodeURIComponent(m.operations[0].name)); ok('op returns prompt + deps', typeof o.prompt === 'string' && Array.isArray(o.deps)) }
  ok('knowledge query works', Array.isArray(await get('/knowledge')))
  const before = (await get('/tasks')).length
  const add = await post('task.add', { title: 'smoke-test task', owner: 'test', priority: 3 }); ok('action task.add is atomic + returns id', add.ok && add.result.id)
  const after = (await get('/tasks')).length; ok('task persisted', after === before + 1)
  await post('task.del', { id: add.result.id }); ok('task.del cleans up', (await get('/tasks')).length === before)
  const ui = await get('/ui'); ok('ui config endpoint responds', ui && typeof ui === 'object' && !Array.isArray(ui))
  ok('unknown action rejected', (await post('nope.nope', {})).error !== undefined)
  ok('missing required field rejected', (await post('task.add', {})).error !== undefined)
  ok('root-cause endpoint responds', typeof (await get('/root-cause')).failingTraces === 'number')
  ok('search endpoint responds', Array.isArray((await get('/search?q=a')).operations))
  const lintR = await get('/lint'); ok('lint reports graph integrity', typeof lintR.ok === 'boolean' && Array.isArray(lintR.missingDeps))
  const st = await get('/stats'); ok('stats reports usage', Array.isArray(st.runsByOp) && st.totals && typeof st.totals.operations === 'number')
  const ex = await get('/export'); ok('export returns the system definition', Array.isArray(ex.operations) && Array.isArray(ex.knowledge))
  const imp = await post('import.bundle', { knowledge: [{ category: '__test', key: 'roundtrip', value: 'ok' }] }); ok('import.bundle upserts', imp.ok && imp.result.knowledge === 1)
  const found = (await get('/knowledge?category=__test')).find(k => k.key === 'roundtrip'); ok('imported knowledge is queryable', !!found)
  if (found) await post('knowledge.del', { id: found.id }) // cleanup the test entry

  // --- regressions for the audit findings (must all hold) ---
  const missingStatus = (await fetch(BASE + '/public/nope-does-not-exist.txt')).status
  ok('missing static file returns 404 (no crash)', missingStatus === 404)
  ok('server survived the missing-file request', (await get('/health')).ok === true) // finding #1: process must NOT die
  ok('null JSON body is 400 (not 500)', (await rawPost('null')) === 400) // finding #5
  ok('bad percent-encoding is 404 (not 500)', (await fetch(BASE + '/op/%E0%A4%A')).status === 404) // finding #6
  ok('ui.set with only key does not 500', (await post('ui.set', { key: '__uitest' })).ok === true) // finding #4
  const badBundle = await post('import.bundle', { knowledge: [{ category: '__ib', key: 'good', value: 'v' }, { category: '__ib', key: 'bad' }] }) // finding #3
  ok('import.bundle is partial-safe (good applied, bad skipped)', badBundle.ok && badBundle.result.knowledge === 1 && (badBundle.result.skipped || []).length === 1)
  ok('import.bundle kept the valid item', !!(await get('/knowledge?category=__ib')).find(k => k.key === 'good'))
  for (const k of (await get('/knowledge?category=__ib'))) await post('knowledge.del', { id: k.id }) // cleanup
} catch (e) { fail++; console.log('  ✗ threw: ' + e.message + '  (is the server running?)') }

console.log(`\n${pass} passed, ${fail} failed`)
// Set the exit code and let the loop drain (undici keep-alive sockets close on their own).
// Avoid process.exit() here: forcing exit while sockets are mid-teardown trips a libuv assertion on Windows.
process.exitCode = fail ? 1 : 0
