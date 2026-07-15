// server.mjs — agent-ops API. Zero-dep Node HTTP. The single coordination point for all chats.
//   Reads:  GET /manifest · /op/:name · /ops · /knowledge?category=&q=&tag= · /component/:name · /components
//           /tasks · /records?component=&type= · /log · /traces?op= · /search?q= · /root-cause?op= · /ui · /health
//   Writes: POST /action {action, payload, chat}  -> ONE atomic gateway (transaction + audit log).
//           actions: task.add|task.update|task.done|task.del · knowledge.set · op.set · component.set
//                    record.add · trace.add
// Run:  node server.mjs   (if node:sqlite asks for a flag: node --experimental-sqlite server.mjs)
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { all, get, run, tx, nowISO } from './lib/db.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8791
const today = () => new Date().toISOString().slice(0, 10)

const PROTOCOL = [
  'agent-ops protocol (the whole rulebook):',
  '1. On any task, GET /manifest to see the current components, operations, and how to work here.',
  '2. GET /op/<name> for the operation you need: it returns its prompt (how to do it) and deps (other operations it needs). Pull deps recursively.',
  '3. GET /knowledge?category=<c> for the facts/rules that operation needs.',
  '4. Execute per those prompts. Everything is pulled fresh, so it is always current.',
  '5. Send every mutation as POST /action {action, payload, chat} (atomic + logged). Never write state any other way.',
  '6. Log a trace of the chain via action trace.add {op,chain,status,note}. When a chain fails, GET /root-cause to see which operation ends failing chains most; read that op, fix its prompt, and POST /action op.set (bumps version). This is the self-improvement loop.',
  'Discovery: GET /search?q=<term> matches across operations, knowledge, and components.',
].join('\n')

