# AI Travel Assistant

An agent that helps plan a trip. Architecture and decisions live in [`CLAUDE.md`](CLAUDE.md).

## Why this project exists

This is a **learning project, and the travel assistant is only a pretext.** The subject
being learned is **Amazon Bedrock AgentCore** — how to design and run AI agent
infrastructure on AWS — with the rest of AWS picked up along the way.

That ordering decides trade-offs. Where there is a choice between the simpler path and
the one that exercises more AgentCore surface, we take the AgentCore one, as long as it
fits the budget. Concretely, we want hands-on time with:

- **Runtime** — the agent in a container, its service contract and session lifecycle
- **Gateway** — tools exposed as managed MCP, with inbound interceptors enforcing scopes
- **Identity** — inbound auth from Cognito, and outbound credentials from the token vault
- **Memory** — short- and long-term conversation state
- **Observability** — `Session → trace → span` reaching CloudWatch

Everything around it — Cognito, API Gateway, Lambda, DynamoDB, CDK, CI/CD — is
supporting cast. It matters, but it is not the point.

The application logic is deliberately small so the infrastructure stays the interesting
part. A tool that would take a week of product work and teach nothing about AgentCore is
the wrong tool for this project.

## Running locally

Requires an active AWS session (for Bedrock):

```bash
aws sso login --sso-session perpaul
export AWS_PROFILE=ai-playground

npm install
cp .env.example .env   # then add a Duffel test token (optional — only search_flights needs it)
npm run dev -- "I'm going to Lisbon this weekend. What's worth seeing and what's the weather?"
```

Permission-block demo — the agent asks for photos without the `photos:search` scope:

```bash
npm run dev -- --scopes=places:read,weather:read "Show me photos of Lisbon"
```

## Tests

```bash
npm test        # 23 tests; some hit open-meteo, Wikipedia and Commons
npm run typecheck
```

## Agent tools

| Tool | Source | Scope |
|---|---|---|
| `get_place_details` | Wikipedia REST | `places:read` |
| `get_weather` | open-meteo (geocoding + 7-day forecast) | `weather:read` |
| `get_photos` | Wikimedia Commons (geosearch by coordinates) | `photos:search` |
| `search_flights` | Duffel (bearer token, test mode) | `flights:read` |

## Logs

Every agent step is one JSON line on stdout, structured as `Session → trace → span`:

```json
{"type":"span","sessionId":"...","traceId":"...","name":"tool.authorize",
 "status":"blocked","attributes":{"tool":"get_photos","requiredScope":"photos:search"}}
```

The same format goes to CloudWatch Logs after deployment, with no code change. Spans are
written to **stderr** — the AgentCore Runtime drops stdout.

Query them in the deployed runtime with the JSON filter syntax:

```bash
aws logs filter-log-events \
  --log-group-name /aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT \
  --filter-pattern '{ $.type = "span" }'
```

## Layout

```
src/
  agent.ts                agent loop (Bedrock Converse API + tool use)
  guard.ts                scopes — local equivalent of Gateway interceptors
  prompt.ts               system prompt (injects the current date)
  observability/trace.ts  Session -> trace -> span
  tools/
    duffel/client.ts      bearer-token auth for the flights API
    geocode.ts            shared geocoding (open-meteo) used by weather and photos
    index.ts              registry + mapping to toolConfig
  local.ts                CLI
```
