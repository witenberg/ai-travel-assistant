# Plan — user login and a minimal frontend

**Status: not started.** Written 2026-08-19 to be executed by a session with no prior
context, unattended. Read `CLAUDE.md` first, then this file top to bottom, then start at
Phase 1.

## Your authority — read this before anything else

Jakub is out and has **granted this work in advance**. He asked for the login and a minimal
frontend, approved the plan, and added the permission rules that let you deploy. So:

**Do not ask him anything. Do not wait for confirmation. Do not stop at a decision point.**
Every decision that needed making is made below, with its reasoning and its rejected
alternatives — if you disagree with one, record the disagreement in the Progress log and
implement the plan as written. He is not there to answer, and a half-finished feature with a
question attached is worth less than a finished one with a note.

You may, without checking in:

- edit any file in this repository, including the CDK stack, and create `web/`
- run `./scripts/deploy.sh` and `./scripts/destroy.sh` — as many times as the work needs
- create the Cognito test user and set its password
- drive Chrome to log in as that user and click through the page
- commit and push to `origin main`, and let CI run
- spend a few US cents on model calls (each browser turn is roughly one)

You must **not**:

- change or delete the machine (client-credentials) Cognito client, or anything the existing
  smoke scripts depend on — the browser is an addition, not a replacement
- remove `apiKeyRequired` from the API, or widen the API beyond `http://localhost:5173`
- work around a permission denial — see below
- leave the stack running. `./scripts/destroy.sh` is the last thing you do, pass or fail.

**Verified before Jakub left:** `.claude/settings.json` carries 23 allow rules covering the
wrappers, the AWS calls this plan makes, `python3 -m http.server`, and the Chrome tools. An
exact-match script rule was tested and runs unprompted. If something is refused anyway, that is
a decision and not an obstacle to route around: write the exact refused command into the
Progress log, finish everything that does not depend on it, and stop there.

---

## What this delivers

The last architectural gap on the FigJam board: the `login (OIDC)` edge from Customer to
Cognito. Today the only Cognito client is machine-to-machine, so `sub` is an app-client id and
**every caller shares one session and one long-term memory**. The code for per-user identity
exists and is tested (`deriveSessionId`, `deriveActorId`, `runtimeUserId`); what is missing is
a human in front of Cognito.

Plus the smallest frontend that makes it visible: one static HTML page, no build step, no
framework, served from `localhost`.

**Definition of done:** a real user logs in through the Cognito hosted UI, asks the agent a
question in a browser, and gets an answer whose `sessionId` is derived from *that user's* `sub`
— and unchecking the "photos" scope before logging in makes the agent refuse photos while still
answering about the weather. Then `cdk destroy`.

---

## Prerequisites — check these before Phase 1

```bash
export AWS_PROFILE=ai-playground
aws sts get-caller-identity          # must be 687222805898 (mb-demos)
# If this fails: aws sso login --sso-session perpaul
docker info >/dev/null && echo docker ok      # needed for the Runtime image
cd /Users/jakub.wi/Desktop/ai_app && npm test # 174 must pass before you change anything
```

**Deploy and destroy through the wrappers, never by hand** — they are what the permission rules
name, and they take no arguments:

```bash
./scripts/deploy.sh        # cdk diff, then cdk deploy --profile ai-playground
./scripts/destroy.sh       # cdk destroy, then proves the stack is gone
```

They exist because permission rules match on the prefix of the *whole* command string, so
`cd infra && AWS_PROFILE=x npx cdk deploy ...` is a bad thing to try to allow — the `cd` and the
env-var assignment come first. One script is one exact string a rule can name. They also pin
`--profile ai-playground`, because the default profile points at a corporate account.

A bare `npx cdk deploy` with a `cd` or an `AWS_PROFILE=` in front of it is **not** covered by the
rules, because they match the prefix of the whole command string. Use the wrappers.

---

## Decisions already made — do not re-litigate

