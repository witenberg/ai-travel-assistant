# Roadmap

Written 2026-08-19 so work can continue in a fresh session with no prior context.
Read [`CLAUDE.md`](CLAUDE.md) first — it holds the architecture, the budget rules, the
language rule and the AgentCore lessons. This file holds only *what is left to do*.

---

## Resuming in a fresh session

```bash
aws sso login --sso-session perpaul          # SSO tokens expire; do this first
export AWS_PROFILE=ai-playground             # NEVER rely on the default profile

aws sts get-caller-identity                  # must show 687222805898 (mb-demos)
aws cloudformation describe-stacks --stack-name TravelAssistantStack \
  --query 'Stacks[0].StackStatus' --output text     # or "does not exist" if destroyed

cd /Users/jakub.wi/Desktop/ai_app
npm test && npm run typecheck                # 161 tests must pass (155 offline)
npm run verify:bundle                        # after any cdk synth, before any deploy
```

If the stack is gone, redeploy takes ~3 minutes:
`cd infra && npx cdk deploy --require-approval never` (Jakub must run this himself,
prefixed with `!` — the auto-mode classifier blocks `cdk deploy`).

Docker Desktop must be running before any deploy that rebuilds the image.

---

## Where things stand

**Works, verified end to end:**
- Agent loop (Bedrock Converse + tool use) locally and inside AgentCore Runtime
- Three tools: `get_place_details` (Wikipedia), `get_weather` (open-meteo),
  `get_photos` (Wikimedia Commons)
- Scope enforcement locally via `src/guard.ts`, with a `blocked` span
- Entry layer: API Gateway (Cognito authorizer, API key, usage plan, throttling) and the
  Lambda BFF — deployed and verified, see Step 3
- Memory: short-term history and long-term preference extraction — deployed and verified
  in the cloud, see Step 5
- AgentCore Gateway: the three keyless tools served over MCP by a Lambda target, with a
  REQUEST interceptor enforcing scopes per tool call — deployed and verified, see Step 4
- `Session → trace → span` reaching CloudWatch from the deployed Runtime
- `search_flights` (Duffel) with its key read from the AgentCore Identity token vault —
  deployed and verified, see Step 2
- One CDK stack: Cognito, Secrets Manager, Identity credential provider, Memory, Runtime,
  Gateway, log groups

**Not built:**
- Nothing on the original list. What remains is Step 8 (deeper observability), which was
  optional from the start.

**Removed from this roadmap (2026-08-19):** the two cost-telemetry steps — an AWS Budgets
guardrail and a Cost Explorer reconciliation. Both are *explicitly denied* to
`MB-EmployeeAccess`, and the account carries a hard 10 USD/month cap anyway, so the
guardrail they would add already exists one level up. Jakub's decision: stop spending
sessions on it. We still design for cost — cheap model, on-demand billing, nothing
always-on, the 100 requests/day quota — we just no longer treat *measuring* it as work.
Do not re-add these steps.

---

## Step 0 — Version control — **DONE (2026-08-19)**

`git init` on `main`, one initial commit of 40 files. `.gitignore` already covered
`node_modules/`, `dist/`, `cdk.out/` and `.env`; verified that `git ls-files | grep -c '\.env$'`
returns 0, so the live Duffel token was never committed.

**Still open:** no remote. Step 7 (CI/CD) needs one — GitHub is the assumption unless
Jakub prefers otherwise.

<details><summary>original notes</summary>

**Why first:** the project has no git repository at all. The mentoring goal explicitly
includes the whole SDLC, and every later step (CI/CD, review, ADR history) assumes one.
It is also the cheapest possible step.

- `git init`, commit the current tree
- Confirm `.gitignore` covers `node_modules/`, `dist/`, `cdk.out/`, `.env`
- **Check that `.env` is not committed** — it holds a live Duffel token
- Decide whether a remote is wanted (needed for Step 7)

**Verify:** `git status` clean, `git log` has one commit, `git ls-files | grep -c '\.env$'`
returns 0.

