// server.mjs — agent-ops API. Zero-dep Node HTTP. The single coordination point for all chats.
//   Reads:  GET /manifest · /op/:name · /op/:name/resolve · /op/:name/history · /ops · /knowledge · /components
//           /tasks · /records · /log · /traces?op= · /sessions · /search?q= · /root-cause?op= · /lint · /stats · /export · /ui · /health
//   Writes: POST /action {action, payload, chat}  -> ONE atomic gateway (transaction + audit log).
//           actions: task.add|update|done|del · knowledge.set|del · op.set|del · component.set|del
//                    record.add|del|update · trace.add · ui.set|del · session.set|end|del · import.bundle
// Run:  node server.mjs   (if node:sqlite asks for a flag: node --experimental-sqlite server.mjs)
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname } from 'node:path'
import { all, get, run, tx, nowISO } from './lib/db.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 8791
// Bind to localhost by default (the write gateway is unauthenticated). Set HOST=0.0.0.0 to expose on
// the LAN. CORS is OFF by default so a random website can't read/drive your local server from a
// browser; set ALLOW_ORIGIN (e.g. '*' or 'https://foo') to opt in for cross-origin browser clients.
const HOST = process.env.HOST || '127.0.0.1'
const CORS = process.env.ALLOW_ORIGIN || ''
const today = () => new Date().toISOString().slice(0, 10)

const PROTOCOL = [
  'agent-ops protocol (the rulebook for working here, especially with several chats at once):',
  '0. Pick a stable chat id for yourself. When you start a task, POST /action session.set {chat, title:"<what you are doing now>", op, status:"active"} so every other chat sees you on the board (GET /sessions). Update it as you progress; POST /action session.end {chat} when finished. This is how parallel chats avoid duplicating work.',
  '1. GET /manifest — the current components, operations, knowledge categories, and endpoints.',
  '2. GET /op/<name>/resolve — returns the operation, ALL operations it depends on (recursively), AND all the knowledge they reference (via each operation\'s `uses`). One call = the complete briefing, so you never miss a fact. (Or GET /op/<name> for one, GET /knowledge?category=<c> for more.)',
  '3. Execute per those prompts. Everything is pulled fresh, so it is always current.',
  '4. Send every mutation as POST /action {action, payload, chat} (atomic + logged). Never write state any other way.',
  '5. Record the chain: POST /action trace.add {op, chain, status, note, ms}. When a chain fails, GET /root-cause to see which operation breaks chains; fix its prompt via op.set (bumps version). That is the self-improvement loop.',
  'Model: an operation has `deps` (operations it calls) and `uses` (knowledge it needs, as "category" or "category.key"). Put a how-to as an operation prompt; put facts/rules as knowledge and link them with `uses` so the chain always pulls them.',
  'Discovery: GET /search?q=<term>. Coordination: GET /sessions = who is working on what right now + per-chat analytics.',
].join('\n')

