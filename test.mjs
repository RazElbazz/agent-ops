#!/usr/bin/env node
// test.mjs — smoke test. Starts nothing; assumes the server is running (node server.mjs).
//   node test.mjs
const BASE = process.env.AGENT_OPS || 'http://localhost:8791'
let pass = 0, fail = 0
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) } }
const get = async p => (await fetch(BASE + p)).json()
const post = async (action, payload) => (await fetch(BASE + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, chat: 'test' }) })).json()

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
  const ui = await get('/ui'); ok('ui config present', ui && 'title' in ui)
  ok('unknown action rejected', (await post('nope.nope', {})).error !== undefined)
  ok('missing required field rejected', (await post('task.add', {})).error !== undefined)
  ok('root-cause endpoint responds', typeof (await get('/root-cause')).failingTraces === 'number')
  ok('search endpoint responds', Array.isArray((await get('/search?q=a')).operations))
} catch (e) { fail++; console.log('  ✗ threw: ' + e.message + '  (is the server running?)') }

console.log(`\n${pass} passed, ${fail} failed`)
// Set the exit code and let the loop drain (undici keep-alive sockets close on their own).
// Avoid process.exit() here: forcing exit while sockets are mid-teardown trips a libuv assertion on Windows.
process.exitCode = fail ? 1 : 0
