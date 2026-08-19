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
npm test && npm run typecheck                # 52 tests must pass
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
- `Session → trace → span` reaching CloudWatch from the deployed Runtime
- One CDK stack: Cognito, DynamoDB, Secrets Manager, Identity credential provider,
  Memory, Runtime, log group

**Built but not working in the cloud:**
- `search_flights` (Duffel). The secret still holds `REPLACE_ME` and the tool reads
  `DUFFEL_ACCESS_TOKEN` from the environment instead of the Identity token vault.

**Created but unused:**
- AgentCore Memory — `MEMORY_ID` is passed to the container and ignored
- DynamoDB table — no code touches it

**Built, awaiting deploy:**
- API Gateway (Cognito authorizer, usage plan, throttling) and the Lambda BFF — Step 3

**Not built:**
- AgentCore Gateway with tool targets
- CI/CD

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

## Step 1 — Budget guardrail — **BLOCKED (2026-08-19), needs Paweł**

Both routes are denied to `MB-EmployeeAccess`, by an *explicit deny* rather than a
missing grant — so no amount of policy attachment on our side changes it:

```
budgets:ViewBudget  -> AccessDeniedException ... with an explicit deny in an identity-based policy
ce:GetCostAndUsage  -> AccessDeniedException ... with an explicit deny in an identity-based policy
```

This is the same guardrail family as the IAM deny in `docs/blocker-iam.md`. Do not spend
another session on it; it is a request for Paweł — either a budget created on his side
with an alert to Jakub, or `ce:GetCostAndUsage` granted so we can read spend ourselves.

**Consequence, and it matters:** we have *no* automated cost signal and no way to read
actual spend. Every cost control is therefore architectural and preventive — the 100
requests/day usage-plan quota, the 2 rps throttle, on-demand billing everywhere, no
always-on components, and `cdk destroy` after each session. That also means Step 9
(confirm real costs) cannot be done from this account at all until the deny is lifted.

<details><summary>original notes</summary>

**Why:** the account cap is 10 USD and nothing currently warns us. Every other step
spends money. This is the only step that protects the others.

- AWS Budgets: a cost budget at 5 USD with an email alert, plus a forecast alert
- Consider a second alert at 8 USD

**Known risk:** Budgets lives under billing permissions, which are frequently denied on
member accounts. If `aws budgets create-budget` fails, that is a request for Paweł —
do not spend a session fighting it. Fallback: a CloudWatch billing alarm, or a manual
Cost Explorer check at the start of each session.

**Verify:** the budget is listed by `aws budgets describe-budgets --account-id 687222805898`.

</details>

---

## Step 2 — Duffel token from the Identity token vault

Finishes [ADR-0002](docs/adr/0002-duffel-credential-through-agentcore-identity.md).

**Open unknown, resolve this first:** how does code inside the Runtime obtain its
workload access token? `GetWorkloadAccessToken` called from outside fails with
*"WorkloadIdentity is linked to a service and cannot retrieve an access token by the
caller"*, so the chain cannot be tested from the CLI. The Runtime already has a workload
identity: `workload-identity-directory/default/workload-identity/travel_assistant-m6PLoMGxv5`.
Likely the container receives a token through an environment variable or a local
endpoint; the Python AgentCore SDK hides this behind `@requires_api_key`. Find the
mechanism before writing code — check the runtime's own environment by logging
`process.env` keys once from inside the container.

**Then:**
- Put the real token into the secret:
  `aws secretsmanager put-secret-value --secret-id <DuffelSecretArn> --secret-string '{"token":"duffel_test_..."}'`
- Add a credential-source seam to `src/tools/duffel/client.ts`: environment variable
  locally, `GetResourceApiKey` in the Runtime. Cache the key in module scope.
  API shape: `get-resource-api-key --workload-identity-token <t> --resource-credential-provider-name duffel-api-key`
- The Runtime role already holds `GetWorkloadAccessToken` and `GetResourceApiKey`

**Verify:** invoke the deployed Runtime with a flights question; the answer contains real
prices and the log group shows a `tool.execute` span for `search_flights`.

**Watch for:** never log the retrieved key. There is already a test asserting that a 401
body is not echoed — keep that property.

---

## Step 3 — Entry layer: API Gateway + Lambda BFF — **BUILT, NOT YET DEPLOYED (2026-08-19)**

Code and infrastructure are written, 17 new tests pass, `cdk diff` is clean. What is
left is the deploy itself, which Jakub runs.

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

**Verify after deploy:** `./scripts/smoke.sh` — an authorised call answers, the same call
without a token returns 401, and a client-supplied `sessionId` comes back replaced by the
derived one. Then confirm the BFF's spans in `/aws/lambda/travel-assistant-bff`.

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

