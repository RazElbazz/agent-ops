# Contributing

Thanks for looking at agent-ops. It is intentionally tiny — a zero-dependency Node server over a
SQLite database — so it stays easy to read and fork.

## Setup

```bash
git clone https://github.com/RazElbazz/agent-ops
cd agent-ops
npm run seed        # generic example data into a local data.db
npm start           # http://localhost:8791
npm test            # smoke test (server must be running)
node examples/demo.mjs   # full end-to-end walkthrough on an isolated scratch DB
```

Requires **Node 22+**. On Node 22 the built-in `node:sqlite` needs `--experimental-sqlite`; the npm
scripts already pass it, and it is a no-op on Node 24.

## Principles to preserve

If you send a PR, keep these intact — they are the point of the project:

- **Zero runtime dependencies.** Node built-ins only (`node:http`, `node:sqlite`). No frameworks.
- **One write path.** All mutations go through `POST /action` (transaction + audit log). Don't add
  side doors that write to the DB outside the gateway.
- **Operations stay self-describing.** An operation carries its own prompt and its deps; behavior
  lives in data, not in server code.
- **The engine is generic and public.** Never commit real/private data. Anything specific to your own
  use belongs in a gitignored `seed.local.mjs` and the local `data.db`. There is a private-data check
  in mind for every change: if a diff contains a real name, phone, price, or client, it does not belong here.

## Making a change

1. Keep `server.mjs` small and readable; prefer a new action in the `ACTIONS` map over a new route.
2. If you add an endpoint or action, add a check to `test.mjs`.
3. Before opening the PR run `npm test`, `npm run test:concurrency` (two processes, one DB), `npm run fuzz`
   (the server must survive every hostile input), and `node examples/demo.mjs` — CI runs all of them on Node 22 and 24.
4. Update the README API table and `AGENTS.md`/`PROTOCOL.md` if you change the contract.

## Ideas that fit

- New generic example operations that show useful composition patterns.
- Adapters/snippets for more agent frameworks in `examples/`.
- Better root-cause heuristics over the trace log.
- Optional export/import of a knowledge set (still local-first).

Open an issue first if it is a larger change, so we can keep the surface small.
