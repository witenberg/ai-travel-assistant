# Resolved: explicit IAM deny on the MB-EmployeeAccess role

**Date:** 2026-08-19 · **Status:** ✅ **RESOLVED** the same day — Paweł executed variant B.
Kept as the record of the diagnosis and the reasoning behind the chosen fix, because the
same constraint returns whenever a new principal needs to deploy (for example a CI role).

## Symptom

`cdk bootstrap aws://687222805898/us-east-1` ended in `ROLLBACK_FAILED`. All four IAM
roles failed with:

```
User: .../MB-EmployeeAccess/jakub.witenberg is not authorized to perform:
iam:GetRole ... with an explicit deny in an identity-based policy
```

The deny was total — it blocked even `iam:GetRole` on our own role and `iam:ListRoles`.
An explicit Deny, not a missing permission, so no additional Allow could override it.

## Measured permission boundary

Tested empirically without creating resources — calls with invalid parameters, where a
validation error proves the action is permitted:

| Action | Result |
|---|---|
| `iam:*` including **`PassRole`** | ❌ **explicit deny** |
| `s3:CreateBucket`, `dynamodb:CreateTable`, `logs:CreateLogGroup` | ✅ allowed |
| `cloudformation:CreateStack`, `apigateway:*`, `ecr:CreateRepository` | ✅ allowed |
| `cognito-idp:CreateUserPool`, `bedrock-agentcore-control:CreateAgentRuntime` | ✅ allowed |
| `bedrock-runtime:Converse` on Haiku 4.5 | ✅ works |
| `sts:AssumeRole` | ⚠️ implicit deny (no Allow), **not** explicit |

**Only IAM was closed; everything else was open.** A standard corporate guardrail against
privilege escalation: a developer may build but may not grant themselves permissions.

**Why the explicit/implicit distinction decided the fix:** `iam:PassRole` carried an
explicit Deny that nothing can override. `sts:AssumeRole` carried only an implicit deny —
nobody had granted it — and that is grantable.

## The fix (variant B)

Paweł ran, once, with his own admin permissions:

```bash
cdk bootstrap aws://687222805898/us-east-1
```

and granted us `sts:AssumeRole` on the four bootstrap roles:

```
arn:aws:iam::687222805898:role/cdk-hnb659fds-deploy-role-687222805898-us-east-1
arn:aws:iam::687222805898:role/cdk-hnb659fds-file-publishing-role-687222805898-us-east-1
arn:aws:iam::687222805898:role/cdk-hnb659fds-image-publishing-role-687222805898-us-east-1
arn:aws:iam::687222805898:role/cdk-hnb659fds-lookup-role-687222805898-us-east-1
```

**Why this works despite the explicit deny on `iam:PassRole`:** during `cdk deploy`,
`PassRole` onto the `cfn-exec` role is performed by the **`deploy` role**, not by our
identity. We only assume the `deploy` role. Our IAM deny is never evaluated on that path.

This is the pattern real organisations use — the developer has no IAM, deployment goes
through a dedicated role — and it preserves the guardrail rather than removing it.

## Verification

A smoke-test stack containing a single IAM role went `cdk deploy` → `CREATE_COMPLETE` →
`cdk destroy` → `DELETE_COMPLETE`, while our identity still could not read that role
through the IAM API. That combination is the intended outcome, not a problem.

## Rejected alternative

Granting our role IAM permissions directly. Faster, but it removes a guardrail that was
almost certainly deliberate — the permission set denies IAM and nothing else, which is
the signature of an anti-privilege-escalation policy rather than an oversight.