</details>

---

## Step 2 — Duffel token from the Identity token vault — **DONE, VERIFIED IN THE CLOUD (2026-08-19)**

Finishes [ADR-0002](docs/adr/0002-duffel-credential-through-agentcore-identity.md), whose
addendum records the two premises this step disproved.

**Verified end to end** — `./scripts/smoke-flights.sh`:

| Check | Result |
|---|---|
| Secret holds a real token | `duffel_test_…`, 55 chars, written with `put-secret-value` and never through CDK |
| The agent answered with real flights | five offers London→Lisbon, €84.65–€123.91, durations formatted by the tool |
| The key came from the vault | `{"event":"duffel.credential","source":"identity"}`, then `"source":"cache"` on the second call |
| The tool really ran | `tool.execute`, `search_flights`, `ok`, 2104 ms |
| Which header carried the token | `x-amz-bedrock-agentcore-identity-wat` — and two more names alongside it |

**Three deploys, and each failure moved the answer forward** — all of it now in `CLAUDE.md`
under "AgentCore Identity, outbound auth":

1. *Secrets Manager rejected the resource policy the AWS launch blog prescribes.* The principal
   `identity.bedrock-agentcore.amazonaws.com` is "unsupported"; `bedrock-agentcore.amazonaws.com`
   and `runtime-identity.bedrock-agentcore.amazonaws.com` are accepted. Probed with
   `put-resource-policy` in seconds rather than by deploying four times.
2. *The container received no workload access token at all.* The header-name diagnostic proved
   it — the delivery the docs describe needs an end user, and a SigV4 invocation names none.
   Fixed with `runtimeUserId` on the invocation plus `InvokeAgentRuntimeForUser` on the BFF role.
   The alternative, moving the Runtime to inbound JWT, would have rewritten the entry layer for
   one header; it stays available and is the stronger option if a real human user appears.
3. *`GetResourceApiKey` read the secret as our own runtime role*, which its AccessDenied named.
   One `grantRead` fixed it — and explained why step 1's resource policy was beside the point.

**What was built**

- `src/identity/workloadToken.ts` — picks the token off the invocation and scopes it to the turn
  with `AsyncLocalStorage`. Not a parameter, because it would have added an identity concern to
  four signatures that have no other reason to know about it; not module state, because two
  overlapping turns would then see each other's token. There is a test for that.
- `src/identity/apiKey.ts` — `GetResourceApiKey`, cached per container, dropped on a 401 so a
  secret rotated mid-session cannot poison every later turn.
- `src/tools/duffel/client.ts` — the credential is a seam now: environment variable locally, vault
  in the Runtime, and it logs *which* source served the key. An answer looks identical either way,
  so without that line "it works" would not distinguish the vault from a leftover variable.
- `scripts/smoke-flights.sh`, and the header-name diagnostic that answered the open unknown.

**Watch for:** the diagnostic is written once per container, so on a warm container it prints
nothing after a code change. A fresh `--runtime-session-id` forces a cold one.

**Not done here:** the Duffel token is static, so this exercises the *API key* half of the
diagram's `outbound (API key / OAuth 2)` edge. `get-resource-oauth2-token` has the same shape,
which is what ADR-0002 chose this route for.

---

## Step 3 — Entry layer: API Gateway + Lambda BFF — **DONE, VERIFIED IN THE CLOUD (2026-08-19)**

Deployed and checked end to end. `./scripts/smoke.sh`:

| Check | Result |
|---|---|
| Authorised call | `200` in 8.0 s, real forecast, `toolCalls: [get_weather]` |
| No token | `401` |
| Client-supplied `sessionId` | `200`, answered under the **derived** id, not the supplied one |
| `photos` asked with a token lacking `photos:search` | `200`, agent declines honestly, `blocked: true` |

