# The agent-ops protocol

The whole design in one sentence: **the intelligence lives in the API, not in the agent.** An agent starts nearly empty and pulls exactly what a task needs, fresh, every time. This document explains the model and the rules in detail. For the short operational version an agent reads on each task, see [`AGENTS.md`](./AGENTS.md).

## The model

- **Operation** — the unit of work. A row that carries:
  - `prompt`: how to perform it (the instructions).
  - `deps`: the names of the operations it needs to call to perform itself.
  - `version`: bumped on every edit, so improvements are visible.
  Operations are therefore **self-describing** and **composable**: a high-level operation names lower-level operations in its `deps`, each of which carries its own prompt, and so on.
- **Component** — a named grouping of operations (a module of the workflow), for discovery.
- **Knowledge** — facts and rules, organized by `category`, that operations reference. Queryable.
- **Record** — flexible domain data produced by operations (leads, notes, findings), tagged by `component`/`type`.
- **Task** — a unit on the shared board (owner, priority, deadline, status, deps).
- **Action log** — every mutation, for audit and coordination across chats.
- **Trace** — a logged execution of an operation chain (chain, input, output, status), for root-cause analysis.

## The rules (what every agent does)

1. **Bootstrap from `/manifest`.** Never assume; discover the current capabilities.
2. **Pull operations by name** (`/op/:name`) and follow their `deps` recursively. Do only what the prompts say.
3. **Pull knowledge by category** (`/knowledge?category=`) for the facts an operation references.
4. **Mutate only through `POST /action`.** One atomic gateway, one audit trail. This is what keeps parallel chats coherent (SQLite transactions, no lost updates).
5. **Trace every chain** so failures are debuggable.
6. **Root-cause, then improve operations in place.** When a chain fails, `GET /root-cause` names the operation most responsible; fix it with `op.set` (which bumps the version). Fixing the responsible node fixes it for every future chat.

## A worked example

Task: "run an outreach batch."

```
GET /op/outreach.batch
  → prompt: "run lead.find, then draft.message for each lead, render an HTML worklist, log leads + a task"
  → deps: ["lead.find", "draft.message"]
GET /op/lead.find      → its prompt (references knowledge outreach.icp)
GET /op/draft.message  → its prompt (references knowledge voice.tone)
GET /knowledge?category=outreach   → the ICP rules
GET /knowledge?category=voice      → the tone
... execute ...
POST /action {action:"record.add", payload:{component:"outreach", type:"lead", data:{...}}}
POST /action {action:"task.add",   payload:{title:"follow up on batch", ...}}
POST /action {action:"trace.add",  payload:{op:"outreach.batch", chain:["lead.find","draft.message"], status:"ok"}}
```

## Root-cause and discovery

- `GET /root-cause[?op=]` reads the trace log, scores each operation by how often it **ends** a failing chain (the strongest signal) and how often it **appears** in one, and returns the strongest suspect with a fix hint. It turns "a chain went wrong somewhere" into "operation X is the problem — read its prompt and fix it." That closes the self-improvement loop: traces in, a better operation out.
- `GET /search?q=` matches a term across operations, knowledge, and components in one call — the fastest way for an agent to find the right node when it does not know the exact name.

## Why this is safe for parallel chats

Every write is a single `POST /action` handled inside a SQLite transaction with WAL and a busy timeout. Two chats writing at once serialize; neither loses the other's change. Reads are always current because nothing is cached in the agent. Open as many chats as you like under one project.
