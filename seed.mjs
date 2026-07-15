// seed.mjs — seeds ONLY generic, public example data so the engine is demonstrable out of the box.
// Your REAL, private data (knowledge, leads, pricing, tasks) must NEVER live here (this file is public).
// Put it in a local, gitignored `seed.local.mjs` (see README) that populates your local data.db.
// Idempotent: operations/components/knowledge upsert by key; tasks only seeded when the table is empty.
// `node seed.mjs --reset` wipes everything first.
import { db, run, get, nowISO } from './lib/db.mjs'

if (process.argv.includes('--reset')) {
  for (const t of ['operations', 'components', 'knowledge', 'tasks', 'records', 'actions_log', 'traces', 'ui']) db.exec('DELETE FROM ' + t)
  console.log('reset: all tables cleared')
}
const now = nowISO(), today = now.slice(0, 10)
const op = (name, category, summary, prompt, deps = []) =>
  run('INSERT INTO operations (name,category,summary,prompt,deps,version,updated_at) VALUES (?,?,?,?,?,1,?) ON CONFLICT(name) DO UPDATE SET category=excluded.category,summary=excluded.summary,prompt=excluded.prompt,deps=excluded.deps,updated_at=excluded.updated_at', [name, category, summary, prompt, JSON.stringify(deps), now])
const comp = (name, category, description, operations) =>
  run('INSERT INTO components (name,category,description,operations,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET description=excluded.description,operations=excluded.operations,updated_at=excluded.updated_at', [name, category, description, JSON.stringify(operations), now])
const kn = (category, key, value, tags = '') => { const e = get('SELECT id FROM knowledge WHERE category=? AND key=?', [category, key]); if (e) run('UPDATE knowledge SET value=?,tags=?,updated_at=? WHERE id=?', [value, tags, now, e.id]); else run('INSERT INTO knowledge (category,key,value,tags,updated_at) VALUES (?,?,?,?,?)', [category, key, value, tags, now]) }

// ---------- EXAMPLE OPERATIONS (generic; each = its own prompt + the operations it depends on) ----------
op('research.brief', 'research', 'Research a topic into a cited brief',
  'Research the given topic: search multiple sources, verify claims against each other, and synthesize a short, cited brief. Return the brief plus its sources.')
op('draft.message', 'writing', 'Draft a message in the configured voice',
  'Draft a message for the given recipient and goal. Follow the tone in knowledge voice.tone. Keep it short and specific. Return the message text only.')
op('lead.find', 'outreach', 'Find candidate leads for an ICP',
  'Find real, verifiable companies that match the ICP described in knowledge outreach.icp. Use web search; never fabricate. Return {company, domain, why} for each, and store them as records (component=outreach, type=lead).')
op('outreach.batch', 'outreach', 'Full outreach batch: find, draft, output a worklist',
  'Run an outreach batch: (1) lead.find, (2) draft.message for each lead. Render the result as a clean HTML worklist (see knowledge format.output). Log the leads as records and add a follow-up task.',
  ['lead.find', 'draft.message'])
op('doc.render', 'core', 'Render a long output as a clean HTML page',
  'Render any long output as a clean, organized, self-contained HTML page per knowledge format.output. Save it locally and open it.')
op('meeting.prep', 'sales', 'Prepare a one-page brief before a call',
  'Given a company and a contact, produce a one-page prep: who they are, their likely pain, three questions to ask, and one relevant proof point. Use research.brief for the facts and mirror the tone in knowledge voice.tone.',
  ['research.brief'])
op('campaign.run', 'outreach', 'Run a full outreach campaign end to end',
  'Run a campaign: outreach.batch to find leads and draft messages, then doc.render the worklist into a shareable page and add a follow-up task per lead. This composes lower-level operations (depth 3): campaign.run -> outreach.batch -> lead.find/draft.message.',
  ['outreach.batch', 'doc.render'])