1. **A second Cognito app client, not a change to the existing one.** The machine client keeps
   client-credentials for the smoke scripts and CI; the new one is a *public* client (no
   secret) with the authorization-code flow and PKCE. Two clients because they authenticate
   two different kinds of caller, and because breaking the smoke scripts to add a browser
   would trade a working test for a new feature.
2. **PKCE, and no client secret in the browser.** A secret in a page is not a secret. Cognito
   supports public clients with PKCE precisely for this.
3. **One static page, hand-written, no framework and no bundler.** The project's rule is that
   application logic stays thin so the infrastructure stays the interesting part. React plus a
   build step would add more lines than the entire login flow. Vanilla `fetch` +
   `crypto.subtle` is about 150 lines.
4. **Served from `http://localhost:5173/` with `python3 -m http.server`.** No S3, no
   CloudFront: the board has no frontend at all, so hosting is out of scope, and an always-on
   distribution contradicts the budget stance. Cognito allows `http://localhost` callbacks
   (and only localhost) without TLS.
5. **The API key goes into a git-ignored generated file**, exactly like the `.http` collections.
   In a browser the key is not a secret and cannot be one; it stays because it is the daily
   quota that caps spend, and the page documents that in a real deployment it would live behind
   a server. Do not remove `apiKeyRequired`.
6. **The scopes the user asks for are chosen in the page, with checkboxes.** Cognito scopes are
   per client and per request, not per user, so making two *users* differ would need a
   pre-token-generation Lambda trigger — out of scope. Checkboxes give the same demonstration
   honestly: the token you get is the token the Gateway interceptor judges.
7. **No refresh-token handling.** On a 401 the page sends you back to login. A token lasts an
   hour; a refresh loop is a feature of a real app, not of this one.
8. **The test user is created by CLI after deploy, not in CDK.** A password in a CloudFormation
   template is a password in the CDK staging bucket. Generate one, write it to a git-ignored
   file, print it once.
9. **No new ADR for the frontend, one new ADR for the login model** (`docs/adr/0007-...`): the
   frontend is a test harness, but *how a human's identity reaches the agent* is architecture,
   and ADR-0001's BFF argument depends on it.
10. **The Runtime keeps SigV4 inbound auth.** It is the BFF that authenticates the user; the
    Runtime is invoked by the BFF with `runtimeUserId` (see `CLAUDE.md` → AgentCore Identity).
    Moving the Runtime to inbound JWT is a separate, larger decision and is not part of this.

---

## Phase 1 — CDK: the web client, CORS, and the Gateway's allowed clients

All in `infra/lib/travel-assistant-stack.ts`.

1. **Web client** next to `machineClient`:
   - `generateSecret: false`
   - `oAuth.flows: { authorizationCodeGrant: true }`
   - `oAuth.scopes`: the four `TOOL_SCOPES` via `cognito.OAuthScope.resourceServer(...)` — the
     same pattern the machine client already uses. Add `cognito.OAuthScope.OPENID` only if you
     need an id token; you do not.
   - `oAuth.callbackUrls: ['http://localhost:5173/']`,
     `oAuth.logoutUrls: ['http://localhost:5173/']`
   - `authFlows`: leave everything false. The hosted UI does not need `USER_PASSWORD_AUTH`, and
     tokens minted through that flow **carry no custom scopes** (a documented trap in
     `CLAUDE.md`), so allowing it would create a second path that silently fails the scope check.
   - `accessTokenValidity: Duration.hours(1)`, `refreshTokenValidity: Duration.days(1)`.
2. **The Gateway must accept it.** `authorizerConfiguration.customJWTAuthorizer.allowedClients`
   currently lists only the machine client. Add the web client id. **Miss this and every tool
   call from a browser session fails at the Gateway**, which will look like a broken agent.
