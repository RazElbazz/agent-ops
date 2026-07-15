# Using agent-ops with GPT (or any function-calling agent)

The protocol is just HTTP + JSON, so agent-ops is model- and language-agnostic. GPT, a local model,
a LangChain agent, a cron job — anything that can make HTTP calls can be an agent-ops client.

## The idea

Give your agent two tools:

1. a way to **read** the API (`GET /manifest`, `/op/:name`, `/knowledge`, `/search`), and
2. one **write** tool: `POST /action` (the single atomic gateway).

Then the system prompt is tiny, because the real instructions live in the operations you pull at runtime.

## Minimal Python client

```python
import requests
BASE = "http://localhost:8791"

def get(path): return requests.get(BASE + path).json()
def action(a, payload, chat="gpt"):
    return requests.post(BASE + "/action", json={"action": a, "payload": payload, "chat": chat}).json()

# 1. bootstrap
manifest = get("/manifest")
print(manifest["protocol"])

# 2. pull the operation you need (+ its deps, recursively)
def pull(name, seen=None):
    seen = seen or set()
    if name in seen: return []
    seen.add(name)
    op = get(f"/op/{name}")
    ops = [op]
    for d in op["deps"]:
        ops += pull(d, seen)
    return ops

ops = pull("outreach.batch")
knowledge = get("/knowledge?category=outreach")

# 3. build the model prompt FROM the pulled operation + knowledge
system = ops[0]["prompt"] + "\n\nKnowledge:\n" + "\n".join(f"- {k['key']}: {k['value']}" for k in knowledge)
# ... call your model with `system` ...

# 4. write every result/decision back through the one gateway
action("record.add", {"component": "outreach", "type": "lead", "data": {"company": "Acme", "domain": "acme.com"}})
action("trace.add", {"op": "outreach.batch", "chain": ["lead.find", "draft.message"], "status": "ok"})
```

## Exposing `/action` as an OpenAI tool

Register one function so the model can write state itself:

```json
{
  "type": "function",
  "function": {
    "name": "agent_ops_action",
    "description": "Write a change to agent-ops (the single atomic gateway). Use for every state change.",
    "parameters": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "description": "e.g. task.add, knowledge.set, record.add, op.set, trace.add" },
        "payload": { "type": "object" }
      },
      "required": ["action", "payload"]
    }
  }
}
```

Your handler just forwards it: `requests.post(BASE + "/action", json={"action": action, "payload": payload, "chat": "gpt"})`.
Pair it with a read function that GETs `/op/:name` and `/knowledge` and the agent is fully wired.

## Discovering what to call

- `GET /manifest` lists every operation, component, knowledge category, and the full action list.
- `GET /search?q=<term>` matches across operations, knowledge, and components.
- `GET /root-cause` tells you which operation is breaking chains, so the agent can fix it via `op.set`.

Because everything is pulled fresh at runtime, upgrading an operation once upgrades every agent that
uses it — regardless of which model or framework they run on.
