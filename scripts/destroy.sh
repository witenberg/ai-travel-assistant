#!/usr/bin/env bash
# Tear the stack down, and prove it is gone.
#
# The project rule is that nothing is left running after a working session. Idle cost is near
# zero; the habit is the point, and the 10 USD cap is the reason the habit exists.
#
#   ./scripts/destroy.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-ai-playground}"
STACK="${STACK_NAME:-TravelAssistantStack}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE/infra"

npx cdk destroy --profile "$PROFILE" --force

echo
echo "==> confirming the stack is really gone"
if aws cloudformation describe-stacks --stack-name "$STACK" --profile "$PROFILE" \
     --query 'Stacks[0].StackStatus' --output text 2>/dev/null; then
  echo "!!! the stack still exists — do not walk away from this"
  exit 1
fi
echo "    it does not exist. Note: the Duffel secret went with it, so the next deploy needs"
echo "    put-secret-value again (ROADMAP step 2), and the generated .http / web/config.js"
echo "    files now point at nothing."