The whole chain leaves one coherent trail: the `tool.authorize` / `blocked` span in the
Runtime log group carries the same `sessionId` the BFF derived, so `Session → trace → span`
holds across components rather than per component. The `bff.client_supplied_identity`
span is in `/aws/lambda/travel-assistant-bff` — the attempt to supply a session id is on
record, not silently dropped.

**Two deploys, two lessons, both now in `CLAUDE.md`:** a new API key takes about a minute
to propagate (a correct request returns `403 ForbiddenException` before that), and the
Lambda bundle must be CJS because AWS SDK v3 is CJS internally. `npm run verify:bundle`
now loads the synthesised artifact the way Lambda does, so the second one cannot repeat.

**What was built**

- `src/bff/handler.ts` — reads `sub` from the claims API Gateway already validated,
  derives `sessionId = sha256("travel-assistant:" + sub)` (64 hex chars, comfortably over
  the 33-character minimum), extracts tool scopes from the `scope` claim, and invokes the
  Runtime. A client-supplied `sessionId` or `scopes` is never read — and the attempt is
  recorded as a `blocked` span rather than silently dropped, so there is evidence it happened.
- Fails closed *before* Bedrock: a token with no tool scope gets 403 without an
  invocation, because a turn that can call no tool still costs money.
- 502 rather than 500 when the Runtime fails, so the status code says which component to look at.
- CDK: `NodejsFunction` (Node 22, ARM64, 256 MB, 28 s), REST API with a Cognito
  authorizer, an API key, a usage plan (2 rps, burst 5, **100 requests/day**) and
  stage-level throttling at the same rate.
- `scripts/smoke.sh` — fetches a client-credentials token and the API key from the stack
  outputs, then runs the three checks below.

**Decisions worth knowing**

- *Lambda timeout 28 s, one second under the API Gateway ceiling*, so the Lambda fails
  first and writes a span; if the gateway gave up first we would get a bare 504 with no
  record of how far the turn got.
- *Nothing marked external in the bundle.* The Node 22 runtime ships some of AWS SDK v3,
  but which clients and at which version is not a contract we control, and
  `client-bedrock-agentcore` is new. Two megabytes buys away a cloud-only failure mode.
- *`cloudWatchRole: false` on the API.* CDK creates an account-level
  `AWS::ApiGateway::Account` role by default; that is shared account-wide state which
  `cdk destroy` would either strand or reset for someone else. We do not use access logging.
- *256 MB, not more.* The function spends its life waiting on a socket, and that wait is
  billed in GB-seconds — memory size multiplies the cost of doing nothing.
- *The daily quota of 100 is the budget brake.* One turn is roughly three model calls,
  ~6k input and ~1k output tokens ≈ 1 US cent at Haiku 4.5 list rates. 100/day caps the
  worst case near 1 USD a day — a tenth of the account cap, which is the most we are
  willing to lose overnight to a runaway loop or a leaked key.

**Known limitation:** the only Cognito client is the machine (client-credentials) one, so
`sub` is the app client id and every caller shares one session. Custom scopes are only
issued through the OAuth token endpoint — `USER_PASSWORD_AUTH` access tokens carry
`aws.cognito.signin.user.admin` and nothing else — so a real per-human session needs a
hosted-UI client with the authorization-code flow. Deferred; `curl` testing does not need it.

<details><summary>original notes</summary>

**Why:** this completes the request path from [ADR-0001](docs/adr/0001-response-path-through-bff.md)
and is what makes `curl` testing real, which is how we said we would test in the absence
of a frontend. The BFF also carries the security control the ADR is built on.

- Lambda BFF: verifies nothing itself (API Gateway does the JWT), reads `sub` from the
  validated claims, derives `sessionId` from it, invokes the Runtime.
  **The client must never supply `sessionId`** — that is horizontal privilege escalation
  into another user's Memory. This is the whole reason the BFF exists.
- API Gateway REST with a Cognito authorizer, a usage plan and throttling.
  Throttling is the budget brake — do not skip it.
- Session ids must be at least 33 characters; derive deterministically from `sub`
  (e.g. a hash) so a user resumes their own session.