// ---------- EXAMPLE COMPONENTS ----------
comp('outreach', 'growth', 'Find leads and draft outreach messages', ['lead.find', 'draft.message', 'outreach.batch', 'campaign.run'])
comp('research', 'knowledge', 'Turn a topic into a verified brief', ['research.brief'])
comp('sales', 'growth', 'Prepare for and run calls', ['meeting.prep'])
comp('core', 'core', 'Core services: rendering, formatting', ['doc.render'])

// ---------- EXAMPLE KNOWLEDGE (generic placeholders; put your real, private knowledge in seed.local.mjs) ----------
kn('voice', 'tone', 'Keep it concise, confident, and specific. Lead with the decision, then the why.', 'example')
kn('format', 'output', 'Long outputs render as a clean, organized, self-contained HTML page: clear masthead, sensible hierarchy, generous spacing, readable typography.', 'example')
kn('outreach', 'icp', 'Define your ideal customer profile here (industry, size, buying signal). This is an example placeholder; keep your real ICP in a local gitignored seed.', 'example')
kn('_meta', 'getting-started', 'This is generic example seed data. Your real, private knowledge, leads, pricing, and tasks belong in a local gitignored seed.local.mjs so they never reach this public repo. See README.', 'example')

// ---------- UI CONFIG (the UI is plasticine; agents reshape it via action ui.set) ----------
const uiSet = (key, value) => run('INSERT INTO ui (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [key, JSON.stringify(value), now])
uiSet('title', 'agent-ops')
uiSet('lang', 'en')
uiSet('tabs', ['overview', 'operations', 'knowledge', 'tasks', 'records', 'activity'])
uiSet('buttons', [{ label: 'Add example task', action: 'task.add', payload: { title: 'A task added from a UI button', owner: 'you', priority: 2 } }])

// ---------- EXAMPLE TASK (only when empty) ----------
if (get('SELECT COUNT(*) n FROM tasks').n === 0) {
  run('INSERT INTO tasks (title,owner,stream,priority,status,created) VALUES (?,?,?,?,?,?)', ['Example task, replace with your own via POST /action task.add', 'you', 'ops', 2, 'todo', today])
  console.log('seeded 1 example task')
}

// ---------- EXAMPLE RECORDS (only when empty) so the Records tab shows something ----------
if (get('SELECT COUNT(*) n FROM records').n === 0) {
  const rec = (component, type, data) => run('INSERT INTO records (component,type,data,created) VALUES (?,?,?,?)', [component, type, JSON.stringify(data), today])
  rec('outreach', 'lead', { company: 'Acme Analytics', domain: 'acme.example', decisionMaker: 'Dana Cohen', role: 'VP Engineering' })
  rec('outreach', 'lead', { company: 'Northwind SaaS', domain: 'northwind.example', decisionMaker: 'Sam Lee', role: 'CTO' })
  rec('research', 'brief', { title: 'Example brief: how X works', sources: 3 })
  console.log('seeded 3 example records — see the Records tab')
}

// ---------- EXAMPLE TRACES (only when empty) so /root-cause + the Activity panel show something ----------
if (get('SELECT COUNT(*) n FROM traces').n === 0) {
  const trace = (op, chain, status, note) => run('INSERT INTO traces (ts,chat,op,chain,input,output,status,note) VALUES (?,?,?,?,?,?,?,?)', [now, 'example', op, JSON.stringify(chain), 'null', 'null', status, note])
  trace('campaign.run', ['outreach.batch', 'lead.find', 'draft.message'], 'fail', 'draft.message ignored voice.tone; messages read generic')
  trace('outreach.batch', ['lead.find', 'draft.message'], 'error', 'draft.message produced generic copy again')
  trace('research.brief', ['research.brief'], 'ok', 'cited brief shipped')
  console.log('seeded 3 example traces (2 failing) — see GET /root-cause and the Activity tab')
}
console.log('seed done (generic examples only): ' + get('SELECT COUNT(*) n FROM operations').n + ' operations · ' + get('SELECT COUNT(*) n FROM components').n + ' components · ' + get('SELECT COUNT(*) n FROM knowledge').n + ' knowledge')
