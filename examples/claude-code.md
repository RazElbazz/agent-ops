# Using agent-ops with Claude Code (Opus 4.8)

agent-ops turns a folder full of ad-hoc instructions into one **live, queryable brain** that every
Claude Code chat and subagent shares. Because all state goes through a single server with atomic
transactions, ten parallel chats stay in perfect sync — no lost updates, no stale copy-paste.

## 1. Run the server

```bash
npm run seed     # generic examples (skip once you have your own data)
npm start        # http://localhost:8791
```

For your real work, keep private data in a gitignored `seed.local.mjs` and run it once
(`node seed.local.mjs`) — see the top-level README.

## 2. Drop in `AGENTS.md`

Copy the repo's [`AGENTS.md`](../AGENTS.md) into the root of the project Claude Code works in.
Claude reads it and learns the protocol: *before doing anything, sync from the API; send every change
back through it.* You can also paste its contents into your `CLAUDE.md`. That is the whole install.

## 3. The per-task loop (what Claude does on every task)

```
GET  /manifest                     # what components/operations/knowledge exist right now
GET  /op/<name>                    # the operation's prompt + deps; pull deps recursively
GET  /knowledge?category=<c>       # the facts/rules that operation references
... execute per those prompts ...
POST /action {action, payload, chat}   # write EVERY result/decision back (atomic + logged)
POST /action trace.add {...}       # record the chain so failures can be root-caused
```

Nothing is hard-coded in the agent. Prompts, rules, and data are all pulled fresh, so improving an
operation once (`op.set`) improves every future run in every chat.

## 4. With the Claude Code workflow system

When you fan out work across subagents, have each subagent pull its operation's prompt from the API
instead of hard-coding it. A workflow stage becomes a thin shell around the live prompt:

```js
// inside a workflow script
const op = await (await fetch('http://localhost:8791/op/research.brief')).json()
const brief = await agent(`${op.prompt}\n\nTopic: ${topic}`, { schema: BRIEF_SCHEMA })
// write the result back through the one gateway:
await fetch('http://localhost:8791/action', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'record.add', payload: { component: 'research', type: 'brief', data: brief }, chat: 'wf' }) })
```

Now the workflow's behavior lives in the database, not the script. Edit the operation via `op.set`
(version bumps) and every workflow that uses it upgrades on the next run — no code change.

## 5. Root-cause a bad chain, then improve it

```bash
curl localhost:8791/root-cause        # names the operation that most often ends failing chains
```

Read that operation's prompt, fix it, and `POST /action op.set` (the version bumps automatically).
That is the self-improvement loop: the system learns from its own traces.

## Why this beats a pile of markdown files

- **One source of truth.** Every chat reads the same live state; no drift between copies.
- **Concurrency-safe.** Atomic transactions mean parallel chats never clobber each other.
- **Composable.** Operations declare their deps, so complex jobs are just small operations wired together.
- **Self-improving.** Traces + `op.set` turn failures into permanent upgrades.