**Verify:** a `curl` with a Cognito token returns an answer; the same `curl` without a
token returns 401; a client-supplied `sessionId` in the body is ignored.

</details>

---

## Step 4 — AgentCore Gateway — **DONE, VERIFIED IN THE CLOUD (2026-08-19)**

Design and rejected alternatives: [ADR-0004](docs/adr/0004-tools-behind-the-gateway.md).
**The largest step, and the one closest to the project's purpose** — everything before it
used Runtime, Identity, Memory and Observability; the Gateway is the remaining major
AgentCore capability, and it is what the FigJam diagram actually draws.

Deployed in 80 s on the second attempt. `./scripts/smoke-gateway.sh`:

| Check | Result |
|---|---|
| `tools/list` over MCP, no agent in the path | three tools: `travel-tools___get_photos` / `_get_place_details` / `_get_weather`, with the schemas generated from the tools |
| `tools/call get_weather`, scope granted | real forecast, `"weekday":"Saturday"` computed by the tool |
| `tools/call get_photos`, scope **not** granted | `isError: true`, `{"error":"Missing scope \"photos:search\"...","blocked":true}` |
| Denial trace | `gateway.authorize` span, status `blocked`, carrying `requiredScope`, `grantedScopes` and `clientId` |
| Session survives the Gateway hop | those spans carry `sessionId` `7e6cb662…` — the id the BFF derived |
| The tool really ran in the target Lambda | `gateway.tool.execute`, `get_weather`, `ok`, 2794 ms, with `gatewayId` and `targetId` |
| End to end through the API | `200` in 8.3 s, `toolCalls: [{get_photos, blocked: true}, {get_weather, blocked: false}]`, forecast given and photos honestly refused |

The third row is the one that matters: there is no agent in that request, so the refusal can
only be AgentCore's. Before this step the same denial was produced by our own code, inside
the component being restricted.

**Two deploys, and the first one earned its keep.** It failed on a single field —
`credentialProviderConfigurations` on a Lambda target must be the bare type
`GATEWAY_IAM_ROLE` with **no** `credentialProvider` object, contradicting the CLI reference's
own Lambda-target example — and `cdk synth` cannot catch it, because the CloudFormation
schema permits the combination. It also proved the rest: `Gateway` reached `CREATE_COMPLETE`
before the target failed, so `CUSTOM_JWT`, the discovery URL, `allowedClients` and the
`REQUEST` interceptor with `passRequestHeaders: true` were all correct as written. The
rollback removed every gateway resource and left the stack as it was.

**Three findings from the running system**, all now in `CLAUDE.md`:

- the Gateway accepts only MCP `2025-03-26` and rejects anything else in the header, with a
  helpful error naming what it supports. Our client was unaffected because it sends its
  preferred version to `initialize` and then **adopts the server's answer**; the smoke
  script, which pinned `2025-06-18` and does no handshake, failed on the same run.
  Negotiating was a guess when it was written and paid off on first contact.
- a REQUEST interceptor runs **before** protocol-version validation, so a denial
  short-circuits the whole pipeline — and the interceptor must not assume it was handed a
  request the Gateway already found well-formed.
- `bedrockAgentCoreMcpMessageId` is the JSON-RPC id: a per-connection counter that restarts
  at 1, so the first run logged `"sessionId": "4"`. Now the Lambda request id is the
  correlation id and the message id is demoted to an attribute.

**One redeploy outstanding:** that last fix is committed and not deployed, so the target
Lambda in the cloud still labels its spans with the message id. Harmless, and it goes out
with whatever Step 2 changes next.

**Re-verify any time:** `./scripts/smoke-gateway.sh`. It asks Cognito for a token with
`tools/weather:read tools/places:read` and deliberately **not** `tools/photos:search`, then:

1. speaks MCP to the Gateway **directly, with no agent in the path**. This is first on
   purpose and costs no model tokens: when a tool call is refused, removing our own code from
   the request is the only way to know who refused it.
