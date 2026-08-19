#!/usr/bin/env bash
# Loads every Lambda bundle that `cdk synth` actually produced, the way Lambda loads it.
#
# Why this exists: the first deploy of the BFF failed in INIT with
# `Dynamic require of "node:https" is not supported`, and nothing before the deploy could
# have caught it — the unit tests import the TypeScript source, not the bundle, and
# `cdk synth` only checks that esbuild exited zero. This script loads the emitted artifacts
# so a bundling mistake fails here instead of in CloudWatch. It reads cdk.out rather than
# running esbuild itself: a second copy of the bundling flags would drift from CDK's and
# give false comfort.
#
# Three details, each of which produced a wrong answer before it was handled:
#   - read the asset list from `*.assets.json`. cdk.out keeps every past build, so picking
#     files off the filesystem finds stale bundles that load happily while the one about to
#     deploy does not. The manifest lists exactly what this synth will upload.
#   - copy each asset out of the tree first. Node resolves module type from the nearest
#     parent package.json, and `infra/package.json` says "type": "module" — so a CJS bundle
#     sitting in cdk.out is parsed as ESM and appears to export nothing. Lambda unzips the
#     asset on its own, with no such parent, which the stub package.json below reproduces.
#   - load an .mjs bundle with import(), not require(). Node can require() an ES module,
#     so require() would pass a bundle that Lambda's ESM loader then rejects.
set -euo pipefail

cd "$(dirname "$0")/.."

MANIFEST=$(find infra/cdk.out -maxdepth 1 -name '*.assets.json' | head -1)
if [[ -z "$MANIFEST" ]]; then
  echo "no assets manifest in infra/cdk.out — run 'cd infra && npx cdk synth' first" >&2
  exit 1
fi

# Asset directories this synth will publish, in manifest order. Read with a while loop
# rather than `mapfile`, which macOS's bundled bash 3.2 does not have.
ASSET_DIRS=()
while IFS= read -r LINE; do
  ASSET_DIRS+=("$LINE")
done < <(
  node -e '
    const manifest = require("./" + process.argv[1]);
    for (const file of Object.values(manifest.files ?? {})) {
      const p = file.source?.path;
      if (p && p.startsWith("asset.")) console.log(p);
    }
  ' "$MANIFEST"
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CHECKED=0
for DIR in ${ASSET_DIRS[@]+"${ASSET_DIRS[@]}"}; do
  ENTRY=""
  for CANDIDATE in index.js index.mjs; do
    [[ -f "infra/cdk.out/$DIR/$CANDIDATE" ]] && ENTRY="$CANDIDATE" && break
  done
  # Not every asset is a Node bundle — the agent image and any plain-file asset are not.
  [[ -z "$ENTRY" ]] && continue

  echo "==> loading $DIR/$ENTRY"
  SANDBOX="$WORK/$DIR"
  mkdir -p "$SANDBOX"
  cp "infra/cdk.out/$DIR/$ENTRY" "$SANDBOX/"
  printf '{"type":"%s"}\n' "$([[ "$ENTRY" == *.mjs ]] && echo module || echo commonjs)" > "$SANDBOX/package.json"

  AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-east-1:000000000000:runtime/verify \
  AWS_REGION=us-east-1 \
  node --input-type=module -e "
    const mod = await import('$SANDBOX/$ENTRY');
    const handler = mod.handler ?? mod.default?.handler;
    if (typeof handler !== 'function') {
      throw new Error('bundle exports no handler function; got: ' + Object.keys(mod).join(', '));
    }
    console.log('    ok: handler loaded and is callable');
  "
  CHECKED=$((CHECKED + 1))
done

if [[ "$CHECKED" -eq 0 ]]; then
  echo "no Node bundles found among this synth's assets — did the functions change?" >&2
  exit 1
fi

echo "==> ok: $CHECKED bundle(s) load the way Lambda loads them"
