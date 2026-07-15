# agent-ops

**A self-describing operation registry for AI agents.** Point any agent (Claude Opus / Claude Code + workflows, GPT, etc.) at one small local server and it bootstraps everything it needs from there: which operations exist, the prompt for each, what each depends on, and the knowledge each requires. Open many agent chats in parallel under one project and they stay in perfect sync, because the server is the single source of truth. The engine is public; your data lives in a local, gitignored database.

> One project = one API server. Every agent talks to it. State is atomic. The UI is moldable by the agents themselves.

---

## Why

Running serious work through AI agents hits three walls:

1. **Stale, scattered instructions.** Prompts live in files, chats, and memory that drift out of date.
2. **No coordination.** Open three chats to work in parallel and they clobber each other's state.
3. **Everything tangled.** No clean separation between the engine, the operations, the knowledge, and the data.

`agent-ops` fixes all three with one idea: **make the operations self-describing and serve them from an atomic API.**

- Every **operation** is a node that carries its own **prompt** (how to do it) and its **deps** (the operations it needs). Agents pull only what a task requires, fresh, so it is always current.
- Every **mutation** goes through one **atomic action gateway** (a SQLite transaction), so parallel chats never lose each other's writes.
- The engine is generic and public; **your knowledge, leads, tasks, and records live in a local `data.db`** that is gitignored and never leaves your machine.

---

## How it works

```
                 ┌─────────────────────────────────────────────┐
   agent chat 1 ─┤                                             │
   agent chat 2 ─┤   agent-ops server  (one project, one API)  │──► data.db  (SQLite, local, gitignored)
   agent chat 3 ─┤                                             │      operations · knowledge · tasks
   the UI       ─┤   GET /manifest   → discover capabilities   │      records · actions_log · traces · ui
                 │   GET /op/:name   → prompt + deps            │
                 │   GET /knowledge  → query facts by category  │
                 │   POST /action    → one atomic write gateway │
                 └─────────────────────────────────────────────┘
```

**The whole protocol an agent follows (this is the entire rulebook):**

1. `GET /manifest` — see the current components, operations, and how to work here.
2. `GET /op/<name>` — get the operation you need: its prompt and its deps. Pull deps recursively.
3. `GET /knowledge?category=<c>` — get the facts/rules that operation references.
4. Execute per those prompts. Everything is pulled fresh, so it is always up to date.
5. `POST /action {action, payload, chat}` — send every mutation here (atomic + logged). Never write state any other way.
6. Log a `trace.add` of the chain so failures can be root-caused, and fix a weak operation with `op.set` (bumps its version).

Because operations reference other operations, they compose: a high-level operation's prompt names the lower-level operations it needs, each of which carries its own prompt.

---

## Quick start

Requires **Node 22+** (uses the built-in `node:sqlite`, zero dependencies).

```bash
git clone https://github.com/<you>/agent-ops
cd agent-ops
npm run seed        # populate data.db with generic example operations + knowledge
npm start           # start the server → http://localhost:8791
```

Open `http://localhost:8791` for the explorer UI, or hit the API:

```bash
curl http://localhost:8791/manifest
curl http://localhost:8791/op/outreach.batch
curl "http://localhost:8791/knowledge?category=voice"
curl -X POST http://localhost:8791/action -H "content-type: application/json" \
     -d '{"action":"task.add","chat":"me","payload":{"title":"try agent-ops","owner":"me","priority":1}}'
```

`npm run reset` wipes and re-seeds. The database file `data.db` is gitignored.

---

## Use it with your agent

Drop **[`AGENTS.md`](./AGENTS.md)** into any project folder. Agents that read `AGENTS.md` on start (Claude Code does) will then, on every task, bootstrap from your local `agent-ops` server and follow the protocol. That is what makes any folder "know" how to work with your engine.

Then just open several agent chats under that folder. They all talk to the same server, so they stay in sync, and you watch it all live in the UI.

---

## The UI is plasticine

The explorer UI is **config-driven from the API**, so your agent can reshape it for you by calling the API: change the title or language, add buttons that trigger operations, add panels that show specific records. You describe what you want to your agent in plain language; it calls `POST /action {action:"ui.set", ...}` and the UI updates. No front-end editing by hand.

```bash
# an agent adds a one-click button that runs your outreach batch:
curl -X POST http://localhost:8791/action -H "content-type: application/json" \
 -d '{"action":"ui.set","payload":{"key":"buttons","value":[{"label":"Run outreach","action":"task.add","payload":{"title":"outreach batch","owner":"me","priority":1}}]}}'
```

---

## API reference

| Method | Path | Purpose |
|---|---|---|
| GET | `/manifest` | Bootstrap: components, operations, knowledge categories, counts, protocol |
| GET | `/op/:name` | One operation: prompt + deps + version |
| GET | `/ops` | List operations |
| GET | `/component/:name`, `/components` | Components and their operations |
| GET | `/knowledge?category=&q=&tag=` | Query knowledge |
| GET | `/tasks` | The task board |
| GET | `/records?component=&type=` | Domain records (leads, notes, etc.) |
| GET | `/ui` | UI config |
| GET | `/log`, `/traces?op=` | Audit log and operation traces |
| GET | `/health` | Liveness + counts |
| POST | `/action` | The one atomic write gateway |

**Actions** (sent as `POST /action {action, payload, chat}`): `task.add` · `task.update` · `task.done` · `task.del` · `knowledge.set` · `knowledge.del` · `op.set` · `op.del` · `component.set` · `record.add` · `trace.add` · `ui.set`.

---

## Data and privacy

- The **engine** (this repo) is public and generic. It ships only with harmless example operations and knowledge.
- **Your data** (real knowledge, leads, tasks, pricing, anything private) lives in the local `data.db` and in local, gitignored seed files like `seed.local.mjs`. It is never committed. See `.gitignore`.
- Keep it that way: never hardcode private data into `seed.mjs` or any tracked file.

---

## Project layout

```
agent-ops/
├── server.mjs          # the API (zero-dep Node HTTP)
├── lib/db.mjs          # SQLite schema + helpers
├── seed.mjs            # generic, public example seed
├── seed.local.mjs      # YOUR private seed (gitignored, you create it)
├── public/index.html   # the explorer / control UI (config-driven)
├── AGENTS.md           # portable drop-in: teaches any agent the protocol
├── PROTOCOL.md         # the protocol, in detail
└── data.db             # your local database (gitignored)
```

## License

MIT.
