# This project runs on agent-ops. Read this first, on every task.

This folder is driven by a local **agent-ops** server: a self-describing operation registry.
Do **not** rely on memory or static files for *how* to do things. Pull it fresh from the server each task, so you are always current, and so parallel chats stay in sync.

**Server:** `http://localhost:8791`  (UI: open that URL in a browser)

## On every task

1. **Check the server is up:** `curl -s http://localhost:8791/health`. If it fails, start it: `npm --prefix <path-to>/agent-ops start` (or `node --experimental-sqlite <path-to>/agent-ops/server.mjs` — the flag is required on Node 22, a no-op on 24+), then continue.
2. **Bootstrap:** `GET /manifest` — the current operations, components, and knowledge categories.
3. **Pull the operation** for your task: `GET /op/<name>` — read its `prompt`, then pull each entry in its `deps` recursively (each dep is itself an operation with its own prompt).
4. **Pull knowledge** the operation references: `GET /knowledge?category=<c>`.
5. **Execute** exactly per those prompts.
6. **Write every change back** through the one gateway: `POST /action {action, payload, chat:"<your-chat-id>"}`. This is the only way to mutate state (it is atomic and logged). Never edit the DB or state any other way.
7. **Trace the chain:** `POST /action {action:"trace.add", payload:{op, chain, input, output, status, note}}` so a bad result can later be root-caused.

## Parallel chats

Many agent chats can run under this one project at once; they all share the server, so state is coherent and there are no lost updates. Give each chat a distinct `chat` id on its actions so the audit log and traces show who did what.

## Finding things

`GET /search?q=<term>` matches across operations, knowledge, and components — use it when you are not sure which operation or fact you need.

## Improving the system (self-repair)

If a chain produced an unexpected result, ask the API to analyze it: `GET /root-cause` (optionally `?op=<name>`). It reads the trace log and names the operation that most often ends failing chains, with a fix hint. Read that operation, sharpen its `prompt`, and `POST /action {action:"op.set", payload:{name, prompt, deps, ...}}` (bumps its version). Add new operations the same way. The system improves by editing the responsible operation, once, for every future chat. (`GET /traces?op=<name>` gives the raw chains if you want to inspect them yourself.)

## Reshaping the UI

The UI is config-driven. To change its title/language, add buttons that trigger operations, or add panels, send `POST /action {action:"ui.set", payload:{key, value}}`. The user asks in plain language; you make the change via the API.

## Keep private data private

Real/private data belongs in the local (gitignored) database and local seed files, never in tracked code.
