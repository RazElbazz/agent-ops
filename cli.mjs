#!/usr/bin/env node
// cli.mjs — a tiny terminal client for the agent-ops API. Handy for humans and scripts.
//   node cli.mjs manifest
//   node cli.mjs ops
//   node cli.mjs op <name>
//   node cli.mjs kn [category] [query]
//   node cli.mjs tasks
//   node cli.mjs do <action> '<json-payload>'      e.g. do task.add '{"title":"hi","owner":"me","priority":1}'
const BASE = process.env.AGENT_OPS || 'http://127.0.0.1:8791'
const [, , cmd, a, b] = process.argv
const get = async p => (await fetch(BASE + p)).json()
const post = async (action, payload) => (await fetch(BASE + '/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, chat: 'cli' }) })).json()
const out = o => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2))

try {
  if (cmd === 'manifest') out(await get('/manifest'))
  else if (cmd === 'ops') (await get('/ops')).forEach(o => console.log(`  ${o.name}  (v${o.version})  ${o.summary}`))
  else if (cmd === 'op') out(await get('/op/' + encodeURIComponent(a)))
  else if (cmd === 'kn') (await get('/knowledge?' + (a ? 'category=' + encodeURIComponent(a) : '') + (b ? '&q=' + encodeURIComponent(b) : ''))).forEach(k => console.log(`  [${k.category}] ${k.key}: ${k.value}`))
  else if (cmd === 'tasks') (await get('/tasks')).filter(t => t.status !== 'done').forEach(t => console.log(`  P${t.priority} [${t.owner}] ${t.title}  ${t.deadline || ''}`))
  else if (cmd === 'export') out(await get('/export'))
  else if (cmd === 'search') out(await get('/search?q=' + encodeURIComponent(a || '')))
  else if (cmd === 'root-cause') out(await get('/root-cause'))
  else if (cmd === 'lint') out(await get('/lint'))
  else if (cmd === 'stats') out(await get('/stats'))
  else if (cmd === 'do') out(await post(a, JSON.parse(b || '{}')))
  else console.log('usage: manifest | ops | op <name> | kn [cat] [q] | tasks | search <q> | root-cause | lint | stats | export | do <action> \'<json>\'')
} catch (e) { console.error('error:', e.message, '\n(is the server running? node server.mjs)') }
