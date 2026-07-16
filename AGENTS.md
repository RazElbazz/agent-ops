# This project runs on agent-ops. Read this first, on every task.

This folder is driven by a local **agent-ops** server: a self-describing operation registry.
Do **not** rely on memory or static files for *how* to do things. Pull it fresh from the server each task, so you are always current, and so parallel chats stay in sync.

**Server:** `http://localhost:8791`  (UI: open that URL in a browser)

## On every task

Pick a **stable chat id** for yourself (e.g. `chat-<something>`) and use it on everything below.

1. **Check the server is up:** `curl -s http://localhost:8791/health`. If it fails, start it: `npm --prefix <path-to>/agent-ops start` (or `node --experimental-sqlite <path-to>/agent-ops/server.mjs` — the flag is required on Node 22, a no-op on 24+), then continue.
2. **Sign in to the pin board** so other chats see you and don't duplicate your work: `POST /action {action:"session.set", payload:{chat, title:"<what you are doing now>", op:"<the operation>", status:"active"}}`. Update it as you go; it shows up live in `GET /sessions` and the UI's Live tab.
3. **Bootstrap:** `GET /manifest` — the current operations, components, knowledge categories, and endpoints.
4. **Pull the complete briefing in one call:** `GET /op/<name>/resolve` — it returns the operation, **all** the operations it depends on (recursively), **and** all the knowledge they reference via each operation's `uses`. That is everything you need; you can't miss a fact. (For just one op use `GET /op/<name>`; for more facts `GET /knowledge?category=<c>`.)
5. **Execute** exactly per those prompts.
6. **Write every change back** through the one gateway: `POST /action {action, payload, chat}`. This is the only way to mutate state (atomic + logged). Never edit the DB or state any other way.
7. **Record the chain, with timing:** `POST /action {action:"trace.add", payload:{op, chain, status, note, ms}}` so failures can be root-caused and per-chat analytics work.
8. **Sign out** when the task is done: `POST /action {action:"session.end", payload:{chat}}`.

## Parallel chats (the whole point)

Many chats run under this one project at once; they share the server, so state is coherent with no lost updates. Always: (a) use a distinct `chat` id, (b) keep your `session.set` current so `GET /sessions` shows who is working on what, and (c) glance at `GET /sessions` before starting something so two chats don't do the same thing. That pin board is what makes parallel agents strong instead of chaotic.

## Finding things

`GET /search?q=<term>` matches across operations, knowledge, and components — use it when you are not sure which operation or fact you need.

## Improving the system (self-repair)

If a chain produced an unexpected result, ask the API to analyze it: `GET /root-cause` (optionally `?op=<name>`). It reads the trace log and names the operation that most often ends failing chains, with a fix hint. Read that operation, sharpen its `prompt`, and `POST /action {action:"op.set", payload:{name, prompt, deps, ...}}` (bumps its version). Add new operations the same way. The system improves by editing the responsible operation, once, for every future chat. (`GET /traces?op=<name>` gives the raw chains if you want to inspect them yourself.)

## Reshaping the UI

The UI is config-driven. To change its title/language, add buttons that trigger operations, or add panels, send `POST /action {action:"ui.set", payload:{key, value}}`. The user asks in plain language; you make the change via the API.

## Keep private data private

Real/private data belongs in the local (gitignored) database and local seed files, never in tracked code.
