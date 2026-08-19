# Poking the deployed system by hand

Two request collections, and the split matters:

| File | What it exercises | Costs |
|---|---|---|
| `api.http` | the whole chain: API Gateway → Cognito authorizer → BFF → Runtime → Gateway → tools | one model call per turn, ~1 US cent |
| `gateway.http` | AgentCore Gateway alone, over MCP, **with no agent in the path** | nothing — no model is called |

Start with `gateway.http`. When a tool call is refused, removing our own code from the request
is the only way to know who refused it — and it is free.

## Setup

Both files are templates holding placeholders. Generate the runnable copies:

```bash
export AWS_PROFILE=ai-playground
./scripts/http-requests.sh
```

That writes `requests/local.http` and `requests/local-gateway.http` — **git-ignored, mode 600**,
because they contain a Cognito client secret and an API key. Regenerate after any deploy that
changes stack outputs. Edit the templates, never the generated copies.

A client that can send `.http` files:

- **VS Code** — the *REST Client* extension (`humao.rest-client`). "Send Request" appears above
  each `###` block.
- **JetBrains IDEs** — built in; click the gutter arrow.

Both support the `@name` / `{{name.response.body.field}}` chaining these files rely on, which is
how the token from the first request feeds every later one.

## Reading the responses

- `toolCalls` — which tools ran, and `blocked: true` for anything the Gateway refused. A refusal
  is a normal outcome here, not an error.
- `sessionId` — derived server-side from your token's `sub`. You never send it; if you try, the
  attempt is recorded and ignored (there is a request in `api.http` that does exactly that).
- `build` — the container image tag that answered. After a deploy, a `200` can still come from
  the previous container until the session goes idle; this field is how you tell.

Then go and look at the spans. The log groups are listed in
[`docs/reading-guide.md`](../docs/reading-guide.md), step 6.

## If a request fails

| Symptom | Likely cause |
|---|---|
| `403` with `{"message":"Forbidden"}` (not our JSON shape) | the API key has not propagated yet — wait a minute after a deploy |
| `401` | no bearer token, or the token expired (they last an hour — resend the token request) |
| `403` with `token grants no tool scopes` | the token request asked for no `tools/...` scope |
| `502` | the Runtime failed; the detail is in its log group, not in the response |
| Everything 404s | the stack was destroyed — redeploy, then regenerate these files |
