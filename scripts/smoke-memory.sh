#!/usr/bin/env bash
# Does the agent remember? Two calls in one session, where the second is unanswerable
# without the first.
#
# The point is the pronoun. "the weather like there" carries no place name, so an answer
# naming Lisbon can only have come from history — it is not a question the model could
# have guessed its way through. Then we read the stored events back from the data plane,
# because an answer that happens to be right is not evidence that anything was written.
#
#   ./scripts/smoke-memory.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
STACK="${STACK_NAME:-TravelAssistantStack}"
SCOPES="${SCOPES:-tools/weather:read tools/places:read}"

out() {
  aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

API_URL=$(out ApiUrl)
TOKEN_ENDPOINT=$(out TokenEndpoint)
CLIENT_ID=$(out MachineClientId)
USER_POOL_ID=$(out UserPoolId)
API_KEY_ID=$(out ApiKeyId)
MEMORY_ID=$(out MemoryId)

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

ask() {
  curl -sS -X POST "$API_URL" \
    -H "authorization: Bearer $ACCESS_TOKEN" \
    -H "x-api-key: $API_KEY" \
    -H 'content-type: application/json' \
    -d "{\"prompt\": $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")}"
}

echo "==> 1/3  establishing context"
FIRST=$(ask "I am thinking about Lisbon for a short holiday. Tell me about the place.")
echo "$FIRST" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   ", d.get("response","")[:400])'
SESSION_ID=$(echo "$FIRST" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sessionId"])')

echo "==> 2/3  follow-up with no place name in it"
ask "What is the weather like there this weekend?" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("   ", d.get("response","")[:600]); print("    toolCalls:", d.get("toolCalls"), "| build:", d.get("build"))'

echo "==> 3/3  the events actually written, read back from the Memory data plane"
# actorId is derived server-side and never returned to the caller, so we recompute it the
# same way the BFF does. sub is the machine client id under client-credentials.
ACTOR_ID=$(python3 -c "
import hashlib
print('u-' + hashlib.sha256(('travel-assistant-actor:' + '$CLIENT_ID').encode()).hexdigest())
")
aws bedrock-agentcore list-events --profile "$PROFILE" \
  --memory-id "$MEMORY_ID" --actor-id "$ACTOR_ID" --session-id "$SESSION_ID" \
  --include-payloads --max-items 4 \
  --query 'events[].{at:eventTimestamp,turn:payload[].conversational.content.text}' --output json

echo
echo "Long-term preference records are extracted asynchronously — minutes, not seconds."
echo "Check them later with:"
echo "  aws bedrock-agentcore retrieve-memory-records --profile $PROFILE \\"
echo "    --memory-id $MEMORY_ID --namespace /preferences/$ACTOR_ID \\"
echo "    --search-criteria '{\"searchQuery\":\"travel preferences\"}'"
