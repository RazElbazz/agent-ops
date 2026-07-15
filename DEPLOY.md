# Running and hosting agent-ops

agent-ops is **local-first by design**. The data lives in a single SQLite file (`data.db`) next to the
server, which is exactly what makes it private and simple. You do not need a cloud account to use it.

## Local (the normal way)

```bash
npm run seed     # first time only (or run your own seed.local.mjs)
npm start        # http://localhost:8791
```

Or without cloning, straight from GitHub:

```bash
npx github:RazElbazz/agent-ops
```

The launcher passes `--experimental-sqlite` for you (needed on Node 22.x, a no-op on Node 24+).

## Share one instance across your machines (LAN)

The server binds all interfaces on its port, so other devices on your network can reach it at
`http://<your-lan-ip>:8791`. Point each agent's `AGENT_OPS` base URL there. Keep it on a trusted
network — there is no auth layer (it is meant to run on your own machine/LAN).

## Expose it temporarily (tunnels)

For a quick remote demo, put a tunnel in front of the local server:

```bash
npm start
# in another shell, e.g.
cloudflared tunnel --url http://localhost:8791
# or: ssh -R 80:localhost:8791 <your-tunnel-host>
```

Treat any public URL as sensitive: the write gateway is open, so only expose it when you mean to.

## About "serverless" / Vercel

A serverless platform gives each request an ephemeral, read-only filesystem, so a local SQLite file
would not persist between requests — the wrong fit for this design. If you want a hosted, always-on
instance, run it on a small always-on box (a VPS, a Raspberry Pi, a home server) with:

```bash
PORT=8791 npm start
```

and keep it alive with your process manager of choice (`systemd`, `pm2`, `tmux`). Point your agents'
`AGENT_OPS` at that host. The database stays a single file you can back up with `cp data.db …` or
`curl <host>/export > system.json`.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | `8791` | Server port |
| `AGENT_OPS_DB` | `./data.db` | SQLite file path (use a scratch path for tests/demos or a second instance) |

That is the whole surface. Local-first, one file, zero dependencies.
