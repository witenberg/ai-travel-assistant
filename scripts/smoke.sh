#!/usr/bin/env bash
# End-to-end check of the entry layer: Cognito -> API Gateway -> Lambda BFF -> Runtime.
#
# Everything it needs comes from the stack outputs, so it works after any redeploy
# without editing ids by hand. It asks for one scope only (weather:read) — a request
# that is allowed to do something and forbidden to do everything else is a better
# smoke test than one with full access.
#
#   ./scripts/smoke.sh "What is the weather in Lisbon this weekend?"
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
STACK="${STACK_NAME:-TravelAssistantStack}"
SCOPES="${SCOPES:-tools/weather:read tools/places:read}"
PROMPT="${1:-What is the weather in Lisbon this weekend?}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

API_URL=$(out ApiUrl)
TOKEN_ENDPOINT=$(out TokenEndpoint)
CLIENT_ID=$(out MachineClientId)
USER_POOL_ID=$(out UserPoolId)
API_KEY_ID=$(out ApiKeyId)

# The client secret and the API key value are never stack outputs — an output is
# readable by anyone with stack read access, which is a wider audience than either
# credential deserves.
CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --profile "$PROFILE" \
  --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' --output text)

API_KEY=$(aws apigateway get-api-key --profile "$PROFILE" \
  --api-key "$API_KEY_ID" --include-value --query 'value' --output text)

echo "==> requesting a token for scopes: $SCOPES"
ACCESS_TOKEN=$(curl -sS -X POST "$TOKEN_ENDPOINT" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "scope=$SCOPES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

echo "==> 1/3  authorised call"
curl -sS -X POST "$API_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"prompt\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$PROMPT")}" \
  -w '\n   http %{http_code}  %{time_total}s\n'

echo "==> 2/3  same call without a token (expect 401)"
curl -sS -o /dev/null -X POST "$API_URL" \
  -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"prompt":"hello"}' -w '   http %{http_code}\n'

echo "==> 3/3  client-supplied sessionId (expect 200, and a session id it did not choose)"
curl -sS -X POST "$API_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"hi","sessionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  -w '\n   http %{http_code}\n'
