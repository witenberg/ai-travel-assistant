# `web/` — the login harness

One static page that logs a real person into Cognito and asks the agent a question. It exists
to demonstrate the `login (OIDC)` edge of the architecture and nothing else; the decision and
its rejected alternatives are in [`../docs/adr/0007-user-login-through-the-hosted-ui.md`](../docs/adr/0007-user-login-through-the-hosted-ui.md).

## Run it

```bash
export AWS_PROFILE=ai-playground
./scripts/web-config.sh                          # writes web/config.js from the stack outputs
python3 -m http.server 5173 --directory web
open http://localhost:5173/
```

**The port is not negotiable.** `http://localhost:5173/` is the callback URL registered on the
Cognito app client, trailing slash included, and Cognito compares those as strings.

You need a user. The stack creates none — a password in a CloudFormation template is a password
in the CDK staging bucket — so make one after deploy:

```bash
POOL=$(aws cloudformation describe-stacks --stack-name TravelAssistantStack \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
aws cognito-idp admin-create-user --user-pool-id "$POOL" \
  --username traveler@example.test --message-action SUPPRESS
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" \
  --username traveler@example.test --password '<a password>' --permanent
```

`--permanent` is not optional: without it the user is in `FORCE_CHANGE_PASSWORD` and the hosted
UI demands a new password before it will issue anything.

## What each file is

| File | |
|---|---|
| `index.html` | the markup, and the reasoning for the harness being a harness |
| `style.css`   | ~80 lines, one accent colour, no framework |
| `app.js`      | PKCE, the token exchange, the API call, and the rendering — the whole flow |
| `config.js`   | **generated and git-ignored** — hosted UI, client id, API URL, API key |

No build step, no dependencies, no `package.json`. The project's rule is that application logic
stays thin so the infrastructure stays the interesting part; a bundler here would have been
more lines than the login flow it was meant to display.

## The API key is public here, on purpose

`config.js` carries the API Gateway key, and a browser cannot hold a secret — whoever has the
page has the key. It is there because it is what attaches a request to the usage plan, and the
usage plan's **100 requests/day** is the brake that protects the account's 10 USD cap. It is not
authentication: the Cognito JWT is. A deployment with real users would keep the key on a server
that calls the API on the user's behalf, which is the same argument
[ADR-0001](../docs/adr/0001-response-path-through-bff.md) makes for the BFF existing at all.

## What the page shows, and why each field is there

- **`sub`** — a UUID, and the point of the whole exercise. With the machine client this was an
  app-client id shared by every caller; now it identifies a person, so `deriveSessionId` and
  `deriveActorId` finally separate one user's conversation and memories from another's.
- **granted scopes** — what the token actually asks for, which is what the Gateway interceptor
  will judge. Predicting a refusal from this list is the demonstration.
- **tool badges** — one per tool call, red when the interceptor blocked it. Unchecking
  *photos* before logging in and asking for photos *and* weather produces a forecast, a red
  `get_photos`, and an answer that admits the gap. Same code, same user, different token.
- **`build`** — the container image tag that answered. After a deploy a `200` can still come
  from the previous warm container, and this field is the only way to tell.

## What it deliberately does not do

- **No refresh tokens.** On a 401 it clears the token and shows the login button. A token lasts
  an hour; a refresh loop belongs to a real app.
- **No token verification.** Code in the page that checks the page's own token proves nothing.
  API Gateway's Cognito authorizer is the verification that counts.
- **No hosting.** No S3, no CloudFront. The board draws no frontend, so hosting is out of
  scope, and an always-on distribution contradicts the budget stance.
- **No tests.** The page is a test harness; a suite asserting that a harness renders would
  inflate the count without adding a claim anyone relies on.
