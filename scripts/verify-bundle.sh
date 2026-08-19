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
#   - read the asset list from this synth's `*.template.json`. cdk.out keeps every past build,
#     so picking files off the filesystem finds stale bundles that load happily while the one
#     about to deploy does not. The template lists exactly what this synth will deploy, and
#     unlike the asset manifest it also names the construct each asset belongs to.
#   - copy each asset out of the tree first. Node resolves module type from the nearest
#     parent package.json, and `infra/package.json` says "type": "module" — so a CJS bundle
#     sitting in cdk.out is parsed as ESM and appears to export nothing. Lambda unzips the
#     asset on its own, with no such parent, which the stub package.json below reproduces.
#   - load an .mjs bundle with import(), not require(). Node can require() an ES module,
#     so require() would pass a bundle that Lambda's ESM loader then rejects.
#   - check only the bundles esbuild built for us. Adding `logs.LogRetention` to the stack put
#     a CDK-authored Lambda into cdk.out, and loading it failed here on a missing
#     `@aws-sdk/client-cloudwatch-logs` — a module the Lambda runtime provides and our
#     node_modules does not. A red gate that says nothing about our code is worse than no gate,
#     because the next person silences it.
set -euo pipefail

cd "$(dirname "$0")/.."

TEMPLATE=$(find infra/cdk.out -maxdepth 1 -name '*.template.json' ! -name 'manifest*' | head -1)
if [[ -z "$TEMPLATE" ]]; then
  echo "no template in infra/cdk.out — run 'cd infra && npx cdk synth' first" >&2
  exit 1
fi

# Read the Lambda functions out of this synth's template rather than the asset manifest. The
# manifest lists assets; the template says which construct each one belongs to, and that name
# is what lets the skip below explain itself instead of silently dropping something.
#
# Only the bundles **esbuild produced for us** are checked, and the marker is the sourcemap it
# emits next to each one. CDK stages Lambda code of its own for its custom resources — here the
# `LogRetention` provider that gives the AgentCore log group its expiry — and that code is
# AWS's, pre-packaged, and legitimately relies on the AWS SDK the Lambda runtime provides but
# our node_modules does not. Loading it locally fails on a missing `@aws-sdk/*` and says nothing
# whatever about our bundling. This script exists to catch *our* esbuild mistakes.
ASSET_DIRS=()
while IFS= read -r LINE; do
  ASSET_DIRS+=("$LINE")
done < <(
  node -e '
    const fs = require("node:fs");
    const template = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const [id, res] of Object.entries(template.Resources ?? {})) {
      if (res.Type !== "AWS::Lambda::Function") continue;
      const dir = res.Metadata?.["aws:asset:path"];
      const construct = res.Metadata?.["aws:cdk:path"] ?? id;
      if (!dir?.startsWith("asset.")) continue;
      if (!fs.existsSync(`infra/cdk.out/${dir}/index.js.map`)) {
        console.error(`    skipping ${construct} — no esbuild sourcemap, so it is not ours`);
        continue;
      }
      console.log(dir);
    }
  ' "$TEMPLATE"
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
