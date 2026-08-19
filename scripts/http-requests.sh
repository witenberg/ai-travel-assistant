#!/usr/bin/env bash
# Fills the .http templates with the deployed stack's real values.
#
# The templates in requests/ are committed and hold placeholders; the copies this writes hold
# a Cognito client secret and an API key, so they are git-ignored. Regenerate after any deploy
# that changes the stack outputs — and after `cdk destroy` the generated files are stale, which
# is a feature: a 403 from a deleted API is clearer than a request that quietly used to work.
#
#   ./scripts/http-requests.sh
#
# Then open requests/local.http (or requests/local-gateway.http) in VS Code with the REST
# Client extension, or in any JetBrains IDE, and send the requests top to bottom.
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
STACK="${STACK_NAME:-TravelAssistantStack}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

echo "==> reading stack outputs"
TOKEN_ENDPOINT=$(out TokenEndpoint)
API_URL=$(out ApiUrl)
GATEWAY_URL=$(out GatewayUrl)
CLIENT_ID=$(out MachineClientId)
USER_POOL_ID=$(out UserPoolId)
API_KEY_ID=$(out ApiKeyId)

CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --profile "$PROFILE" \
  --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' --output text)

API_KEY=$(aws apigateway get-api-key --profile "$PROFILE" \
  --api-key "$API_KEY_ID" --include-value --query 'value' --output text)

# Pre-encoded: HTTP clients disagree about whether they encode `Basic user:pass` themselves,
# and a half-encoded header comes back as a puzzling 400 from the token endpoint.
BASIC_AUTH=$(printf '%s:%s' "$CLIENT_ID" "$CLIENT_SECRET" | base64 | tr -d '\n')

fill() {
  python3 - "$1" "$2" <<'PY'
import sys, os
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
for key in ('TOKEN_ENDPOINT', 'API_URL', 'GATEWAY_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'API_KEY', 'BASIC_AUTH'):
    text = text.replace(f'__{key}__', os.environ.get(key, ''))
# The generated file is not a template any more; say so at the top so nobody edits the wrong one.
text = text.replace(
    '# A TEMPLATE — generate the runnable copy with `./scripts/http-requests.sh`.',
    '# GENERATED from the template next to it. Edit the template, not this file.')
text = text.replace(
    '# This file is a TEMPLATE with placeholders. Generate the runnable copy:',
    '# GENERATED — real values, real credentials, git-ignored. Edit api.http, not this file.\n# Regenerate with:')
open(dst, 'w').write(text)
PY
}

export TOKEN_ENDPOINT API_URL GATEWAY_URL CLIENT_ID CLIENT_SECRET API_KEY BASIC_AUTH

fill "$HERE/requests/api.http" "$HERE/requests/local.http"
fill "$HERE/requests/gateway.http" "$HERE/requests/local-gateway.http"
chmod 600 "$HERE/requests/local.http" "$HERE/requests/local-gateway.http"

echo "==> wrote requests/local.http and requests/local-gateway.http (git-ignored, mode 600)"
echo
echo "Send them in this order:"
echo "  local.http          — the front door: token, then a real turn, then the refusals"
echo "  local-gateway.http  — the Gateway alone, no agent, no model cost"