2. calls `get_weather`, which must return a real forecast.
3. calls `get_photos`, which must come back `isError` with `blocked: true`.
4. reads `/aws/lambda/travel-assistant-gateway-interceptor` for the `gateway.authorize` spans.
5. asks the agent for photos *and* weather through the API.

Note on step 4 of that script: log delivery lags a few seconds behind the call. An empty
result immediately after a request means the log has not arrived, not that nothing ran — the
same shape of mistake as reading an empty `retrieve-memory-records` as a broken strategy.

**What was built**

- `src/mcp/client.ts` — a minimal MCP client over Streamable HTTP (`initialize`,
  `tools/list`, `tools/call`), handling both a JSON and an SSE-framed reply, paginating the
  tool list, and never echoing the body of a 401/403.
- `src/tools/provider.ts` — the `ToolProvider` seam. `LocalToolProvider` runs tools in
  process under `guard.ts`; `CompositeToolProvider` routes by name and, deliberately, never
  falls back to another provider.
- `src/tools/gatewayProvider.ts` — the Gateway-backed provider. Strips the
  `travel-tools___` prefix so the model, the spans and the smoke tests keep naming tools the
  way the source does, and caches the catalogue per container.
- `src/gateway/toolTarget.ts` — one Lambda serving all three tools, dispatching on the tool
  name from the client context. Imports the same `getWeather` the agent used to call, so the
  existing tool tests still cover the logic.
- `src/gateway/interceptor.ts` — the REQUEST interceptor. Per-tool scope enforcement, failing
  closed on an unknown tool or an unreadable token, and writing the `blocked` span.
- `infra/lib/tool-schema.ts` — generates each target `ToolDefinition` from the tool's own
  `inputSchema`, throwing on any JSON Schema keyword AgentCore's `SchemaDefinition` lacks.
- The BFF now forwards the caller's access token; the Runtime hands it to the Gateway as the
  MCP bearer.

**Traps already paid for, without a deploy**

- Gateway and target names **forbid underscores** while the Runtime's name requires them.
  `cdk synth` reports it as a warning only.
- `Session → trace → span` does not cross the Gateway by itself. The interceptor gets the
  session id back through our own `x-travel-session-id` header; the target Lambda cannot get
  it at all.
- All of these and more are in `CLAUDE.md`, section "AgentCore Gateway".

**Known open ends**

- The Gateway's own log group may stay empty: log delivery for gateway resources is not
  configured automatically, and we did not set up a `Logs::Delivery` chain. It does not
  matter for the requirement, because the denial span lives in the interceptor's own group.
- `guard.ts` is now only reached for `search_flights` and in tests. It stays as the offline
  mirror of the interceptor, which is what lets the whole authorization rule be tested with
  no AWS at all.

## Step 5 — Memory — **DONE, VERIFIED IN THE CLOUD (2026-08-19)**

Design and rationale: [ADR-0003](docs/adr/0003-memory-keyed-on-actor-not-session.md).
Deployed in 189 s; the Memory resource updated **in place** as `cdk diff` predicted, so
`travel_assistant_memory-Np64SnHkoA` and its stored events survived.

**Verified in the cloud** — `./scripts/smoke-memory.sh`:

| Check | Result |
|---|---|
| Strategy live | `travel_preferences-6n4o2nBeG6`, `USER_PREFERENCE`, `ACTIVE` |
| Follow-up with no place name | "the weather like **there**" answered "This weekend in **Lisbon**" |
| Events actually written | both turns read back from `list-events`, question paired with answer |
| Spans in CloudWatch | `memory.load_history` / `load_preferences` / `save_turn`, `ok`, on both traces |

The place name in the second answer can only have come from history — that is the whole
test. The `list-events` read is what makes it evidence rather than a plausible answer.

**Measured latency added per turn** (from the spans, not estimated): `load_history`
81–119 ms and `load_preferences` 338–370 ms run concurrently, `save_turn` 110–131 ms
follows. About **0.5 s** on a path whose ceiling is ~29 s (ADR-0001). Recall is the
expensive half — semantic search, not the event read.

