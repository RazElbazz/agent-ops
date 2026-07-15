# Examples

The fastest way to understand agent-ops is to watch it run:

```bash
npm install        # (no deps; just sets up scripts)
node examples/demo.mjs
```

`demo.mjs` spins up an **isolated** server (its own scratch DB, port 8799 — your real data is never
touched), seeds the generic examples, then role-plays an agent doing one task end to end and prints
every protocol step:

```
bootstrap (/manifest) → pull an operation + its deps recursively → pull knowledge
→ execute → log a trace (one fails) → GET /root-cause → fix the op via op.set (version bumps)
```

That is the entire model. Everything else is detail.

## Guides

| File | What it covers |
|------|----------------|
| [claude-code.md](claude-code.md) | Wire agent-ops into **Claude Code** (Opus 4.8) and its workflow system. Drop `AGENTS.md`, and every chat/subagent stays in sync through the one server. |
| [openai-gpt.md](openai-gpt.md) | Wire it into **GPT / any function-calling agent**. The protocol is just HTTP, so it is language- and model-agnostic. Python example included. |
| [add-an-operation.md](add-an-operation.md) | Author your **own operations, knowledge, and components** — the anatomy of a self-describing operation, how deps compose, and how the self-improvement loop works. |

## The one rule

Whatever agent or model you use, the contract is the same:

> On any task: **pull** what you need from the API (`/manifest`, `/op/:name` + its deps, `/knowledge`),
> **act** per the pulled prompts, and **send every change back** through the single atomic gateway
> (`POST /action`). Never write state any other way.

Keep your real, private data out of this public repo — put it in a local, gitignored
`seed.local.mjs` (see the top-level README). The examples here are all generic.
