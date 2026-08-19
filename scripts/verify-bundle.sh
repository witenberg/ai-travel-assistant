#!/usr/bin/env bash
# Loads the Lambda bundle that `cdk synth` actually produced, the way Lambda loads it.
#
# Why this exists: the first deploy of the BFF failed in INIT with
# `Dynamic require of "node:https" is not supported`, and nothing before the deploy could
# have caught it — the unit tests import the TypeScript source, not the bundle, and
# `cdk synth` only checks that esbuild exited zero. This script loads the emitted artifact
# so a bundling mistake fails here instead of in CloudWatch. It reads cdk.out rather than
# running esbuild itself: a second copy of the bundling flags would drift from CDK's and
# give false comfort.
#
# Three details, each of which produced a wrong answer before it was handled:
#   - take the *newest* asset. cdk.out keeps every past build, and an old one will happily
#     load while the one about to deploy does not.
#   - copy it out of the tree first. Node resolves module type from the nearest parent
#     package.json, and `infra/package.json` says "type": "module" — so a CJS bundle
#     sitting in cdk.out is parsed as ESM and appears to export nothing. Lambda unzips the
#     asset on its own, with no such parent, which the stub package.json below reproduces.
#   - load an .mjs bundle with import(), not require(). Node can require() an ES module,
#     so require() would pass a bundle that Lambda's ESM loader then rejects.
set -euo pipefail

cd "$(dirname "$0")/.."

ASSET=$(find infra/cdk.out -maxdepth 2 \( -name 'index.js' -o -name 'index.mjs' \) \
  -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)

if [[ -z "$ASSET" ]]; then
  echo "no bundled handler in infra/cdk.out — run 'cd infra && npx cdk synth' first" >&2
  exit 1
fi

echo "==> loading $ASSET"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp "$ASSET" "$WORK/"
printf '{"type":"%s"}\n' "$([[ "$ASSET" == *.mjs ]] && echo module || echo commonjs)" > "$WORK/package.json"

BASENAME=$(basename "$ASSET")
export AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/verify
export AWS_REGION=us-east-1

node --input-type=module -e "
  const mod = await import('$WORK/$BASENAME');
  const handler = mod.handler ?? mod.default?.handler;
  if (typeof handler !== 'function') {
    throw new Error('bundle exports no handler function; got: ' + Object.keys(mod).join(', '));
  }
  console.log('==> ok: handler loaded and is callable');
"
