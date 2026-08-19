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