3. **CORS on the API.** Add to the `chat` resource:
   ```ts
   defaultCorsPreflightOptions: {
     allowOrigins: ['http://localhost:5173'],
     allowHeaders: ['authorization', 'content-type', 'x-api-key'],
     allowMethods: ['POST', 'OPTIONS'],
   }
   ```
   The `OPTIONS` method must not require the authorizer or the API key — CDK's mock integration
   does that by default, but verify it in `cdk synth` output, because a preflight that demands a
   token fails before the browser ever sends the real request.
   The BFF's own 4xx/5xx responses also need `access-control-allow-origin`, or the browser will
   report a CORS error instead of your 403. Add the header in `respond()` in
   `src/bff/handler.ts` (`'access-control-allow-origin': '*'` is fine for a localhost harness;
   say so in a comment).
4. **Outputs**: add `WebClientId` and `HostedUiDomain` (`userPoolDomain.baseUrl()`).

Verify: `npm run typecheck` in `infra/`, then `npx cdk synth --quiet`, then `cdk diff` — expect
a new `AWS::Cognito::UserPoolClient`, the `OPTIONS` method, and a Gateway update **in place**
(`[~]`, not a replacement — a replaced Gateway would change the MCP URL the Runtime holds).

---

## Phase 2 — the page

Create `web/`:

- `web/index.html` — one page: a "Log in" button, four scope checkboxes (checked by default),
  a textarea, a Send button, and an answer area. Plain CSS, dark-on-light, no framework.
- `web/app.js` — the whole flow:
  1. **PKCE**: `verifier` = 43+ random chars from `crypto.getRandomValues`; `challenge` =
     base64url(SHA-256(verifier)) via `crypto.subtle.digest`. **base64url with no padding** —
     `btoa(...).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')`. A padded challenge is
     rejected with an opaque `invalid_grant`.
  2. Store the verifier in `sessionStorage`, redirect to
     `{hostedUi}/oauth2/authorize?response_type=code&client_id=...&redirect_uri=...&scope={checked}&code_challenge_method=S256&code_challenge=...`
  3. On return, exchange `?code=` at `{hostedUi}/oauth2/token` with
     `grant_type=authorization_code`, the verifier, and no client secret. Then
     `history.replaceState` to drop the code from the URL.
  4. Decode the access token payload (no verification — the API does that) and show `sub`,
     `username` and the granted `scope` list. **Showing the scopes is half the demo.**
  5. Send: `POST {apiUrl}` with `authorization: Bearer`, `x-api-key`, `{ "prompt": ... }`.
     Render the answer, then a row of badges from `toolCalls` (red when `blocked`), and the
     `build` and truncated `sessionId`. On 401, clear the token and show the login button again.
- `web/config.js` — **generated, git-ignored**: `window.APP_CONFIG = { hostedUi, clientId, apiUrl, apiKey }`.
- `web/README.md` — how to run it, and the note that the API key is public here on purpose.

Extend `scripts/http-requests.sh` (or add `scripts/web-config.sh` — either, but do not
duplicate the stack-output reading) to write `web/config.js`. Add `web/config.js` to
`.gitignore`.

Serve it: `python3 -m http.server 5173 --directory web`. The port matters — it is in the
callback URL.

---

## Phase 3 — deploy

```bash
./scripts/deploy.sh          # diffs first, then deploys — read the diff
```

Then the test user:

```bash
export AWS_PROFILE=ai-playground
POOL=$(aws cloudformation describe-stacks --stack-name TravelAssistantStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
PASS="Traveler$(python3 -c 'import secrets;print(secrets.token_hex(6))')!aA1"
aws cognito-idp admin-create-user --user-pool-id "$POOL" \
  --username traveler@example.test --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" \
  --username traveler@example.test --password "$PASS" --permanent
printf 'traveler@example.test\n%s\n' "$PASS" > .test-user      # add to .gitignore
```

`--permanent` is not optional: without it the user lands in `FORCE_CHANGE_PASSWORD` and the
hosted UI demands a new password, which a scripted verification cannot get through.

---

## Phase 4 — verify, in a real browser

Use the Chrome tools (`mcp__claude-in-chrome__*`; load them with one `ToolSearch` call). This is
the only way to get a token with custom scopes: `USER_PASSWORD_AUTH` tokens carry
`aws.cognito.signin.user.admin` and nothing else, so a CLI-only check cannot prove this works.

