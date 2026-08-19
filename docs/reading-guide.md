# Reading guide — how the FigJam board looks in code

Written for the one purpose this project has: to see what each box on the board became.
Nothing here is new information; it is an order to read things in, and for each step the
command that makes the code do the thing you just read.

**~1 700 lines of source, ~1 900 of tests, in 22 files.** Small enough to read in a sitting,
which was deliberate — the application logic stays thin so the infrastructure stays the
interesting part.

Everything below assumes:

```bash
cd /Users/jakub.wi/Desktop/ai_app
export AWS_PROFILE=ai-playground        # never the default profile
npm test                                 # 174 tests, ~7 s
```

---

## Step 0 — the map, five minutes

Read in this order, and no code yet:

1. `README.md` — what this is and why it exists.
2. The mermaid diagram in `CLAUDE.md`, section "Architecture". It is the board, redrawn with
   our deviations already applied.
3. `docs/adr/` — six decisions, each with the alternatives rejected. Read the **Decision**
   and **Rejected** parts and skip the rest for now.

| Board box | File |
|---|---|
| Customer → API Gateway (JWT + throttling, usage plan, API keys) | `infra/lib/travel-assistant-stack.ts` (search `RestApi`) |
| Lambda BFF, "maps user to sessionId" | `src/bff/handler.ts` |
| AgentCore Runtime, "travel assistant agent" | `src/server.ts` + `src/agent.ts` |
| Amazon Bedrock LLMs | `src/agent.ts` (the `ConverseCommand` loop) |
| AgentCore Memory, "session & preferences" | `src/memory/store.ts` |
| AgentCore Gateway (managed MCP) | `src/mcp/client.ts`, `src/tools/gatewayProvider.ts` |
| Lambda targets, the three tools | `src/gateway/toolTarget.ts`, `src/tools/*.ts` |
| interceptors inbound / outbound | `src/gateway/interceptor.ts`, `src/gateway/responseInterceptor.ts` |
| AgentCore Identity, outbound (API key / OAuth 2) | `src/identity/*.ts`, `src/tools/duffel/client.ts` |
| AgentCore Observability → CloudWatch | `src/observability/trace.ts` |
| ~~DynamoDB~~, ~~AgentCore Browser~~ | deleted — ADR-0005, and `CLAUDE.md` "Deviations" |

---

## Step 1 — the agent loop, on your own machine

**Read:** `src/agent.ts` (197 lines). This is the whole "AI" part. A `while` loop around
`ConverseCommand`: send the conversation, if the model asks for a tool run it, append the
result, send again, stop when it stops asking. `MAX_TURNS = 6` is budget protection.

Then `src/prompt.ts` — note that the current date is injected, because without it every
"this weekend" is guesswork.

**Run it:**

```bash
npm run dev                     # asks Bedrock directly, tools run in this process
```

This path uses no AgentCore at all: `LocalToolProvider` runs the tools in the same Node
process, `guard.ts` decides what is allowed, and `NullMemoryStore` forgets everything. That
is the point of the seams — the same agent code runs with or without the cloud, so you can
read the logic before meeting the infrastructure.

**Then read** `src/tools/getWeather.ts`. Two design rules live there and both were paid for
with real agent failures: the weekday name is computed in code, and there is no `days`
parameter. `CLAUDE.md` → "Tool design principles" has the story.

---

## Step 2 — the seams, which is where the design actually is

Three interfaces, one purpose: the agent must not know whether it is talking to AWS.

- `src/tools/provider.ts` — `ToolProvider`. `LocalToolProvider` (in-process, guarded by
  `guard.ts`) versus `GatewayToolProvider` (over MCP, authorized by AgentCore).
  **Read the comment on `CompositeToolProvider`**: it never falls back between providers, and
  the reason is a security argument, not a style choice.
- `src/memory/store.ts` — `MemoryStore`, with a null implementation for local runs.
- `src/tools/duffel/client.ts` — the credential source: environment variable locally,
  AgentCore Identity token vault in the cloud.

If you read only one thing today, read these three files and their headers. Everything else
is a consequence.

---

## Step 3 — the entry layer, and the one security control

**Read:** `src/bff/handler.ts` (230 lines). The BFF verifies nothing — API Gateway already
did — and exists for one line: `deriveSessionId(sub)`. A client that could send its own
`sessionId` could read another user's memory, so the client never gets to.

Note three things: the client-supplied identity attempt is *recorded* rather than silently
dropped; a token with no tool scope is refused **before** Bedrock, because a turn that can
call no tool still costs money; and `runtimeUserId` is what makes AgentCore hand the container
a workload access token.

**Run it:** open `requests/api.http` (see `requests/README.md`) and send:

1. `get a machine token` — a Cognito client-credentials token, with scopes.
2. `ask the agent` — a real turn. Watch `toolCalls` and `build` in the response.
3. `ask without the photos scope` — the agent refuses honestly. **That refusal is the whole
   project in one response.**

