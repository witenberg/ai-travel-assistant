# ADR-0007 — a human logs in through the Cognito hosted UI

**Status:** accepted, deployed and verified — 2026-08-19
**Supersedes nothing. Qualifies:** ADR-0001 (why the BFF exists), ADR-0003 (what the actor is)

## Context

Every identity-derived control in this system was already built and tested: `deriveSessionId`
maps a token's `sub` to a conversation, `deriveActorId` maps the same `sub` to the owner of
long-term memory, and `runtimeUserId` binds the agent's outbound credentials to that actor. All
three were being fed by a **machine-to-machine** Cognito client.

That made them decorative. A client-credentials token has no user: its `sub` is the app client
id, identical for every caller. So there was exactly one session and exactly one long-term
memory in the entire system, and a preference learned from one person would be recalled for the
next. The code was right and the input was wrong.

The board (`P v JW`) draws the missing edge as `Customer --login (OIDC)--> Cognito`. It is the
last unbuilt piece of the architecture, and the only one that turns three tested functions into
a working isolation boundary.

A second problem is that the *scope* half of the design had never been exercised by a real
token either. `USER_PASSWORD_AUTH` cannot demonstrate it: tokens minted that way carry
`aws.cognito.signin.user.admin` and **no custom scopes at all**, so a CLI-only check can prove
the login works and still prove nothing about the Gateway interceptor.

## Decision

**A second Cognito app client — public, authorization-code flow with PKCE — plus one static
page served from `http://localhost:5173/` that logs a real user in and asks the agent a
question.**

Concretely:

1. **A new client, not a change to the existing one.** `MachineClient` keeps
   client-credentials; `WebClient` adds `code` with no secret. The two authenticate two
   different kinds of caller, and the smoke scripts and CI depend on the first one working.
2. **PKCE, no client secret.** A secret shipped inside a page is not a secret. The code
   verifier gives the token exchange the proof-of-possession the secret used to provide.
3. **The user picks the scopes, in the page, with checkboxes.** Cognito scopes are per client
   and per request, so the token is where a permission difference can honestly live.
4. **The Runtime keeps SigV4 inbound auth.** The BFF authenticates the user and passes
   `runtimeUserId`; moving the Runtime to inbound JWT is a larger, separate decision.
5. **The test user is created by CLI after deploy**, never in the template.
6. **CORS is allowed for exactly one origin**, and the BFF adds the header to *every* response.

## Why this shape

**A public client with PKCE is the only browser flow that yields custom scopes.** That is the
whole selection criterion. The alternatives fail on it or on secrecy, not on effort.

**The scope checkboxes are an honest demonstration, not a shortcut.** They do not make two
*users* differ — Cognito cannot, without a pre-token-generation Lambda trigger. What they
demonstrate is the real control: the Gateway interceptor judges *the token in front of it*, and
the page makes the token's contents visible before the request is sent. Predicting a refusal
from the scope list, then watching it happen, is the same evidence a per-user difference would
give, obtained without a component nobody has asked for yet.

**One static page, no framework.** The project's stated purpose is that the infrastructure is
the subject and application logic stays thin (`README.md`). The entire login flow is ~150 lines
of `fetch` and `crypto.subtle`; React plus a bundler would have added more lines than the thing
being displayed, and a build step to CI for a test harness.

**`http://localhost`, not S3 + CloudFront.** The board draws no frontend, so hosting is out of
scope; an always-on distribution contradicts the budget stance; and `http://localhost` is the
only non-TLS origin Cognito will accept as a callback, so a local port is also the *cheapest*
place this flow can legally live.

## Rejected alternatives

**A client secret in the page.** Cognito would accept it and the flow would work. It would also
publish the secret to everyone who opens developer tools, and teach that a "confidential client"
label is a property of the config rather than of where the code runs. PKCE exists for this case.

**`USER_PASSWORD_AUTH` (or `ADMIN_USER_PASSWORD_AUTH`) and no page at all.** Tempting, because
a shell script could then do the whole verification. Rejected because those tokens carry no
custom scopes: every tool call would be refused at the Gateway, and the failure would look like
a broken agent rather than a wrong login. Worse, it would *pass* API Gateway's authorizer, so
the two layers would disagree — the exact failure mode this project keeps paying for. The flow
is left disabled on both clients so nobody can reach for it later.

**Moving the Runtime to inbound JWT**, so the user's identity is proved to AgentCore
cryptographically rather than asserted by the BFF. This is a real weakness of the current
design and is written up as such in `CLAUDE.md`'s open questions. It is out of scope here
because it changes how every caller invokes the Runtime — including the smoke scripts and the
`InvokeAgentRuntimeForUser` path that ADR-0002's credential delivery depends on. Adding a login
must not require rewriting the machine path on the same day.

**Per-user scopes via a pre-token-generation Lambda trigger.** The honest way to make two
*users* carry different permissions, and the only way to demonstrate authorization that a user
cannot choose for themselves. Deferred, not dismissed: it is a new Lambda, a new trigger, and a
user-attribute-to-scope mapping to design, in exchange for a difference the checkboxes already
show. Worth doing the day the question becomes "what may *this person* do".

**Hosting the page on S3 with CloudFront.** Rejected on budget and on scope, as above. It would
also need TLS and a registered domain to be worth anything, since the only reason to host is to
let someone else use it — and there is no someone else.

**Removing `apiKeyRequired` because a browser cannot keep a key.** The key is not
authentication and never was: it is the only way API Gateway attaches a request to a usage plan,
and the usage plan's 100 requests/day is what caps the account's exposure. Losing the quota to
tidy up a non-secret would trade a real budget control for a cosmetic one.

## Consequences

**Good.** `sub` is now a per-person UUID, so `deriveSessionId` and `deriveActorId` finally
separate one user's conversation and preferences from another's — the isolation ADR-0003 was
designed around is real instead of theoretical. The scope path is exercised end to end by a
token a human obtained. And the architecture's last undrawn edge is built.

**Accepted costs.** The API key sits in a git-ignored generated file that a browser reads, which
is public by construction and documented as such in `web/README.md`. There is no refresh
handling, so a session ends after an hour. The page has no tests, deliberately: it is a harness,
and asserting that a harness renders would inflate the suite without adding a claim anyone
relies on. And the Gateway's `allowedClients` now has two entries that must both be maintained —
forgetting the second is the single most likely way to break this, because the symptom is every
tool call failing while the login looks perfect.

**A new constraint.** The callback URL `http://localhost:5173/` is now part of the deployed
configuration. The port is not a preference.
