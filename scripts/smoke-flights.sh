#!/usr/bin/env bash
# Does the outbound-auth edge of the diagram actually carry a credential?
#
# This is the only tool whose key comes from the AgentCore Identity token vault, so this
# script is the only end-to-end proof that the vault works. It asks three questions in
# order, and the order is the point:
#
#   1. did AgentCore deliver a workload access token to the container at all?
#      (the open unknown of ROADMAP step 2 — answered by the header-name diagnostic)
#   2. did the container exchange it for the Duffel key, or fall back to an environment
#      variable? (`"source":"identity"` versus `"source":"env"`)
#   3. did the call to Duffel then succeed? (a `tool.execute` span for search_flights)
#
# A real answer with prices proves 3 but not 2 — an answer looks identical whichever way
# the key was obtained, which is exactly why the source is logged.
#
#   ./scripts/smoke-flights.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
STACK="${STACK_NAME:-TravelAssistantStack}"
SCOPES="${SCOPES:-tools/flights:read}"
DEPARTURE="${DEPARTURE:-$(date -v+14d +%Y-%m-%d 2>/dev/null || date -d '+14 days' +%Y-%m-%d)}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

API_URL=$(out ApiUrl)
TOKEN_ENDPOINT=$(out TokenEndpoint)
CLIENT_ID=$(out MachineClientId)
USER_POOL_ID=$(out UserPoolId)
API_KEY_ID=$(out ApiKeyId)
RUNTIME_ARN=$(out RuntimeArn)
RUNTIME_ID="${RUNTIME_ARN##*/}"
LOG_GROUP="/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT"

CLIENT_SECRET=$(aws cognito-idp describe-user-pool-client --profile "$PROFILE" \
  --user-pool-id "$USER_POOL_ID" --client-id "$CLIENT_ID" \
  --query 'UserPoolClient.ClientSecret' --output text)

API_KEY=$(aws apigateway get-api-key --profile "$PROFILE" \
  --api-key "$API_KEY_ID" --include-value --query 'value' --output text)

ACCESS_TOKEN=$(curl -sS -X POST "$TOKEN_ENDPOINT" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode "scope=$SCOPES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

echo "==> 0/3  the secret must hold a real token, not the placeholder"
SECRET_ARN=$(out DuffelSecretArn)
# Prints the state of the secret without printing the secret: the first characters of a
# Duffel test token are a fixed prefix, and the placeholder is not it.
aws secretsmanager get-secret-value --profile "$PROFILE" --secret-id "$SECRET_ARN" \
  --query SecretString --output text \
  | python3 -c 'import sys,json; t=json.load(sys.stdin)["token"]; print("    token:", "REPLACE_ME (step 2 not finished)" if t=="REPLACE_ME" else t[:12] + "… (" + str(len(t)) + " chars)")'

echo "==> 1/3  asking the agent for flights"
SINCE=$(( $(date +%s) * 1000 ))
RESPONSE=$(curl -sS -X POST "$API_URL" \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H "x-api-key: $API_KEY" \
  -H 'content-type: application/json' \
  -d "{\"prompt\": \"Find flights from London to Lisbon on $DEPARTURE.\"}")
echo "$RESPONSE" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   ", d.get("response","")[:800]); print("    toolCalls:", d.get("toolCalls"))'

echo "==> 2/3  which header carried the workload access token (once per container)"
# Empty output here is normal on a warm container: the line is written once per process, so
# a container already serving this session logged it before this run. To see it, force a cold
# container with a session id nothing has used yet:
#   aws bedrock-agentcore invoke-agent-runtime --runtime-session-id <fresh 33+ chars> \
#     --runtime-user-id u-probe ...
sleep 12   # log delivery lags the call by a few seconds; an empty result here means "not yet"
aws logs filter-log-events --profile "$PROFILE" --log-group-name "$LOG_GROUP" \
  --start-time "$SINCE" --filter-pattern '{ $.event = "invocation_headers" }' \
  --query 'events[].message' --output text || true

echo "==> 3/3  where the Duffel key came from, and whether the call ran"
aws logs filter-log-events --profile "$PROFILE" --log-group-name "$LOG_GROUP" \
  --start-time "$SINCE" --filter-pattern '{ $.event = "duffel.credential" }' \
  --query 'events[].message' --output text || true
aws logs filter-log-events --profile "$PROFILE" --log-group-name "$LOG_GROUP" \
  --start-time "$SINCE" --filter-pattern '{ $.name = "tool.execute" }' \
  --query 'events[].message' --output text || true

echo
echo "Reading the result:"
echo "  workloadTokenHeader: null   -> AgentCore delivered no token; the vault cannot be read"
echo "  \"source\":\"identity\"        -> the key came from the token vault (what we want)"
echo "  \"source\":\"env\"             -> a leftover DUFFEL_ACCESS_TOKEN shadowed the vault"
echo "  Duffel test mode covers a subset of airlines and routes, so an empty offer list is"
echo "  a normal answer — the credential still worked. A 401 is the failure that matters."