**Long-term extraction works too**, a few minutes after the conversation. From the two
turns above the strategy produced:

```
"Interested in visiting Lisbon, Portugal for a short holiday"
"Likes to check weather conditions when planning travel"
```

Two traps found here, both now in `CLAUDE.md`:

- `list-memory-extraction-jobs` returned `[]` the entire time, *including after extraction
  had demonstrably run*. It seems to list only jobs started with `StartMemoryExtractionJob`.
  An empty job list is not a signal — reading it as one almost produced a wrong conclusion.
- A record's `content.text` is **serialised JSON**, not prose:
  `{"context": ..., "preference": ..., "categories": [...]}`. Only `preference` belongs in
  the prompt. `preferenceText()` unwraps it, with a fallback to the raw string.

**One redeploy outstanding.** `preferenceText()` was written after the verification run,
so the container in the cloud still injects the whole JSON blob. Harmless but wasteful;
it goes out with the next deploy.

**What was built**

- `src/memory/store.ts` — a `MemoryStore` seam with two implementations, for the same
  reason `guard.ts` mirrors the Gateway: `NullMemoryStore` is what `npm run dev` uses, so
  a local run behaves like the deployed one minus recall rather than crashing.
- Short-term: one `CreateEvent` per turn carrying question and answer together; history
  read back with `ListEvents`, sorted by timestamp, capped at 10 turns.
- Long-term: one `USER_PREFERENCE` strategy in `/preferences/{actorId}`, retrieved with
  `RetrieveMemoryRecords` using the user's message as the search query, and rendered into
  the system prompt **labelled as possibly stale**.
- `actorId` split from `sessionId` — the person versus the conversation. Both derive from
  the same `sub` today; the split is what makes a real per-conversation session id a
  BFF-only change later.
- A `MemoryRole` for extraction, separate from the runtime role.
- Memory failure degrades the agent instead of breaking it: empty recall on a read
  failure, an answer still returned on a write failure, an `error` span either way.

**Verify after deploy** — `./scripts/smoke-memory.sh`:

1. "I am thinking about Lisbon…" then "What is the weather like **there** this weekend?"
   The second question has no place name in it, so an answer naming Lisbon can only have
   come from history.
2. The script then reads the events back with `list-events`, because a right-looking
   answer is not evidence that anything was written.
3. Long-term records are extracted **asynchronously** — minutes, not seconds. An empty
   `retrieve-memory-records` immediately after a turn is expected, not a failure. The
   script prints the command to re-check later.

**Cost note:** the new spend is mostly replayed history, not Memory itself. A long
conversation roughly doubles input tokens per turn, so the 100 requests/day quota now
caps the worst case nearer 2 USD/day than 1.

**Not done here:** conversation rotation (there is no "new chat" concept), and pruning
old sessions — `eventExpiryDuration: 7` handles that for us.

---

## Step 6 — The DynamoDB table — **DONE (2026-08-19): deleted**

Decision and rejected alternatives: [ADR-0005](docs/adr/0005-no-application-data-store.md).

The table had existed since the first deploy and **no code had ever touched it** — the runtime
role held `grantReadWriteData` and the container held `TABLE_NAME`, both for nothing. The two
kinds of state this system has are already placed: what the agent should remember about a
person is a preference (AgentCore Memory, keyed on the actor), and what it tells the user is
fresher from the source than from any store. So the table goes, along with its grant, its
environment variable and its stack output.

The saving is not money — an on-demand table costs near nothing at rest. It is consistency:
we argue every component from Well-Architected, and a component that exists because a diagram
drew it fails that test on the pillar we said dominates. An empty resource is also worse than
no resource, because it invites code to be written for the resource's sake.

**Verified:** `cdk diff` showed the table as the only removal, with nothing else replaced.
`AgentCore Memory is now the system's only state`, and the smoke scripts still pass.