1. Start the static server in the background, open `http://localhost:5173/`.
2. All four scopes checked → Log in → hosted UI → the credentials from `.test-user`.
3. Back on the page: assert the shown `sub` is a UUID (a *user*, not the app client id) and
   that four `tools/...` scopes are listed.
4. Ask "What is the weather in Lisbon this weekend?" → expect a forecast,
   `toolCalls: [get_weather]`, and a `build` matching the deployed image tag.
5. Log out, uncheck **photos**, log in again, ask "Show me photos of Lisbon and the weather
   there." → expect the forecast plus an honest refusal, and `get_photos` with `blocked: true`.
   **This is the acceptance test**: same code, same user, different token, different answer.
6. Take a screenshot of step 5 and save it to `docs/frontend.png`.

Then prove the identity actually changed:

```bash
# The session id in the response must equal sha256("travel-assistant:" + <sub from the token>)
python3 -c 'import hashlib,sys;print(hashlib.sha256(("travel-assistant:"+sys.argv[1]).encode()).hexdigest())' <sub>
```

and confirm it differs from the machine client's session id in the earlier smoke output. Also
read the Runtime log group for `memory.load_preferences` carrying the new `actorId` — a per-user
long-term memory is the thing this phase buys.

Finally re-run the regression suite: `./scripts/smoke-gateway.sh` (the machine path must still
work — the new client must not have broken the old one) and `npm test`.

---

## Phase 5 — documentation, tests, commits

- `docs/adr/0007-user-login-through-the-hosted-ui.md` — decision, and the rejected
  alternatives: putting a client secret in the page; `USER_PASSWORD_AUTH` (no custom scopes);
  moving the Runtime to inbound JWT (bigger, separate); per-user scopes via a
  pre-token-generation trigger (the honest way to differ *users*, deferred).
- `CLAUDE.md`: replace the "Known limitation" paragraph in Step 3's section (it says every
  caller shares one session — no longer true), add the web client and hosted UI to the
  deployed-resources table, and add any new trap you hit to the right section.
- `ROADMAP.md`: Step 10, done, with the verification table.
- `docs/reading-guide.md`: a step for `web/`, and the login flow in the "what is deliberately
  missing" section is no longer missing — fix it.
- Tests: `src/bff/handler.ts` gains a CORS header, so assert it in `test/bff.test.ts`. If you
  add any pure function to the page, it does not need a test — the page is a harness, and
  pretending otherwise inflates the suite.
- Commit in two or three commits with the project's message style: what changed, why, and what
  was rejected. Push to `origin main` and check CI goes green
  (`gh run list --limit 1`).

---

## Traps, collected from things that already cost deploys

- **A session keeps its warm container** for `idleRuntimeSessionTimeout` (now 120 s). After a
  deploy, check the `build` field in the answer before believing anything. A fresh session id
  forces a cold container.
- **`allowedClients` on the Gateway** — see Phase 1.2. This is the most likely single point of
  failure in this whole plan.
- **Cognito hosted UI needs an exact callback match**, including the trailing slash.
- **`admin-set-user-password --permanent`** — see Phase 3.
- **base64url without padding** for the PKCE challenge — see Phase 2.
- **CORS on error responses**, not just on the happy path, or a 403 reads as a CORS failure.
- **Do not add `authorizationScopes` to the API method.** The scope check belongs to the
  Gateway interceptor per tool; a gateway-wide scope gate would refuse the whole request and
  destroy the denial trace the observability requirement is built on.

---

## When you are done

```bash
./scripts/destroy.sh         # destroys, then fails loudly if the stack is still there
```

**Destroy even if Phase 4 failed.** Nothing stays up overnight; that is the rule the budget
depends on. The Duffel secret goes with the stack — the next deploy needs
`put-secret-value` again (ROADMAP Step 2), and the generated `.http` and `web/config.js` files
become stale, which is intended.

Then write a short summary into the Progress log below: what works, what does not, what the
next session should pick up, and the total spend if you can estimate it (each browser turn is
roughly a US cent).

---

## Progress log

*(append as you go — this is what a later session reads first)*
