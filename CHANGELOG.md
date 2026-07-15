# Changelog

All notable changes to agent-ops. This project is young; expect the surface to grow before 1.0.

## [0.1.0] — 2026-07-16

The first public release: a self-describing, composable operation registry for AI agents.

### Core
- Zero-dependency Node HTTP server over SQLite (`node:sqlite`), WAL + `BEGIN IMMEDIATE` so parallel
  agents/processes get atomic writes and no lost updates.
- **Self-describing operations**: each operation carries its own prompt and its `deps` (the operations
  it needs). Agents bootstrap from `/manifest`, pull only what a task requires, and compose recursively.
- **One atomic write gateway**: `POST /action` (transaction + audit log). Every mutation goes through it.

### Reads
- `/manifest`, `/op/:name`, `/op/:name/history`, `/ops`, `/components`, `/component/:name`
- `/knowledge?category=&q=&tag=`, `/search?q=`, `/records`, `/tasks`, `/traces`, `/log`, `/ui`, `/health`
- **Analytics**: `/root-cause` (which operation breaks chains), `/lint` (graph integrity),
  `/stats` (per-operation usage + success rate), `/export` (whole system as one JSON).

### Actions
- `task.*`, `knowledge.set|del`, `op.set|del`, `component.set|del`, `record.add|del`, `trace.add`,
  `ui.set|del`, and `import.bundle` (move/share a whole setup in one call; per-item safe).

### UI
- Config-driven, agent-moldable (via `ui.set`), bilingual. Tabs: overview, operations (list + a
  dependency **map**), knowledge, tasks (with complete buttons), records dashboard, activity
  (usage + root-cause + audit + traces).

### Developer experience
- `npx github:RazElbazz/agent-ops` runs it with no clone; auto-seeds the generic examples if the
  database is empty. Friendly message (not a crash) when the port is taken.
- CLI (`npm run cli`), a 45-check smoke test (`npm test`), a real multi-process concurrency test
  (`npm run test:concurrency`), and a runnable end-to-end demo (`npm run demo`).
- CI on Node 22 and 24. Setup guides for Claude Code and GPT, plus three importable starter packs.

### Security / robustness
- Binds `127.0.0.1` by default with CORS off (opt in via `ALLOW_ORIGIN`); documented local-first model.
- Hardened over three adversarial review rounds: fixed a remote DoS (missing-file crash), a stored XSS
  (operation and tab names), a persistent `/lint` poison via malformed `deps`, and made `import.bundle`
  truly per-item safe. Per-action type validation returns clean 400s.

[0.1.0]: https://github.com/RazElbazz/agent-ops