// ---- atomic action gateway ----
const ACTIONS = {
  'task.add': p => { const r = run('INSERT INTO tasks (title,owner,stream,priority,status,deadline,due_when,note,dep,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [p.title, p.owner || 'claude', p.stream || 'ops', p.priority || 2, 'todo', p.deadline || null, p.due_when || null, p.note || null, p.dep || null, today()]); return { id: Number(r.lastInsertRowid) } },
  'task.update': p => { const f = [], v = []; for (const k of ['title', 'owner', 'stream', 'priority', 'status', 'deadline', 'due_when', 'note', 'dep']) if (k in p) { f.push(k + '=?'); v.push(p[k]) } if (!f.length) return { ok: true }; v.push(p.id); run('UPDATE tasks SET ' + f.join(',') + ' WHERE id=?', v); return { ok: true } },
  'task.done': p => { run('UPDATE tasks SET status=?, done_on=? WHERE id=?', ['done', today(), p.id]); return { ok: true } },
  'task.del': p => { run('DELETE FROM tasks WHERE id=?', [p.id]); return { ok: true } },
  'knowledge.set': p => { const ex = get('SELECT id FROM knowledge WHERE category=? AND key=?', [p.category, p.key]);
      if (ex) { run('UPDATE knowledge SET value=?, tags=?, updated_at=? WHERE id=?', [p.value, p.tags || '', nowISO(), ex.id]); return { id: ex.id, updated: true } }
      const r = run('INSERT INTO knowledge (category,key,value,tags,updated_at) VALUES (?,?,?,?,?)', [p.category, p.key, p.value, p.tags || '', nowISO()]); return { id: Number(r.lastInsertRowid) } },
  'op.set': p => { const ex = get('SELECT version FROM operations WHERE name=?', [p.name]); const ver = ex ? ex.version + 1 : 1;
      run('INSERT INTO operations (name,category,summary,prompt,deps,version,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET category=excluded.category,summary=excluded.summary,prompt=excluded.prompt,deps=excluded.deps,version=excluded.version,updated_at=excluded.updated_at',
        [p.name, p.category || '', p.summary || '', p.prompt || '', JSON.stringify(p.deps || []), ver, nowISO()]); return { name: p.name, version: ver } },
  'component.set': p => { run('INSERT INTO components (name,category,description,operations,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET category=excluded.category,description=excluded.description,operations=excluded.operations,updated_at=excluded.updated_at',
        [p.name, p.category || '', p.description || '', JSON.stringify(p.operations || []), nowISO()]); return { name: p.name } },
  'record.add': p => { const r = run('INSERT INTO records (component,type,data,created) VALUES (?,?,?,?)', [p.component, p.type || '', JSON.stringify(p.data || {}), today()]); return { id: Number(r.lastInsertRowid) } },
  'trace.add': p => { const r = run('INSERT INTO traces (ts,chat,op,chain,input,output,status,note) VALUES (?,?,?,?,?,?,?,?)',
      [nowISO(), p.chat || '', p.op || '', JSON.stringify(p.chain || []), JSON.stringify(p.input ?? null), JSON.stringify(p.output ?? null), p.status || '', p.note || '']); return { id: Number(r.lastInsertRowid) } },
  'ui.set': p => { run('INSERT INTO ui (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [p.key, JSON.stringify(p.value), nowISO()]); return { key: p.key } },
  'knowledge.del': p => { run('DELETE FROM knowledge WHERE id=?', [p.id]); return { ok: true } },
  'op.del': p => { run('DELETE FROM operations WHERE name=?', [p.name]); return { ok: true } },
  'component.del': p => { run('DELETE FROM components WHERE name=?', [p.name]); return { ok: true } },
  'record.del': p => { run('DELETE FROM records WHERE id=?', [p.id]); return { ok: true } },
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(JSON.stringify(obj)) }
async function body(req) { let b = ''; for await (const c of req) b += c; try { return JSON.parse(b || '{}') } catch { return {} } }
const opRow = r => r ? ({ ...r, deps: safeJSON(r.deps, []) }) : null
const safeJSON = (s, d) => { try { return JSON.parse(s) } catch { return d } }

// Analytic root-cause: read the trace log, find failing chains, and point at the operation
// that most often breaks them (the last step reached in a failing chain = the likely culprit).
const isFail = s => !!s && !/^(ok|success|pass|done|complete|good)/i.test(String(s))
function rootCause(opFilter) {
  const rows = all('SELECT * FROM traces' + (opFilter ? ' WHERE op=?' : '') + ' ORDER BY id DESC LIMIT 500', opFilter ? [opFilter] : [])
    .map(t => ({ ...t, chain: safeJSON(t.chain, []) }))
  const fails = rows.filter(t => isFail(t.status))
  const byOp = {}, byStep = {}, byCulprit = {}
  for (const t of fails) {
    const o = byOp[t.op] || (byOp[t.op] = { op: t.op, fails: 0, lastNote: t.note, lastOutput: safeJSON(t.output, t.output), lastChain: t.chain, lastTs: t.ts })
    o.fails++
    for (const step of (t.chain.length ? t.chain : [t.op])) byStep[step] = (byStep[step] || 0) + 1
    const culprit = t.chain.length ? t.chain[t.chain.length - 1] : t.op // where the chain stopped
    byCulprit[culprit] = (byCulprit[culprit] || 0) + 1
  }
  const rank = obj => Object.entries(obj).map(([name, n]) => ({ name, fails: n })).sort((a, b) => b.fails - a.fails)
  // Score each step: ending a failing chain is the strongest signal (x2); merely appearing in one is weaker (x1).
  const names = new Set([...Object.keys(byCulprit), ...Object.keys(byStep)])
  const suspects = [...names].map(name => ({ name, endedChain: byCulprit[name] || 0, inFailingChains: byStep[name] || 0, score: (byCulprit[name] || 0) * 2 + (byStep[name] || 0) })).sort((a, b) => b.score - a.score)
  const top = suspects[0]
  return {
    totalTraces: rows.length, failingTraces: fails.length,
    likelyCulprit: top ? { operation: top.name, score: top.score, endedChain: top.endedChain, inFailingChains: top.inFailingChains,
      hint: `Operation "${top.name}" is the strongest suspect (ends ${top.endedChain} failing chains, appears in ${top.inFailingChains}). GET /op/${encodeURIComponent(top.name)}, read its prompt, fix it, then POST /action op.set (bumps version).` } : null,
    culpritRanking: suspects,
    stepFailureCounts: rank(byStep),
    perOperation: Object.values(byOp).sort((a, b) => b.fails - a.fails),
    recentFailures: fails.slice(0, 15).map(t => ({ ts: t.ts, op: t.op, chain: t.chain, status: t.status, note: t.note })),
  }
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const q = u.searchParams
    if (req.method === 'OPTIONS') return send(res, 204, {})

    // static UI
    if (p === '/' || p === '/index.html') { try { return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await readFile(join(ROOT, 'public', 'index.html'))) } catch { return send(res, 200, { ok: 'agent-ops', hint: 'no UI yet; use /manifest' }) } }
    if (p.startsWith('/public/')) { const safe = p.replace(/\.\./g, '').slice(1); const type = { '.js': 'text/javascript', '.css': 'text/css' }[extname(p)] || 'text/plain'; try { return res.writeHead(200, { 'Content-Type': type }).end(await readFile(join(ROOT, safe))) } catch { return send(res, 404, { error: 'not found' }) } }

    // ---- reads ----
    if (p === '/manifest' && req.method === 'GET') {
      return send(res, 200, {
        name: 'agent-ops', protocol: PROTOCOL,
        components: all('SELECT name,category,description FROM components ORDER BY category,name'),
        operations: all('SELECT name,category,summary,version FROM operations ORDER BY category,name'),
        knowledgeCategories: all('SELECT category, COUNT(*) n FROM knowledge GROUP BY category ORDER BY category'),
        counts: { tasks: get('SELECT COUNT(*) n FROM tasks').n, records: get('SELECT COUNT(*) n FROM records').n },
        endpoints: {
          reads: ['/manifest', '/op/:name', '/ops', '/knowledge?category=&q=&tag=', '/component/:name', '/components', '/tasks', '/records?component=&type=', '/traces?op=', '/root-cause?op=', '/search?q=', '/log', '/ui', '/health'],
          write: 'POST /action {action, payload, chat} — the one atomic gateway',
          actions: Object.keys(ACTIONS),
        },
      })
    }
    if (p === '/health' && req.method === 'GET') return send(res, 200, { ok: true, ts: nowISO(), counts: { operations: get('SELECT COUNT(*) n FROM operations').n, components: get('SELECT COUNT(*) n FROM components').n, knowledge: get('SELECT COUNT(*) n FROM knowledge').n, tasks: get('SELECT COUNT(*) n FROM tasks').n, records: get('SELECT COUNT(*) n FROM records').n } })
    if (p === '/ui' && req.method === 'GET') { const rows = all('SELECT key,value FROM ui'); const o = {}; for (const r of rows) o[r.key] = safeJSON(r.value, r.value); return send(res, 200, o) }
    if (p === '/ops' && req.method === 'GET') return send(res, 200, all('SELECT name,category,summary,version FROM operations ORDER BY category,name'))
    if (p.startsWith('/op/') && req.method === 'GET') { const o = opRow(get('SELECT * FROM operations WHERE name=?', [decodeURIComponent(p.slice(4))])); return o ? send(res, 200, o) : send(res, 404, { error: 'no such operation' }) }
    if (p === '/components' && req.method === 'GET') return send(res, 200, all('SELECT * FROM components ORDER BY category,name').map(c => ({ ...c, operations: safeJSON(c.operations, []) })))
    if (p.startsWith('/component/') && req.method === 'GET') { const c = get('SELECT * FROM components WHERE name=?', [decodeURIComponent(p.slice(11))]); return c ? send(res, 200, { ...c, operations: safeJSON(c.operations, []) }) : send(res, 404, { error: 'no such component' }) }
    if (p === '/knowledge' && req.method === 'GET') {
      const cat = q.get('category'), term = q.get('q'), tag = q.get('tag'); const w = [], v = []
      if (cat) { w.push('category=?'); v.push(cat) } if (tag) { w.push('tags LIKE ?'); v.push('%' + tag + '%') }
      if (term) { w.push('(key LIKE ? OR value LIKE ?)'); v.push('%' + term + '%', '%' + term + '%') }
      return send(res, 200, all('SELECT id,category,key,value,tags,updated_at FROM knowledge' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY category,key', v))
    }
    if (p === '/tasks' && req.method === 'GET') return send(res, 200, all("SELECT * FROM tasks ORDER BY (status='done'), priority, COALESCE(deadline,'9999')"))
    if (p === '/records' && req.method === 'GET') { const w = [], v = []; if (q.get('component')) { w.push('component=?'); v.push(q.get('component')) } if (q.get('type')) { w.push('type=?'); v.push(q.get('type')) } return send(res, 200, all('SELECT * FROM records' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY id DESC LIMIT 200', v).map(r => ({ ...r, data: safeJSON(r.data, {}) }))) }
    if (p === '/log' && req.method === 'GET') return send(res, 200, all('SELECT * FROM actions_log ORDER BY id DESC LIMIT 100'))
    if (p === '/traces' && req.method === 'GET') { const op = q.get('op'); return send(res, 200, all('SELECT * FROM traces' + (op ? ' WHERE op=?' : '') + ' ORDER BY id DESC LIMIT 100', op ? [op] : []).map(t => ({ ...t, chain: safeJSON(t.chain, []), input: safeJSON(t.input, null), output: safeJSON(t.output, null) }))) }
    if (p === '/root-cause' && req.method === 'GET') return send(res, 200, rootCause(q.get('op')))
    if (p === '/search' && req.method === 'GET') {
      const term = (q.get('q') || '').trim(); if (!term) return send(res, 400, { error: 'pass ?q=<term>' }); const like = '%' + term + '%'
      return send(res, 200, {
        query: term,
        operations: all('SELECT name,category,summary,version FROM operations WHERE name LIKE ? OR summary LIKE ? OR prompt LIKE ? ORDER BY category,name', [like, like, like]),
        knowledge: all('SELECT id,category,key,value,tags FROM knowledge WHERE key LIKE ? OR value LIKE ? OR tags LIKE ? ORDER BY category,key', [like, like, like]),
        components: all('SELECT name,category,description FROM components WHERE name LIKE ? OR description LIKE ? ORDER BY category,name', [like, like]),
      })
    }

    // ---- the atomic write gateway ----
    if (p === '/action' && req.method === 'POST') {
      const { action, payload = {}, chat = '' } = await body(req)
      const fn = ACTIONS[action]; if (!fn) return send(res, 400, { error: 'unknown action: ' + action, known: Object.keys(ACTIONS) })
      try {
        const result = tx(() => fn(payload))
        run('INSERT INTO actions_log (ts,chat,action,payload,result) VALUES (?,?,?,?,?)', [nowISO(), chat, action, JSON.stringify(payload), JSON.stringify(result)])
        return send(res, 200, { ok: true, result })
      } catch (e) { return send(res, 500, { error: String(e.message || e), action }) }
    }

    send(res, 404, { error: 'not found', path: p })
  } catch (e) { send(res, 500, { error: String(e.message || e) }) }
})

server.listen(PORT, () => console.log(`\n  🔮 agent-ops → http://localhost:${PORT}   (manifest: /manifest)\n  DB: agent-ops/razos... local & private. Stop: Ctrl+C\n`))