**Comes back when, and only when,** something needs it — saved itineraries being the obvious
candidate. Re-adding the table is ten lines of CDK; deciding what it stores is the work, and
that belongs to the feature.

---

## Step 7 — CI/CD — **DONE (2026-08-19): CI is in; CD stays manual by decision**

Decision and rejected alternatives: [ADR-0006](docs/adr/0006-ci-verifies-humans-deploy.md).

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

| Step | What it protects against |
|---|---|
| `.env` must not be tracked | publishing a live Duffel token |
| `npm run typecheck` (root and `infra`) | a type error reaching a deploy |
| `npm run test:offline` — 155 tests | a logic or wiring regression |
| `npx cdk synth` | a template that no longer synthesises |
| `npm run verify:bundle` | a bundle that synthesises and then dies on load (the CJS lesson) |

**Verified before committing**, by running the whole sequence locally with credentials made
unavailable — `AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null npx cdk synth`
exited 0. So the workflow genuinely needs no AWS account, which is the property that lets it
run on a repository nobody has granted anything to yet.

**Two facts worth keeping:**

- **`cdk synth` does not build container image assets.** CDK builds them at publish time,
  during `cdk deploy`. That is what makes a Docker-free CI possible — otherwise every pull
  request would build an ARM64 image under QEMU on an x64 runner.
- **`npm run test:offline`** is `npm test` with `--test-skip-pattern='network'`, which drops
  the six tests that call open-meteo, Wikipedia and Commons. They stay in `npm test` (161) and
  run locally; as a merge gate they would fail on someone else's outage.

**What is left for Jakub — attaching the remote.** Nothing in the workflow needs configuring
afterwards; Actions picks it up on the first push.

```bash
cd /Users/jakub.wi/Desktop/ai_app
gh repo create ai-travel-assistant --private --source=. --remote=origin --push
# or, without gh:
#   git remote add origin git@github.com:<user>/ai-travel-assistant.git
#   git push -u origin main
```

Then open a throwaway pull request to watch the gate run, because a workflow that has never
run is not a workflow that works — same principle as the rest of this file.

**Deliberately not done: deploying from CI.** It needs `sts:AssumeRole` on the CDK bootstrap
roles, which only Paweł can grant (`docs/blocker-iam.md`), and on a 10 USD account with no
cost telemetry it would turn a careless merge into spend. ADR-0006 records the OIDC exit path
in enough detail to implement in one sitting if that changes.

---

## Step 8 — Deeper observability (optional)

- CloudWatch Transaction Search plus ADOT gives the CloudWatch GenAI dashboard, service
  spans and latency percentiles. Our own JSON spans already satisfy the diagram, so this
  is for the AWS-native view.
- **p99 turn latency is the metric that matters:** ADR-0001 accepts a ~29 s API Gateway
  ceiling, and p99 approaching it is the documented signal to move to streaming (v2).
  Nothing measures it yet.
- Alarms on Runtime errors and throttles

---

## Open decisions

| Decision | Notes |
|---|---|
| ~~Lambda vs OpenAPI Gateway targets~~ | Decided in ADR-0004: Lambda target for the three keyless tools, `search_flights` stays in the Runtime |
| ~~Whether the DynamoDB table survives~~ | Decided in ADR-0005: deleted |
| Whether a frontend is ever built | Deferred; `curl` remains the interface |
| ~~Git remote and where CI runs~~ | GitHub, decided 2026-08-19. CI is written and verified offline; Jakub attaches the remote (Step 7) |

## Rules that always apply

- **`cdk destroy` after a working session.** Idle cost is near zero but the habit is the point.
- **Show `cdk diff` before any deploy.** Jakub runs `cdk deploy` himself with `!`.
- **English in the repo**, Polish in conversation.
- **Explain decisions and rejected alternatives** — this is a learning project.
- **Record architectural decisions as ADRs** in `docs/adr/`.
- **`READY` and `200` do not mean it works.** Verify by observing output.
