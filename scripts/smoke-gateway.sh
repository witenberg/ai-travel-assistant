#!/usr/bin/env bash
# Checks AgentCore Gateway from both sides: as an MCP client directly, and end to end
# through the agent.
#
# Direct MCP calls come first on purpose. If the Gateway refuses a tool call, we need to
# know whether the refusal came from the Gateway or from our own code, and the only way to
# be sure is to speak to the Gateway with no agent in between. That is also the cheapest
# check available — `tools/list` costs no model tokens at all.
#
# The scope split is the whole test: the token asks for weather and places but *not*
# photos, so `get_photos` must be refused by the interceptor while `get_weather` succeeds.
# A run where everything is allowed proves only that the plumbing is connected.
#
#   ./scripts/smoke-gateway.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
STACK="${STACK_NAME:-TravelAssistantStack}"
REGION="${AWS_REGION:-us-east-1}"
# Deliberately without tools/photos:search.
SCOPES="${SCOPES:-tools/weather:read tools/places:read}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

json() { python3 -c 'import sys,json; print(json.load(sys.stdin)'"$1"')'; }

GATEWAY_URL=$(out GatewayUrl)
GATEWAY_ID=$(out GatewayId)
API_URL=$(out ApiUrl)
TOKEN_ENDPOINT=$(out TokenEndpoint)
CLIENT_ID=$(out MachineClientId)
USER_POOL_ID=$(out UserPoolId)
API_KEY_ID=$(out ApiKeyId)

CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --profile "$PROFILE" \
  --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' --output text)

API_KEY=$(aws apigateway get-api-key --profile "$PROFILE" \
  --api-key "$API_KEY_ID" --include-value --query 'value' --output text)

echo "==> gateway: $GATEWAY_URL"
echo "==> requesting a token for scopes: $SCOPES"
ACCESS_TOKEN=$(curl -sS -X POST "$TOKEN_ENDPOINT" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "scope=$SCOPES" | json '["access_token"]')

# One helper for every JSON-RPC call, so the request shape is identical to the agent's.
mcp() {
  curl -sS -X POST "$GATEWAY_URL" \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H 'mcp-protocol-version: 2025-06-18' \
    -H 'x-travel-session-id: smoke-gateway-session' \
    -d "$1"
}

echo
echo "==> 1/5  MCP tools/list (expect three tools, prefixed travel-tools___)"
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | tee /tmp/mcp-list.json
echo

echo "==> 2/5  tools/call get_weather — scope granted (expect a real forecast)"
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"travel-tools___get_weather","arguments":{"city":"Lisbon"}}}' \
  | head -c 900
echo

echo "==> 3/5  tools/call get_photos — scope NOT granted (expect isError with blocked:true)"
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"travel-tools___get_photos","arguments":{"place":"Lisbon"}}}'
echo
echo "    The refusal above must come from the interceptor, not from the agent — there is"
echo "    no agent in this request. If it says blocked:true, AgentCore made the decision."

echo
echo "==> 4/5  the interceptor's own log group (the diagram's denial trace)"
echo "    /aws/lambda/travel-assistant-gateway-interceptor"
sleep 8   # log delivery lags the call by a few seconds
aws logs filter-log-events --profile "$PROFILE" --region "$REGION" \
  --log-group-name /aws/lambda/travel-assistant-gateway-interceptor \
  --start-time "$(python3 -c 'import time; print(int((time.time()-300)*1000))')" \
  --filter-pattern '{ $.name = "gateway.authorize" }' \
  --query 'events[].message' --output text || echo "    (no spans yet — try again in a few seconds)"

echo
echo "==> 5/5  end to end through the agent (expect an honest refusal about photos)"
curl -sS -X POST "$API_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"Show me photos of Lisbon and tell me the weather there this weekend."}' \
  -w '\n   http %{http_code}  %{time_total}s\n'

cat <<EOF

What to check in the output above:
  1. three tools, named travel-tools___get_place_details / _get_weather / _get_photos.
     A name without the prefix means the target name and src/gateway/naming.ts disagree.
  2. a real forecast, with weekday names computed by the tool rather than by the model.
  3. blocked:true from the Gateway, with no agent involved.
  4. a gateway.authorize span with status "blocked", carrying sessionId
     "smoke-gateway-session" — proof the session survives the hop across the Gateway.
  5. toolCalls containing get_weather (blocked false) and get_photos (blocked true), and
     an answer that gives the forecast and says plainly why there are no photos.

Gateway's own log group, if AWS wrote anything to it:
  aws logs tail /aws/bedrock-agentcore/gateways/$GATEWAY_ID --profile $PROFILE
EOF
