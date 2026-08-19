# ADR-0004: Tools move behind AgentCore Gateway, authorized by the caller's own token

- **Status:** accepted
- **Date:** 2026-08-19
- **Context:** ROADMAP step 4. Until now the agent executed tools in its own process and
  decided for itself which ones it was allowed to call, in `src/guard.ts`. That is the
  arrangement this ADR is about: the component being restricted was also the component
  enforcing the restriction. AgentCore Gateway is the remaining major capability of the
  platform we are here to learn, and it is the piece the FigJam diagram actually draws —
  including a second diagram whose entire subject is per-scope authorization at the Gateway.

## What the platform offers

Verified against the AgentCore developer guide and the CloudFormation registry in
`aws-cdk-lib` 2.265, not from memory:

- A Gateway is a **managed MCP server**. Its endpoint is
  `https://<id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`, and a client reaches
  it by speaking JSON-RPC 2.0 over Streamable HTTP. There is no AWS SDK call that invokes a
  gateway tool — the protocol *is* the interface.
- **Inbound auth** is `CUSTOM_JWT` (an OIDC discovery URL plus `allowedClients` /
  `allowedAudience` / `allowedScopes`) or IAM. The Gateway validates the token itself.
- **Targets** carry the tools. A Lambda target registers a `ToolDefinition` per tool and
  receives the tool arguments as its `event`; the tool name arrives in
  `context.clientContext.custom.bedrockAgentCoreToolName`, prefixed with the target name and
  a triple underscore, and the docs say stripping that prefix is the function's job.
- **Interceptors** are Lambdas invoked at `REQUEST` and/or `RESPONSE`, at most one of each.
  A REQUEST interceptor can rewrite the request or answer it outright by returning
  `transformedGatewayResponse`. Request headers reach it only if `passRequestHeaders: true`.
- Gateway and gateway-target names are validated against `^([0-9a-zA-Z][-]?){1,100}$` —
  **no underscores**, the exact opposite of `CfnRuntime`, whose name requires them.

## Decision 1 — three tools move, `search_flights` stays

`get_place_details`, `get_weather` and `get_photos` become one Lambda target. They are the
three keyless tools, and moving them is what buys the Gateway's authorization.

`search_flights` stays inside the Runtime. ADR-0002 routes its Duffel token through the
AgentCore Identity token vault, which the Runtime's workload identity can reach and a
Gateway Lambda target cannot. The two ways to move it are both worse:

- an **OpenAPI target** with the Gateway injecting the API key — the mechanism we would most
  like to exercise, but it hands the model raw Duffel JSON and throws away the IATA
  resolution and duration formatting the tool exists to do. Rejected already in ADR-0002.
- a **Lambda target reading Secrets Manager directly** — simple, and it deletes the Identity
  layer from the architecture, which is the layer the tool was built to demonstrate.

So the agent has two tool sources, joined by `CompositeToolProvider`. That composite routes
by name and deliberately does **not** fall back: if the Gateway refuses a tool, the local
provider must not then run it. A fallback there would look like resilience and would be a
bypass of the authorization this whole step introduces.

**One Lambda for three tools**, not three. They share an HTTP client and a geocoder, none
needs a different timeout, and the target already namespaces them — three functions would
buy three cold starts and three log groups.

## Decision 2 — the caller's token is forwarded; the agent does not get its own

The access token the user presented to API Gateway is passed on: BFF → Runtime payload →
`Authorization: Bearer` on the MCP request to the Gateway.

The alternative was for the Runtime to hold its own machine-to-machine Cognito token, via an
AgentCore Identity OAuth2 credential provider. That is the more conventional
"the agent has an identity" pattern, and it is wrong here for one decisive reason: the
Gateway would then see the *agent* on every call, and per-user scopes would have nowhere
left to be enforced. We would be back to `guard.ts` deciding, with a Gateway in the path
adding a hop and no authorization. The diagram's `Request → IdP (Cognito, scopes) → Gateway`
describes token pass-through, and `passRequestHeaders` exists precisely to carry user
context into the Gateway.

The cost is that a user's token now travels one hop further, in an invocation payload rather
than only in an HTTP header. It stays server-side the whole way — only the BFF holds
`InvokeAgentRuntime` — it is never written to a log, and there is a test in both the BFF and
the interceptor asserting exactly that.

## Decision 3 — scopes are enforced by a REQUEST interceptor, per tool

`allowedScopes` on the authorizer is a single gate for the whole gateway: one scope, every
tool. What we need is per tool, so a REQUEST interceptor Lambda reads the required scope
from the tool registry — the same `requiredScope` field `guard.ts` reads — and compares it
to the `scope` claim of the token the Gateway just validated.

Three consequences worth stating:

- **The interceptor decodes the JWT without verifying it.** That sentence is normally a
  vulnerability, so the justification lives next to the code: an interceptor runs *after*
  the Gateway's `CUSTOM_JWT` authorizer has checked signature, issuer, expiry and client.
  Fetching JWKS inside every tool call to re-derive a decision AWS just made would add
  latency and a second implementation of one security check.
- **A denial is a JSON-RPC success carrying `isError: true`**, not a JSON-RPC error. An MCP
  tool error reaches the model as a failed `tool_result`, so the model reads the reason and
  tells the user honestly what it may not do — the same behaviour the local path produces. A
  protocol-level error would surface as a broken tool and the turn would end apologising for
  a technical fault that did not happen. The payload is JSON with `blocked: true` so a client
  can tell a refusal from a malfunction structurally rather than by matching wording.
- **`tools/list` is not filtered.** A RESPONSE interceptor could hide tools the caller may
  not use, which would save a few tokens and prevent a doomed call. We deliberately do not:
  hiding the tool removes the denial, and the denial — `agent attempted get_weather →
  interceptor caught it → call was blocked` — is a functional requirement of this project,
  not a diagnostic. A model that silently never knows a capability exists cannot explain to
  the user why it did not use it.

`guard.ts` stays, unchanged, as the enforcement point for local tools and for offline tests.
The `GatewayToolProvider` does **not** consult it: if it did, our code would refuse first and
the interceptor we deployed would never run, so the deployment would prove nothing.

## Decision 4 — tool schemas are generated from the tools

`infra/lib/tool-schema.ts` converts each tool's `inputSchema` into the target's
`ToolDefinition` at synth time. A schema hand-copied into the template would be a second
definition of the tool's contract, and the day a property is renamed the model would be told
the old name while the Lambda received `undefined` — a failure that looks like a broken tool
rather than like drift.

AgentCore's `SchemaDefinition` is a *subset* of JSON Schema (`type`, `description`,
`properties`, `required`, `items`). The converter therefore **throws** on anything else
rather than dropping it: a silently ignored `enum` would let the model send a value the tool
never expected, which is the class of bug the schema exists to prevent.

## Decision 5 — capabilities fail loudly, enhancements degrade quietly

If the Gateway cannot be reached, the turn fails. The composite could skip a provider that
did not answer and carry on with the rest, and that is the wrong trade: the model would then
be told only `search_flights` exists and would explain, confidently and wrongly, that it
cannot check the weather. A user cannot tell that apart from a real limitation, whereas a
failed turn is plainly a failure.

This is the mirror of ADR-0003, where a Memory failure degrades the turn instead of ending
it. The distinction is not inconsistency but a rule: **memory is an enhancement, tools are
the product.**

Likewise, a Runtime configured with `GATEWAY_URL` but reached without an access token
refuses the turn instead of falling back to in-process execution.

## What we gave up

- **`Session → trace → span` no longer holds automatically across the Gateway.** AgentCore
  does not forward its session id to a target or an interceptor. The interceptor gets it back
  because our MCP client sends `x-travel-session-id` and `passRequestHeaders` is on, so the
  denial span — the one that matters — still joins its conversation. The **target Lambda**
  cannot: it receives only the tool arguments and a set of gateway ids, so a tool execution
  span correlates through the interceptor's span for the same MCP message id, not directly.
  The REQUEST interceptor could inject a session id into `params.arguments`, since it may
  rewrite the request; we did not, because a tool receiving arguments outside its own schema
  is a surprise waiting for whoever reads it next.
- **One more network hop per tool call**, plus a `tools/list` on the first turn in a
  container. The list is cached at container level — correct precisely because we do not
  filter it per caller.
- **Two more Lambdas to reason about**, both on the critical path of every tool call.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| Keep tools in-process, skip the Gateway | Authorization stays inside the component being authorized, and the platform capability this project exists to learn goes untouched |
| IAM inbound auth on the Gateway | Authenticates the agent, not the user; per-user scopes would have nowhere to be enforced |
| `allowedScopes` on the authorizer instead of an interceptor | One scope for the whole gateway; cannot express "this tool needs `photos:search`" |
| RESPONSE interceptor filtering `tools/list` | Removes the denial trace that is a functional requirement here |
| `@modelcontextprotocol/sdk` for the client | Three methods needed, and the transport's own session and reconnect handling would sit between us and the behaviour we are trying to observe. Revisit if the agent ever needs server-initiated messages |
| Move `search_flights` too | Loses AgentCore Identity outbound auth, the only place the architecture exercises it (ADR-0002) |

## Verification

`./scripts/smoke-gateway.sh`. It speaks MCP to the Gateway **directly**, with no agent in
the path, before testing end to end — because when a tool call is refused, the only way to
know whether the Gateway or our own code refused it is to remove our own code from the
request. The token it asks for deliberately omits `tools/photos:search`, so `get_weather`
must succeed and `get_photos` must come back `blocked: true` in the same run.