---

## Step 4 — the Gateway, and who says no

This is the part the board is really about. Read in this order:

1. `src/gateway/naming.ts` — 30 lines, and it explains the `travel-tools___get_weather`
   prefix that shows up everywhere.
2. `src/gateway/interceptor.ts` — the inbound interceptor. Per-tool scope enforcement, and
   every branch fails closed. The denial is shaped as a JSON-RPC *success* carrying
   `isError: true`, because that reaches the model as a failed tool result it can explain.
3. `src/gateway/responseInterceptor.ts` — the outbound one. It only observes, and the header
   comment says why it exists at all (a target Lambda cannot know the session id).
4. `src/mcp/client.ts` — ~265 hand-rolled lines of MCP over Streamable HTTP. Read
   `connect()` and the comment about *not* memoising a failed handshake.

**Run it:** in `requests/gateway.http`, send the MCP requests **with no agent in the path**:
`initialize`, `tools/list`, then `tools/call get_weather` (allowed) and `tools/call get_photos`
(denied). The last one is the experiment that matters: there is no code of ours in that
request, so the refusal can only be AgentCore's.

---

## Step 5 — memory, and why it is keyed on the actor

**Read:** `src/memory/store.ts` and then ADR-0003. The two ids are the point: a *session* is
one conversation, an *actor* is a person, and what the agent learns is keyed on the second so
it outlives any one chat.

**Run it:** `./scripts/smoke-memory.sh`. Ask about Lisbon, then ask "what is the weather like
**there**" — the second question has no place name, so an answer naming Lisbon can only have
come from history.

---

## Step 6 — observability, which is a functional requirement here

**Read:** `src/observability/trace.ts` (105 lines). `Session → trace → span`, JSON lines on
**stderr** — the Runtime drops stdout, which cost a deploy to discover.

**Where to look:**

| What you want to see | Log group |
|---|---|
| The agent's own spans: model calls, tool calls, memory | `/aws/bedrock-agentcore/runtimes/travel_assistant-m6PLoMGxv5-DEFAULT` |
| The denial trace (`gateway.authorize`, status `blocked`) | `/aws/lambda/travel-assistant-gateway-interceptor` |
| Tool outcomes on the way back (`gateway.tool.response`) | `/aws/lambda/travel-assistant-gateway-response-interceptor` |
| What the tools actually did (`gateway.tool.execute`) | `/aws/lambda/travel-assistant-gateway-tools` |
| The BFF's mapping and refusals | `/aws/lambda/travel-assistant-bff` |

Query them with the **JSON** filter syntax — a quoted substring matches nothing and looks
exactly like an empty log group:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/travel-assistant-gateway-interceptor \
  --start-time $(( ($(date +%s) - 900) * 1000 )) \
  --filter-pattern '{ $.name = "gateway.authorize" }' \
  --query 'events[].message' --output text
```

---

## Step 7 — the infrastructure, last on purpose

**Read:** `infra/lib/travel-assistant-stack.ts` (~620 lines, over half of it comments). Read it
top to bottom *after* the code, so each resource is something you already recognise. The
comments are where the traps live — underscores forbidden in gateway names, `GATEWAY_IAM_ROLE`
with no credential provider object, `logs:CreateLogGroup` or the log group silently never
appears.

```bash
cd infra && AWS_PROFILE=ai-playground npx cdk diff    # safe, read-only
```

---

## How to test, day to day

| Want | Command |
|---|---|
| Everything offline | `npm test` (174) |
| Everything except the internet | `npm run test:offline` (155, what CI runs) |
| Types | `npm run typecheck` |
| The synthesised Lambda bundles really load | `npm run verify:bundle` |
| Poke the deployed API by hand | `requests/*.http` (see `requests/README.md`) |
| Prove the whole entry path | `./scripts/smoke.sh` |
| Prove the Gateway and the denial | `./scripts/smoke-gateway.sh` |
| Prove memory | `./scripts/smoke-memory.sh` |
| Prove outbound auth | `./scripts/smoke-flights.sh` |

**Two rules that will save you an evening**, both learned the hard way:

- A `200` right after a deploy can come from the **previous** container: a session keeps its
  warm container until it goes idle. Check the `build` field in the response — it is the
  container image's asset tag. A fresh `--runtime-session-id` forces a cold container.
- `READY` and `200` do not mean it works. Verify by observing output — a span, a stored event,
  a real forecast — never by reading a status field.

---

## What is deliberately missing

- **A human login.** The only Cognito client is machine-to-machine, so every caller shares one
  session and one long-term memory. The code for per-user identity is already there and
  tested; what is missing is a hosted-UI client with the authorization-code flow. Nothing in
  this guide needs it.
- **A frontend.** `curl` and the `.http` files are the interface.
- **Reliability.** Deliberately skipped in `docs/well-architected.md`, with the reasoning.
- **Cost telemetry.** Denied to our role; the account cap replaces it. See `ROADMAP.md`.