// ---- atomic action gateway ----
const ACTIONS = {
  'task.add': p => { const r = run('INSERT INTO tasks (title,owner,stream,priority,status,deadline,due_when,note,dep,created) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [p.title, p.owner || 'claude', p.stream || 'ops', p.priority || 2, 'todo', p.deadline || null, p.due_when || null, p.note || null, p.dep || null, today()]); return { id: Number(r.lastInsertRowid) } },
  'task.update': p => { const f = [], v = []; for (const k of ['title', 'owner', 'stream', 'priority', 'status', 'deadline', 'due_when', 'note', 'dep']) if (k in p) { f.push(k + '=?'); v.push(p[k]) } if (!f.length) return { ok: true, changed: 0 }; v.push(p.id); const r = run('UPDATE tasks SET ' + f.join(',') + ' WHERE id=?', v); return { ok: true, changed: r.changes } },
  'task.done': p => { const r = run('UPDATE tasks SET status=?, done_on=? WHERE id=?', ['done', today(), p.id]); return { ok: true, changed: r.changes } },
  'task.del': p => { const r = run('DELETE FROM tasks WHERE id=?', [p.id]); return { ok: true, changed: r.changes } },
  'knowledge.set': p => { const ex = get('SELECT id FROM knowledge WHERE category=? AND key=?', [p.category, p.key]);
      if (ex) { run('UPDATE knowledge SET value=?, tags=?, updated_at=? WHERE id=?', [p.value, p.tags || '', nowISO(), ex.id]); return { id: ex.id, updated: true } }
      const r = run('INSERT INTO knowledge (category,key,value,tags,updated_at) VALUES (?,?,?,?,?)', [p.category, p.key, p.value, p.tags || '', nowISO()]); return { id: Number(r.lastInsertRowid) } },
  'op.set': p => { const ex = get('SELECT version FROM operations WHERE name=?', [p.name]); const ver = ex ? ex.version + 1 : 1;
      run('INSERT INTO operations (name,category,summary,prompt,deps,uses,version,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET category=excluded.category,summary=excluded.summary,prompt=excluded.prompt,deps=excluded.deps,uses=excluded.uses,version=excluded.version,updated_at=excluded.updated_at',
        [p.name, p.category || '', p.summary || '', p.prompt || '', JSON.stringify(asArr(p.deps)), JSON.stringify(asArr(p.uses)), ver, nowISO()]); return { name: p.name, version: ver } },
  'component.set': p => { run('INSERT INTO components (name,category,description,operations,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET category=excluded.category,description=excluded.description,operations=excluded.operations,updated_at=excluded.updated_at',
        [p.name, p.category || '', p.description || '', JSON.stringify(asArr(p.operations)), nowISO()]); return { name: p.name } },
  'record.add': p => { const r = run('INSERT INTO records (component,type,data,created) VALUES (?,?,?,?)', [p.component, p.type || '', JSON.stringify(p.data || {}), today()]); return { id: Number(r.lastInsertRowid) } },
  'trace.add': p => { const r = run('INSERT INTO traces (ts,chat,op,chain,input,output,status,note,ms) VALUES (?,?,?,?,?,?,?,?,?)',
      [nowISO(), p.chat || '', p.op || '', JSON.stringify(p.chain || []), JSON.stringify(p.input ?? null), JSON.stringify(p.output ?? null), p.status || '', p.note || '', typeof p.ms === 'number' ? p.ms : null]); return { id: Number(r.lastInsertRowid) } },
  // sessions = the live coordination "pin board": each chat reports what it is working on right now.
  'session.set': p => { const now = nowISO(); run('INSERT INTO sessions (chat,title,detail,op,chain,status,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(chat) DO UPDATE SET title=excluded.title,detail=excluded.detail,op=excluded.op,chain=excluded.chain,status=excluded.status,updated_at=excluded.updated_at',
      [p.chat, p.title || '', p.detail || '', p.op || '', JSON.stringify(asArr(p.chain)), p.status || 'active', now, now]); return { chat: p.chat } },
  'session.end': p => { const r = run("UPDATE sessions SET status='done', updated_at=? WHERE chat=?", [nowISO(), p.chat]); return { ok: true, changed: r.changes } },
  'session.del': p => { const r = run('DELETE FROM sessions WHERE chat=?', [p.chat]); return { ok: true, changed: r.changes } },
  'ui.set': p => { run('INSERT INTO ui (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [p.key, JSON.stringify(p.value === undefined ? null : p.value), nowISO()]); return { key: p.key } },
  'knowledge.del': p => { const r = run('DELETE FROM knowledge WHERE id=?', [p.id]); return { ok: true, changed: r.changes } },
  'op.del': p => { const r = run('DELETE FROM operations WHERE name=?', [p.name]); return { ok: true, changed: r.changes } },
  'component.del': p => { const r = run('DELETE FROM components WHERE name=?', [p.name]); return { ok: true, changed: r.changes } },
  'record.del': p => { const r = run('DELETE FROM records WHERE id=?', [p.id]); return { ok: true, changed: r.changes } },
  'record.update': p => { const r = run('UPDATE records SET data=? WHERE id=?', [JSON.stringify(p.data ?? {}), p.id]); return { ok: true, changed: r.changes } },
  'ui.del': p => { const r = run('DELETE FROM ui WHERE key=?', [p.key]); return { ok: true, changed: r.changes } },
  // Import a shared system definition (from GET /export). Upserts ops/components/knowledge/ui in one
  // transaction (each op.set bumps its version). Truly partial-safe: each item is type-validated and
  // wrapped in its own try/catch, so one bad row is skipped-and-reported, never aborting the whole import.
  'import.bundle': p => { const n = { operations: 0, components: 0, knowledge: 0, ui: 0 }, skipped = []
    const imp = (kind, action, items) => { for (const item of asArr(items)) { const msg = (!item || typeof item !== 'object' || Array.isArray(item)) ? 'not an object' : validateAction(action, item); if (msg) { skipped.push({ type: kind, reason: msg, item }); continue } try { ACTIONS[action](item); n[kind]++ } catch (e) { skipped.push({ type: kind, reason: String(e.message || e), item }) } } }
    imp('operations', 'op.set', p.operations)
    imp('components', 'component.set', p.components)
    imp('knowledge', 'knowledge.set', p.knowledge)
    if (p.ui && typeof p.ui === 'object' && !Array.isArray(p.ui)) for (const [key, value] of Object.entries(p.ui)) { try { ACTIONS['ui.set']({ key, value }); n.ui++ } catch (e) { skipped.push({ type: 'ui', reason: String(e.message || e), item: { key } }) } }
    return skipped.length ? { ...n, skipped } : n },
}

const send = (res, code, obj) => { if (res.headersSent || res.writableEnded) return; const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }; if (CORS) { h['Access-Control-Allow-Origin'] = CORS; h['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'; h['Access-Control-Allow-Headers'] = 'Content-Type' } res.writeHead(code, h); res.end(JSON.stringify(obj)) }
const asArr = x => Array.isArray(x) ? x : []
// Full per-action type contract: every field that gets bound to SQLite is checked, so ANY wrong-typed
// payload returns a clean 400 instead of a 500 at bind time. `str` = string, `arr` = array, `num` =
// number, `bind` = anything SQLite can bind (string/number/null). ui.set.value is intentionally any-typed
// (it is JSON-encoded), so it is not listed. req = required-and-typed, opt = checked only when present.
const str = v => typeof v === 'string', arr = Array.isArray, num = v => typeof v === 'number'
const bind = v => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint'
const SPEC = {
  'task.add': { req: { title: str }, opt: { owner: str, stream: str, status: str, deadline: str, due_when: str, note: str, dep: bind, priority: num } },
  'task.update': { req: { id: bind }, opt: { title: str, owner: str, stream: str, status: str, deadline: str, due_when: str, note: str, dep: bind, priority: num } },
  'task.done': { req: { id: bind } }, 'task.del': { req: { id: bind } },
  'knowledge.set': { req: { category: str, key: str, value: str }, opt: { tags: str } }, 'knowledge.del': { req: { id: bind } },
  'op.set': { req: { name: str }, opt: { category: str, summary: str, prompt: str, deps: arr, uses: arr } }, 'op.del': { req: { name: str } },
  'component.set': { req: { name: str }, opt: { category: str, description: str, operations: arr } }, 'component.del': { req: { name: str } },
  'record.add': { req: { component: str }, opt: { type: str } }, 'record.del': { req: { id: bind } }, 'record.update': { req: { id: bind } },
  'trace.add': { req: { op: str }, opt: { chat: str, status: str, note: str, ms: num } },
  'ui.set': { req: { key: str } }, 'ui.del': { req: { key: str } },
  'session.set': { req: { chat: str }, opt: { title: str, detail: str, op: str, chain: arr, status: str } },
  'session.end': { req: { chat: str } }, 'session.del': { req: { chat: str } },
}
const LABEL = new Map([[str, 'a string'], [arr, 'an array'], [num, 'a number'], [bind, 'a string or number']])
function validateAction(action, p) {
  const s = SPEC[action]; if (!s || !p || typeof p !== 'object') return null
  for (const [f, chk] of Object.entries(s.req || {})) if (!chk(p[f])) return `${f} must be ${LABEL.get(chk)}`
  for (const [f, chk] of Object.entries(s.opt || {})) if (f in p && p[f] != null && !chk(p[f])) return `${f} must be ${LABEL.get(chk)}`
  return null
}
// Read the whole body first; only classify AFTER parsing. A non-object JSON (null, 5, "x", []) is __bad,
// so the /action handler never dereferences a non-object payload.
async function body(req) {
  // Always drain the whole request stream (buffer capped at 2MB). Returning early on oversize would leave
  // unread bytes on a keep-alive socket, desyncing the NEXT request on it (the fuzzer caught this as a hang).
  let b = '', over = false
  for await (const c of req) { if (!over && b.length + c.length > 2_000_000) over = true; if (!over) b += c }
  if (over) return { __oversize: true }
  try { const v = JSON.parse(b || '{}'); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : { __bad: true } } catch { return { __bad: true } }
}
const safeDecode = s => { try { return decodeURIComponent(s) } catch { return null } }
// Required fields per action — reject bad payloads with a clear 400 instead of writing broken rows.
const REQUIRED = {
  'task.add': ['title'], 'task.update': ['id'], 'task.done': ['id'], 'task.del': ['id'],
  'knowledge.set': ['category', 'key', 'value'], 'knowledge.del': ['id'],
  'op.set': ['name'], 'op.del': ['name'], 'component.set': ['name'], 'component.del': ['name'],
  'record.add': ['component'], 'record.del': ['id'], 'record.update': ['id'], 'trace.add': ['op'], 'ui.set': ['key'], 'ui.del': ['key'],
  'session.set': ['chat'], 'session.end': ['chat'], 'session.del': ['chat'],
}
const opRow = r => r ? ({ ...r, deps: asArr(safeJSON(r.deps, [])), uses: asArr(safeJSON(r.uses, [])) }) : null
const safeJSON = (s, d) => { try { return JSON.parse(s) } catch { return d } }

// Graph integrity: catch a broken operation graph before it bites at runtime.
function lint() {
  const ops = all('SELECT name,deps FROM operations').map(o => ({ name: o.name, deps: asArr(safeJSON(o.deps, [])) }))
  const names = new Set(ops.map(o => o.name))
  const comps = all('SELECT name,operations FROM components').map(c => ({ name: c.name, operations: asArr(safeJSON(c.operations, [])) }))
  const missingDeps = [], danglingComponentOps = []
  for (const o of ops) for (const d of o.deps) if (!names.has(d)) missingDeps.push({ operation: o.name, missingDep: d })
  for (const c of comps) for (const op of c.operations) if (!names.has(op)) danglingComponentOps.push({ component: c.name, missingOp: op })
  const inComponent = new Set(comps.flatMap(c => c.operations))
  const opsNotInAnyComponent = ops.map(o => o.name).filter(n => !inComponent.has(n))
  return {
    ok: missingDeps.length === 0 && danglingComponentOps.length === 0,
    missingDeps, danglingComponentOps, opsNotInAnyComponent,
    counts: { operations: ops.length, components: comps.length },
  }
}

const isFail = s => !!s && !/^(ok|success|pass|done|complete|good)/i.test(String(s))

// Usage analytics: how often each operation runs and its success rate (from traces), plus the
// action-type breakdown (from the audit log). Complements /root-cause: what runs a lot vs what fails.
function stats() {
  const traces = all('SELECT op,status FROM traces')
  const byOp = {}
  for (const t of traces) { const o = byOp[t.op] || (byOp[t.op] = { op: t.op, runs: 0, ok: 0, fail: 0 }); o.runs++; if (isFail(t.status)) o.fail++; else if (t.status) o.ok++ }
  const runsByOp = Object.values(byOp).map(o => ({ ...o, successRate: (o.ok + o.fail) ? Math.round(100 * o.ok / (o.ok + o.fail)) : null })).sort((a, b) => b.runs - a.runs)
  return {
    totals: { operations: get('SELECT COUNT(*) n FROM operations').n, knowledge: get('SELECT COUNT(*) n FROM knowledge').n, records: get('SELECT COUNT(*) n FROM records').n, traces: traces.length, actions: get('SELECT COUNT(*) n FROM actions_log').n },
    runsByOp,
    actionsByType: all('SELECT action, COUNT(*) n FROM actions_log GROUP BY action ORDER BY n DESC'),
  }
}

// resolveOp — the complete briefing for a task in ONE call: the operation, every operation it depends on
// (recursively, in order), and every knowledge item those operations reference via `uses`. This is what
// guarantees the chain never misses a piece of knowledge: an agent GETs /op/<name>/resolve and has it all.
// A `uses` entry is either "category.key" (one item) or "category" (every item in the category).
function resolveOp(name) {
  if (!get('SELECT name FROM operations WHERE name=?', [name])) return null
  const seen = new Set(), chain = [], refs = new Set(), missing = []
  const visit = n => {
    if (seen.has(n)) return; seen.add(n)
    const o = opRow(get('SELECT * FROM operations WHERE name=?', [n]))
    if (!o) { missing.push('operation:' + n); return }
    chain.push({ name: o.name, category: o.category, summary: o.summary, prompt: o.prompt, deps: o.deps, uses: o.uses, version: o.version })
    for (const u of o.uses) refs.add(String(u))
    for (const d of o.deps) visit(d)
  }
  visit(name)
  const knowledge = []
  for (const ref of refs) {
    const i = ref.indexOf('.')
    if (i > 0) { const k = get('SELECT category,key,value,tags FROM knowledge WHERE category=? AND key=?', [ref.slice(0, i), ref.slice(i + 1)]); k ? knowledge.push(k) : missing.push('knowledge:' + ref) }
    else { const ks = all('SELECT category,key,value,tags FROM knowledge WHERE category=?', [ref]); ks.length ? knowledge.push(...ks) : missing.push('knowledge-category:' + ref) }
  }
  return { operation: name, chain, knowledge, missing }
}

// live coordination view: who is working on what right now + per-chat analytics from the audit log.
function sessionsView() {
  const now = Date.now()
  const sessions = all('SELECT * FROM sessions ORDER BY updated_at DESC').map(s => {
    const ageMs = now - new Date(s.updated_at || 0).getTime()
    return { ...s, chain: safeJSON(s.chain, []), live: s.status === 'active' && ageMs < 120000, ageSec: Math.max(0, Math.round(ageMs / 1000)) }
  })
  const byChat = {}
  for (const r of all("SELECT chat, COUNT(*) n, MIN(ts) first, MAX(ts) last FROM actions_log WHERE chat != '' GROUP BY chat")) {
    byChat[r.chat] = { chat: r.chat, actions: r.n, first: r.first, last: r.last, spanSec: Math.max(0, Math.round((new Date(r.last).getTime() - new Date(r.first).getTime()) / 1000)) }
  }
  return {
    sessions: sessions.map(s => ({ ...s, analytics: byChat[s.chat] || { actions: 0 } })),
    byChat: Object.values(byChat).sort((a, b) => b.actions - a.actions),
    recentChains: all('SELECT chat,op,status,ms,ts FROM traces ORDER BY id DESC LIMIT 30').map(t => ({ ...t })),
    liveCount: sessions.filter(s => s.live).length,
  }
}

// Analytic root-cause: read the trace log, find failing chains, and point at the operation
// that most often breaks them (the last step reached in a failing chain = the likely culprit).
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
    if (req.method === 'OPTIONS') { const h = {}; if (CORS) { h['Access-Control-Allow-Origin'] = CORS; h['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'; h['Access-Control-Allow-Headers'] = 'Content-Type' } res.writeHead(204, h); return res.end() }

    // static UI — readFile FIRST, then writeHead. (Writing the header before awaiting readFile means a
    // missing file rejects after headers are already sent, and the catch's second writeHead crashes the process.)
    if (p === '/' || p === '/index.html') { let html; try { html = await readFile(join(ROOT, 'public', 'index.html')) } catch { return send(res, 200, { ok: 'agent-ops', hint: 'no UI yet; use /manifest' }) } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html) }
    if (p.startsWith('/public/')) { const safe = p.replace(/\.\./g, '').slice(1); const type = { '.js': 'text/javascript', '.css': 'text/css' }[extname(p)] || 'text/plain'; let buf; try { buf = await readFile(join(ROOT, safe)) } catch { return send(res, 404, { error: 'not found' }) } res.writeHead(200, { 'Content-Type': type }); return res.end(buf) }

    // ---- reads ----
    if (p === '/manifest' && req.method === 'GET') {
      return send(res, 200, {
        name: 'agent-ops', protocol: PROTOCOL,
        components: all('SELECT name,category,description FROM components ORDER BY category,name'),
        operations: all('SELECT name,category,summary,version FROM operations ORDER BY category,name'),
        knowledgeCategories: all('SELECT category, COUNT(*) n FROM knowledge GROUP BY category ORDER BY category'),
        counts: { tasks: get('SELECT COUNT(*) n FROM tasks').n, records: get('SELECT COUNT(*) n FROM records').n },
        endpoints: {
          reads: ['/manifest', '/op/:name', '/op/:name/resolve', '/op/:name/history', '/ops', '/knowledge?category=&q=&tag=', '/component/:name', '/components', '/tasks', '/records?component=&type=', '/traces?op=', '/sessions', '/root-cause?op=', '/search?q=', '/lint', '/stats', '/export', '/log', '/ui', '/health'],
          write: 'POST /action {action, payload, chat} — the one atomic gateway',
          actions: Object.keys(ACTIONS),
        },
      })
    }
    if (p === '/health' && req.method === 'GET') return send(res, 200, { ok: true, ts: nowISO(), counts: { operations: get('SELECT COUNT(*) n FROM operations').n, components: get('SELECT COUNT(*) n FROM components').n, knowledge: get('SELECT COUNT(*) n FROM knowledge').n, tasks: get('SELECT COUNT(*) n FROM tasks').n, records: get('SELECT COUNT(*) n FROM records').n } })
    if (p === '/ui' && req.method === 'GET') { const rows = all('SELECT key,value FROM ui'); const o = {}; for (const r of rows) o[r.key] = safeJSON(r.value, r.value); return send(res, 200, o) }
    if (p === '/ops' && req.method === 'GET') return send(res, 200, all('SELECT name,category,summary,version FROM operations ORDER BY category,name'))
    if (p.startsWith('/op/') && p.endsWith('/resolve') && req.method === 'GET') {
      const name = safeDecode(p.slice(4, -8)); if (name == null) return send(res, 404, { error: 'no such operation' })
      const r = resolveOp(name); return r ? send(res, 200, r) : send(res, 404, { error: 'no such operation' })
    }
    if (p.startsWith('/op/') && p.endsWith('/history') && req.method === 'GET') {
      // Reconstruct an operation's evolution from the audit log (every op.set is recorded) — no extra
      // storage. Lets you see how a prompt changed over versions and recover a prior one (op.set it back).
      const name = safeDecode(p.slice(4, -8)); if (name == null) return send(res, 404, { error: 'no such operation' })
      const history = all("SELECT ts,chat,payload,result FROM actions_log WHERE action='op.set' ORDER BY id ASC")
        .map(r => ({ ts: r.ts, chat: r.chat, payload: safeJSON(r.payload, {}), result: safeJSON(r.result, {}) }))
        .filter(r => r.result && r.result.name === name)
        .map(r => ({ version: r.result.version, ts: r.ts, chat: r.chat, summary: r.payload.summary, prompt: r.payload.prompt, deps: asArr(r.payload.deps) }))
      return send(res, 200, { name, current: (get('SELECT version FROM operations WHERE name=?', [name]) || {}).version ?? null, history })
    }
    if (p.startsWith('/op/') && req.method === 'GET') { const name = safeDecode(p.slice(4)); const o = name == null ? null : opRow(get('SELECT * FROM operations WHERE name=?', [name])); return o ? send(res, 200, o) : send(res, 404, { error: 'no such operation' }) }
    if (p === '/components' && req.method === 'GET') return send(res, 200, all('SELECT * FROM components ORDER BY category,name').map(c => ({ ...c, operations: asArr(safeJSON(c.operations, [])) })))
    if (p.startsWith('/component/') && req.method === 'GET') { const name = safeDecode(p.slice(11)); const c = name == null ? null : get('SELECT * FROM components WHERE name=?', [name]); return c ? send(res, 200, { ...c, operations: asArr(safeJSON(c.operations, [])) }) : send(res, 404, { error: 'no such component' }) }
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
    if (p === '/lint' && req.method === 'GET') return send(res, 200, lint())
    if (p === '/stats' && req.method === 'GET') return send(res, 200, stats())
    if (p === '/sessions' && req.method === 'GET') return send(res, 200, sessionsView())
    if (p === '/export' && req.method === 'GET') return send(res, 200, {
      exportedFrom: 'agent-ops', schema: 1,
      operations: all('SELECT name,category,summary,prompt,deps,uses FROM operations ORDER BY category,name').map(o => ({ ...o, deps: asArr(safeJSON(o.deps, [])), uses: asArr(safeJSON(o.uses, [])) })),
      components: all('SELECT name,category,description,operations FROM components ORDER BY category,name').map(c => ({ ...c, operations: asArr(safeJSON(c.operations, [])) })),
      knowledge: all('SELECT category,key,value,tags FROM knowledge ORDER BY category,key'),
      ui: (() => { const o = {}; for (const r of all('SELECT key,value FROM ui')) o[r.key] = safeJSON(r.value, r.value); return o })(),
    })
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
      const parsed = await body(req)
      if (parsed.__oversize) return send(res, 413, { error: 'payload too large (2MB max)' })
      if (parsed.__bad) return send(res, 400, { error: 'invalid JSON body' })
      const { action } = parsed
      const chat = typeof parsed.chat === 'string' ? parsed.chat : '' // chat is logged to actions_log; coerce so a non-string can't fail the bind
      // Coerce a null / non-object / array payload to {} so a missing field is a clean 400, not a
      // 500 from dereferencing null (the `= {}` default only fires on undefined, not on explicit null).
      const payload = (parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)) ? parsed.payload : {}
      const fn = ACTIONS[action]; if (!fn) return send(res, 400, { error: 'unknown action: ' + action, known: Object.keys(ACTIONS) })
      const missing = (REQUIRED[action] || []).filter(k => payload[k] === undefined || payload[k] === null || payload[k] === '')
      if (missing.length) return send(res, 400, { error: 'missing required field(s): ' + missing.join(', '), action, required: REQUIRED[action] })
      const badType = validateAction(action, payload)
      if (badType) return send(res, 400, { error: badType, action })
      try {
        // Mutation + its audit-log row are ONE atomic unit: if the log write fails, the mutation rolls
        // back too, so a 500 never hides a write that actually happened (which would invite a double-apply).
        const result = tx(() => { const r = fn(payload); run('INSERT INTO actions_log (ts,chat,action,payload,result) VALUES (?,?,?,?,?)', [nowISO(), chat, action, JSON.stringify(payload), JSON.stringify(r)]); return r })
        return send(res, 200, { ok: true, result })
      } catch (e) { return send(res, 500, { error: String(e.message || e), action }) }
    }

    send(res, 404, { error: 'not found', path: p })
  } catch (e) { send(res, 500, { error: String(e.message || e) }) }
})

// Zero-setup: if the database has no operations yet (e.g. launched via `npx` without a seed), load the
// generic examples so the manifest/UI aren't empty. Skips when the DB is already populated, and can be
// disabled with AGENT_OPS_NO_SEED=1. Errors here are non-fatal (a read-only demo still starts).
if (!process.env.AGENT_OPS_NO_SEED && get('SELECT COUNT(*) n FROM operations').n === 0) {
  try { await import('./seed.mjs'); console.log('  (empty database — auto-seeded generic examples; run `npm run seed` or import your own to change)') } catch (e) { console.error('  (auto-seed skipped: ' + (e.message || e) + ')') }
}

// A friendly message instead of a raw stack when the port is taken (the README encourages many instances).
server.on('error', e => { if (e && e.code === 'EADDRINUSE') { console.error(`\n  port ${PORT} is already in use — set PORT=<other> and retry (e.g. PORT=8792 npm start)\n`); process.exit(1) } else { throw e } })
server.listen(PORT, HOST, () => console.log(`\n  🔮 agent-ops → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}   (manifest: /manifest)\n  bind ${HOST}${CORS ? ' · CORS ' + CORS : ''} · local & private (data.db). Stop: Ctrl+C\n`))
