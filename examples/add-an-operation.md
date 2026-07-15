# Authoring your own operations, knowledge, and components

This is where you make the engine yours. You never edit server code to add capability — you write
data through the API, and the system picks it up immediately.

## Anatomy of an operation

An operation is a **self-describing node**: it carries its own prompt (how to do the thing) and the
operations it depends on (the edges of the graph).

| field | meaning |
|-------|---------|
| `name` | unique id, e.g. `outreach.batch` |
| `category` | grouping, e.g. `outreach` |
| `summary` | one line — what it does |
| `prompt` | the actual instructions an agent follows to perform it |
| `deps` | array of other operation names it needs (pulled recursively) |
| `version` | auto-managed; bumps every time you `op.set` |

## Add one

```bash
curl -X POST localhost:8791/action -H 'content-type: application/json' -d '{
  "action": "op.set",
  "payload": {
    "name": "meeting.prep",
    "category": "sales",
    "summary": "Prepare a one-page brief before a call",
    "prompt": "Given a company and a contact, produce a one-page prep: who they are, likely pain, 3 questions to ask, and one relevant proof point. Pull knowledge sales.style for tone.",
    "deps": ["research.brief"]
  }
}'
```

`deps: ["research.brief"]` means an agent running `meeting.prep` will first pull and run
`research.brief`. Depend on operations that themselves have deps and you get a recursive graph — one
small operation composed of others, all the way down.

## Add the knowledge it references

Operations should reference **knowledge** (facts/rules) rather than hard-coding them, so you can
change the facts in one place:

```bash
curl -X POST localhost:8791/action -H 'content-type: application/json' -d '{
  "action": "knowledge.set",
  "payload": { "category": "sales", "key": "style", "value": "Warm, specific, zero fluff. Lead with their problem, not your credentials.", "tags": "voice" }
}'
```

Query it back by category, free-text, or tag:

```bash
curl 'localhost:8791/knowledge?category=sales'
curl 'localhost:8791/knowledge?q=problem'
curl 'localhost:8791/search?q=meeting'      # across ops + knowledge + components
```

## Group operations into a component

A **component** is a named bundle of related operations — a section of your system:

```bash
curl -X POST localhost:8791/action -H 'content-type: application/json' -d '{
  "action": "component.set",
  "payload": { "name": "sales", "category": "growth", "description": "Everything for booking and running calls", "operations": ["meeting.prep", "research.brief"] }
}'
```

## The whole write surface

Every change goes through `POST /action {action, payload, chat}`. The actions:

| action | payload |
|--------|---------|
| `op.set` / `op.del` | operation fields / `{name}` |
| `knowledge.set` / `knowledge.del` | `{category,key,value,tags}` / `{id}` |
| `component.set` / `component.del` | component fields / `{name}` |
| `task.add` / `task.update` / `task.done` / `task.del` | task fields / `{id,...}` |
| `record.add` / `record.del` | `{component,type,data}` / `{id}` |
| `trace.add` | `{op,chain,status,note}` |
| `ui.set` | `{key,value}` — reshape the UI (title, language, tabs, buttons) |

Every action runs in a transaction and is written to `/log`, so the system is atomic and fully
auditable.

## Close the loop: trace → root-cause → improve

After running a chain, record how it went:

```bash
curl -X POST localhost:8791/action -H 'content-type: application/json' -d '{
  "action": "trace.add",
  "payload": { "op": "meeting.prep", "chain": ["research.brief", "meeting.prep"], "status": "fail", "note": "brief missed recent funding news" }
}'
```

Then ask the API what is breaking:

```bash
curl localhost:8791/root-cause
```

It scores each operation by how often it ends failing chains and appears in them, and names the
strongest suspect. Read that operation, sharpen its prompt, and `op.set` it — the version bumps and
every future run improves. That is the engine getting smarter from its own history.

## Design principles (why it is shaped this way)

- **Self-describing.** An operation carries its own prompt, so agents need almost no hard-coded logic.
- **Composable / recursive.** Deps make big jobs out of small, reusable operations.
- **One write gateway.** All mutations go through `/action` (atomic + logged) — safe for many parallel agents.
- **Knowledge is data.** Facts live in a queryable table, not inside prompts, so you change them once.
- **Self-improving.** Traces + `op.set` turn failures into permanent upgrades.