## Step 4 — AgentCore Gateway with tool targets

**The largest step, and the one closest to the project's purpose.** Everything so far
uses Runtime, Identity, Memory and Observability; the Gateway is the remaining major
AgentCore capability, and it is what the FigJam diagram actually draws.

**Decision required before coding** (see ADR-0002 for the trade-off already analysed):
- **Lambda targets** keep our tested transformations (IATA resolution, weekday names,
  Commons attribution) but the Gateway does not inject outbound credentials for them
- **OpenAPI targets** let the Gateway inject credentials and need no code, but hand the
  model raw JSON, which contradicts the tool-design principles in `CLAUDE.md`

A defensible split: Lambda targets for the three transforming tools, plus one trivial
OpenAPI target purely to demonstrate Gateway-injected credentials.

**Work:**
- `CfnGateway` with `authorizerType: CUSTOM_JWT` and a `CustomJWTAuthorizer` pointing at
  the Cognito discovery URL
  (`https://cognito-idp.us-east-1.amazonaws.com/us-east-1_WuhBjq1L7/.well-known/openid-configuration`),
  `allowedClients` set to the machine client
- `CfnGatewayTarget` per tool, with `credentialProviderConfigurations`
- **Interceptors** enforcing scopes — this replaces `src/guard.ts` in production;
  keep `guard.ts` as the local mirror so tests still run offline
- The agent must become an MCP client to reach Gateway tools. This is the real refactor:
  `src/agent.ts` currently executes tools in process
- Gateway logs are **not** configured automatically — see `CLAUDE.md`, log delivery for
  gateway and memory resources must be set up explicitly

**Verify:** a scope-denied call produces the `blocked` trace *from the Gateway*, not from
our code, and the deployed agent still answers correctly with tools it is allowed.

---

## Step 5 — Memory

**Why:** Memory is deployed and ignored, which is both a waste and a gap in the learning
goals. It is also what makes the assistant feel like an assistant.

- Short-term: persist turns per session, load history on invocation. `src/agent.ts`
  already accepts a `history` parameter designed for this.
- Long-term: extract preferences (favourite destinations, budget style) into strategies
- Memory has `MemoryStrategies` and `IndexedKeys` in CloudFormation — worth reading
  before designing the schema

**Verify:** two invocations with the same session id; the second answers a question that
only makes sense given the first ("and what about the weather there?").

---

## Step 6 — Give the DynamoDB table a job, or delete it

An unused resource contradicts our own Cost Optimization stance. Either it stores
something real (saved itineraries, a per-user profile that outlives Memory expiry) or it
goes. **Deleting it is a perfectly good outcome** — do not invent a use for it.

---

## Step 7 — CI/CD

Depends on Step 0 and a remote. The mentoring goals name CI/CD explicitly.

- On pull request: `npm test`, `npm run typecheck`, `cdk synth`
- Deployment stays manual, or uses OIDC to assume the CDK `deploy` role
- Note the constraint from `CLAUDE.md`: our identity has an explicit IAM deny and
  deploys go through the bootstrap roles. Any CI role needs `sts:AssumeRole` on those,
  granted by Paweł — the same conversation as `docs/blocker-iam.md`

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

## Step 9 — Confirm real costs — **blocked with Step 1**

`ce:GetCostAndUsage` is explicitly denied, so Cost Explorer cannot be read from this
account at all. Blocked until Paweł lifts the deny.

<details><summary>original notes</summary>

We never established Bedrock rates for Haiku 4.5 — the Price List API only carries
legacy models and the pricing page is JS-rendered. After a day of real usage, read Cost
Explorer and write the actual per-invocation cost into `CLAUDE.md`. Measured numbers beat
a price list we could not read.

---

</details>

## Open decisions

| Decision | Notes |
|---|---|
| Lambda vs OpenAPI Gateway targets | Step 4; trade-off already analysed in ADR-0002 |
| Whether the DynamoDB table survives | Step 6; deletion is fine |
| Whether a frontend is ever built | Deferred; `curl` remains the interface |
| Git remote and where CI runs | Step 0/7 |

## Rules that always apply

- **`cdk destroy` after a working session.** Idle cost is near zero but the habit is the point.
- **Show `cdk diff` before any deploy.** Jakub runs `cdk deploy` himself with `!`.
- **English in the repo**, Polish in conversation.
- **Explain decisions and rejected alternatives** — this is a learning project.
- **Record architectural decisions as ADRs** in `docs/adr/`.
- **`READY` and `200` do not mean it works.** Verify by observing output.
