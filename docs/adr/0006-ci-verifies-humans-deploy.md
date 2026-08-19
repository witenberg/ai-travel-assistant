# ADR-0006 — CI verifies; deploying stays a human action

Date: 2026-08-19
Status: accepted

## Context

The mentoring goals name CI/CD explicitly, and the project had neither. Step 0 gave it a
git repository; this decides what automation sits on top, and how far it reaches into AWS.

Three constraints shape the answer, and none of them is about convenience:

- **The budget is 10 USD, total.** Every deploy publishes a container image and can start
  billable resources. A pipeline that deploys on merge turns a careless merge into spend,
  and the account has no cost telemetry to notice — `budgets:ViewBudget` and
  `ce:GetCostAndUsage` are both explicitly denied to our role.
- **Our identity cannot create IAM roles.** `MB-EmployeeAccess` carries an explicit deny on
  all of IAM, and deploys work only because CloudFormation's `cfn-exec` role creates
  application roles on our behalf (`docs/blocker-iam.md`). A CI role that could deploy needs
  `sts:AssumeRole` on the four CDK bootstrap roles — a grant only Paweł can make.
- **The project's own rule is that a green check is not evidence.** "`READY` and `200` do not
  mean it works." Every capability here was verified by observing output, usually through a
  smoke script that costs a model call. That is not something a pull-request gate can do
  cheaply or safely.

## Decision

**CI runs on every pull request and every push to `main`, and stops at the edge of the AWS
account.** One workflow, `.github/workflows/ci.yml`, with no credentials and no AWS calls:

| Step | What it protects against |
|---|---|
| `.env` must not be tracked | publishing a live Duffel token |
| `npm run typecheck` (root and `infra`) | a type error reaching a deploy |
| `npm run test:offline` | a logic or wiring regression |
| `npx cdk synth` | a template that no longer synthesises |
| `npm run verify:bundle` | a bundle that synthesises and then dies on load |

**Deployment stays manual**, run by a human with an explicit profile, after `cdk diff`.

## Consequences

- A pull request cannot tell you the system works, only that it still builds and passes what
  can be checked offline. The smoke scripts remain the evidence, and they stay manual.
- `cdk synth` in CI needs no Docker, because CDK builds container image assets at publish
  time rather than at synth time. Verified by running the whole workflow locally with
  `AWS_CONFIG_FILE=/dev/null`: it passes with no credentials available at all.
- The network tests are excluded from the gate. They test real behaviour against open-meteo,
  Wikipedia and Wikimedia Commons and stay in `npm test`; as a merge gate they would fail on
  someone else's outage, and a gate that cries wolf gets ignored — which is worse than not
  having it.

## Rejected: deploy from CI on merge to `main`

The conventional shape, and the one the mentoring goals could be read as asking for. Rejected
for now on all three constraints above: it needs an IAM grant we cannot make ourselves, it
converts a merge into spend on an account with a hard cap and no telemetry, and it would
deploy without the manual verification step that has caught something in every one of the six
steps so far.

**Exit path, if it is wanted later:** GitHub OIDC — an `AWS::IAM::OIDCProvider` for
`token.actions.githubusercontent.com`, one role trusted by that provider with the repository
and branch pinned in the trust policy's `sub` condition, and `sts:AssumeRole` on the CDK
`deploy`, `file-publishing`, `image-publishing` and `lookup` roles. No long-lived keys in
GitHub. Two properties to keep if we do: pin `sub` to a single branch (a wildcard would let a
pull request from a fork deploy), and keep the smoke scripts in the pipeline *after* the
deploy, so a green pipeline means verified rather than applied.

## Rejected: a self-hosted runner or long-lived AWS keys in secrets

Access keys in GitHub secrets are a credential we would have to rotate and could not audit
per-run; OIDC exists to avoid exactly that. A self-hosted runner adds a machine to maintain
for a project whose whole point is that nothing is always-on.
