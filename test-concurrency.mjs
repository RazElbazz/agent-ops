#!/usr/bin/env node
// test-concurrency.mjs — proves the core promise: many chats writing at once, no lost updates.
// Assumes a server is running (node server.mjs). Fires bursts of concurrent POST /action and checks
// the DB ended up exactly consistent. This is the reason agent-ops exists instead of a shared JSON file.
const BASE = process.env.AGENT_OPS || 'http://localhost:8791'
let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')) } }
const get = async p => (await fetch(BASE + p)).json()
const post = (action, payload, chat) => fetch(BASE + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, chat }) }).then(r => r.json())

const N = 60
try {
  // 1. N concurrent task.add from N different "chats" — every write must land, each with a unique id.
  const before = (await get('/tasks')).length
  const results = await Promise.all(Array.from({ length: N }, (_, i) => post('task.add', { title: 'conc-' + i, owner: 'stress', priority: 3 }, 'chat-' + i)))
  const ids = results.filter(r => r.ok).map(r => r.result.id)
  ok(`${N} concurrent task.add all succeeded`, results.every(r => r.ok), results.filter(r => !r.ok).length + ' failed')
  ok('every insert got a unique id (no lost update)', new Set(ids).size === N, new Set(ids).size + ' distinct of ' + N)
  const after = (await get('/tasks')).length
  ok('task count grew by exactly N', after === before + N, `before ${before}, after ${after}`)

  // 2. N concurrent knowledge.set to the SAME key — upsert must leave exactly one row (last write wins, no dupes).
  await Promise.all(Array.from({ length: N }, (_, i) => post('knowledge.set', { category: '__conc', key: 'shared', value: 'v' + i }, 'chat-' + i)))
  const rows = await get('/knowledge?category=__conc')
  ok('concurrent upserts to one key leave exactly one row', rows.length === 1, rows.length + ' rows')

  // 3. N concurrent op.set to the same op — version must end at exactly N (every bump counted, none lost).
  await post('op.set', { name: '__conc.op', category: 'x', summary: 's', prompt: 'p', deps: [] }, 'seed') // v1
  await Promise.all(Array.from({ length: N }, (_, i) => post('op.set', { name: '__conc.op', category: 'x', summary: 's', prompt: 'p' + i, deps: [] }, 'chat-' + i)))
  const op = await get('/op/__conc.op')
  ok('concurrent op.set version bumps are not lost', op.version === N + 1, 'version ' + op.version + ' (expected ' + (N + 1) + ')')

  // cleanup
  await Promise.all(ids.map(id => post('task.del', { id }, 'cleanup')))
  for (const r of rows) await post('knowledge.del', { id: r.id }, 'cleanup')
  await post('op.del', { name: '__conc.op' }, 'cleanup')
} catch (e) { fail++; console.log('  ✗ threw: ' + e.message + '  (is the server running?)') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
