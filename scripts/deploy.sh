#!/usr/bin/env bash
# One stable command for a deploy, so a permission rule can match it.
#
# Permission rules match on the *prefix of the whole command string*, which makes
# `cd infra && AWS_PROFILE=x npx cdk deploy ...` a poor thing to allow: the env-var prefix and
# the `cd` both come before the part anyone would want to name in a rule. This wrapper is the
# whole command, so `Bash(./scripts/deploy.sh)` is an exact, auditable thing to permit.
#
# It also pins the profile with `--profile` instead of an environment variable, because
# CLAUDE.md's first rule is that the default profile points at a corporate account.
#
# Takes no arguments, deliberately: the permission rule that allows it is an exact string
# match, so `./scripts/deploy.sh --anything` would not be covered by it. And the diff is not
# optional in this project anyway.
#
#   ./scripts/deploy.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE/infra"

echo "==> cdk diff (read it before the deploy — this is a project rule)"
npx cdk diff --profile "$PROFILE" || true
echo

echo "==> cdk deploy"
npx cdk deploy --profile "$PROFILE" --require-approval never

echo
echo "==> deployed. Two things before you believe it:"
echo "    1. a 200 can come from the PREVIOUS container until the session goes idle —"
echo "       check the 'build' field in an answer against the image tag above"
echo "    2. READY and 200 do not mean it works; verify by observing output"
