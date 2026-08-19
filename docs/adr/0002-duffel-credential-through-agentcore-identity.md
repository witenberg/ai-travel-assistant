# ADR-0002: The Duffel token is served by AgentCore Identity, not read from Secrets Manager

- **Status:** accepted
- **Date:** 2026-08-19
- **Context:** `search_flights` is the only tool needing outbound authentication. The
  open question was whether its token should live in Secrets Manager and be read by the
  tool, or be served by AgentCore Identity as the diagram intends.

## What the platform actually offers

Verified against the CloudFormation registry and the AgentCore CLI, not from memory:

- `AWS::BedrockAgentCore::ApiKeyCredentialProvider` exists, and CDK ships
  `CfnApiKeyCredentialProvider`. The provider takes either a raw `ApiKey` or a reference
  to a Secrets Manager secret (`ApiKeySecretArn` / `ApiKeySecretJsonKey`).
- `AWS::BedrockAgentCore::GatewayTarget` accepts `CredentialProviderConfigurations` with
  `CredentialProviderType: API_KEY` and an `ApiKeyCredentialProvider` carrying
  `CredentialLocation` (`HEADER` | `QUERY_PARAMETER`), `CredentialParameterName` and
  `CredentialPrefix`.
- The data plane exposes `get-resource-api-key` and `get-resource-oauth2-token`, reached
  with a workload access token from `get-workload-access-token`.

So there are **two** ways to use Identity for outbound credentials, not one.

## Decision

Store the token in Secrets Manager, register it as an **AgentCore Identity API key
credential provider**, and have the flights tool fetch it at runtime through
`get-resource-api-key`.

Secrets Manager and Identity are not alternatives here — they layer. Secrets Manager is
where the secret rests; Identity is the token vault that hands it to a workload.

## Rejected alternative: Gateway OpenAPI target with injected credentials

The Gateway can call Duffel directly from an OpenAPI schema and inject
`Authorization: Bearer <token>` itself, with no code of ours in the path. It is less
code and demonstrates the managed path well.

We rejected it because **the transformations would be lost**. `search_flights` resolves
two city names to IATA codes before it can search at all, converts `PT4H35M` into
`4h 35m`, and flattens Duffel's nested offers into a flat shape. A raw OpenAPI
passthrough hands the model unprocessed JSON and asks it to do that work — which
directly contradicts the principle in CLAUDE.md that deterministic computation belongs
in code, not in the model. We paid for that principle with two real agent failures.

The retrieval route also transfers better: `get-resource-oauth2-token` has the same
shape, so what we learn here applies to an OAuth 2 provider later — and OAuth 2 is the
half of the diagram we lost when Amadeus shut down its self-service portal.

## Consequences

- The container never receives the token through an environment variable. Locally it
  still reads `DUFFEL_ACCESS_TOKEN`, so the credential source becomes an injectable
  seam in the client rather than a hard-coded lookup.
- One extra call on a cold path. The retrieved key is cached in module scope, the same
  way the Amadeus OAuth token was.
- The Gateway-injected route stays available as a later demonstration; we may add a
  second, trivial target purely to show it.

## Addendum (2026-08-19) — what the deployed chain taught us

The decision stands, and two of its premises turned out to be wrong. Recorded here rather
than quietly fixed, because both were reasonable readings of the documentation.

**A workload access token arrives only if the invocation names a user.** The docs say
Runtime "passes the workload access token to agent code as part of the invocation payload
header", and it does — but the delivery runs through `GetWorkloadAccessTokenForJWT`, which
needs an end user, and a SigV4 `InvokeAgentRuntime` names none. Measured from inside the
container, a plain invocation carries no token header of any kind. Supplying
`runtimeUserId` switches AgentCore to the `GetWorkloadAccessTokenForUserId` path, and the
token appears. The value is the actor id the BFF already derives from the verified JWT,
which is what AWS's own guidance requires: the platform treats the user id as an
unverified opaque string, so its integrity has to come from the component that sets it.
Cost: one extra IAM action on the BFF role, `InvokeAgentRuntimeForUser`.

**`GetResourceApiKey` reads an `EXTERNAL` secret as the calling workload, not as itself.**
Its AccessDenied named our own runtime execution role. So the runtime role needs
`secretsmanager:GetSecretValue` on the secret, and the resource policy the feature's launch
blog prescribes — allowing `identity.bedrock-agentcore.amazonaws.com` — is both beside the
point and impossible to write, since Secrets Manager rejects that principal as unsupported.

That qualifies one of the consequences above. The container *does* end up holding a Secrets
Manager permission, so the Identity layer is not what keeps the secret away from the
container's IAM. What it still buys:

- the secret's ARN never enters the container, and the container never calls Secrets Manager
  itself — it names a credential provider, and the vault decides;
- one audited API per credential provider, so access is attributable to a provider rather
  than to a secret read;
- the same code path works for an OAuth 2 provider, where there is no secret to read at all —
  which is the transfer this ADR was chosen for.

If "the container holds no Secrets Manager permission" were the requirement, the answer is a
service-managed secret: drop `apiKeySecretSource: EXTERNAL` and let AgentCore own the secret,
at the price of its lifecycle leaving our stack. We keep BYOS because the secret's lifecycle
being ours is worth more here than one IAM statement.
