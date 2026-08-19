# ADR-0001: The response returns synchronously through the Lambda BFF (no streaming in v1)

- **Status:** accepted
- **Date:** 2026-08-19
- **Context:** on the FigJam diagram the `response` arrow goes from the AgentCore Runtime
  straight to the Customer, while the request travelled through API Gateway and the
  Lambda BFF. We had to decide whether the BFF is a proxy (holding the connection) or
  merely a session initiator.

## Decision

In v1 the response returns **the same way the request came**: AgentCore Runtime →
Lambda BFF → API Gateway → client. Synchronously, without streaming.

## Rationale

**1. The BFF must stay in the path because the user → sessionId mapping is a security control.**
This is the argument that outweighs the rest. The `sessionId` decides which AgentCore
Memory the agent reads. If it came from the client, user A could pass user B's
`sessionId` and read someone else's conversation history and preferences — a textbook
horizontal privilege escalation. The mapping must happen server-side, from the `sub`
claim of a verified JWT. *(Security)*

**2. Since the BFF is in the request path, the response naturally returns through it.**
Streaming directly from the Runtime to the client would require the client to hold its
own `InvokeAgentRuntime` access — exactly what point 1 forbids.

**3. Streaming through API Gateway is impossible.** API Gateway buffers the response.
Streaming needs a Lambda Function URL with `RESPONSE_STREAM`, which bypasses API Gateway
and with it the JWT authorizer, throttling and usage plans. Those are on the diagram
deliberately and we do not want to lose them in v1.

**4. Throttling is our main budget defence.** With a 10 USD cap, a looping agent calling
Bedrock repeatedly can drain the account. The API Gateway usage plan is a hard brake we
do not trade away for better UX. *(Cost Optimization)*

## Rejected alternatives

| Option | Why not |
|---|---|
| Client → AgentCore Runtime directly (SigV4/JWT) | loses server-side sessionId mapping and throttling — violates Security and Cost |
| Lambda Function URL + `RESPONSE_STREAM` | gives streaming but removes API GW from the path. **Not rejected — this is the v2 route**, see below |
| Async: `202 Accepted` + sessionId, then polling / WebSocket | the best UX↔timeout tradeoff at scale, but needs a WebSocket API or AppSync plus connection state. Too many moving parts and too much cost for v1 |

## Consequences

**Accepted downsides:**
- The user watches a spinner for the whole turn — no progressive rendering.
- **A hard ~29 s ceiling** per turn (the default API Gateway REST integration timeout).
  Exceeding it means a `504` and a lost answer even though the agent finished computing it.

**Why that ceiling is acceptable in v1:**
Haiku 4.5 with three simple tools should finish a turn in seconds. All three tools are
plain HTTP calls to public APIs, so there is no slow component left in the path.

**What follows for observability:**
Turn latency stops being trivia and becomes an operational safety metric — a p99
approaching 29 s is the signal to move to v2. That gives the AgentCore Observability
work a concrete purpose rather than "logs are good to have".

## Exit path (v2)

When p99 starts approaching the limit, or we want streaming in the UI:
a Lambda Function URL with `RESPONSE_STREAM`, restoring the lost API Gateway controls
via CloudFront with Lambda@Edge/CloudFront Functions for JWT validation and WAF rate
limiting. That will be a new ADR; this one remains as the record of why we started differently.
