#!/usr/bin/env bash
# Smoke-test the deployed GitHub webhook by sending a signed payload
# directly to the Notion-hosted webhook URL. Mirrors what GitHub does
# in production — no GitHub repo required to demo.
#
# Usage:
#   ./test/curl-webhook.sh <event>   # event = star | issues | fork
#
# Prereqs:
#   1. ntn workers deploy
#   2. ntn workers env push           (push .env to remote)
#   3. ntn workers webhooks list      (note the onGithubEvent URL)
#   4. Export WEBHOOK_URL to that value, or set it below.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

: "${GITHUB_WEBHOOK_SECRET:?Set GITHUB_WEBHOOK_SECRET in .env first}"
: "${WEBHOOK_URL:?Export WEBHOOK_URL (from \`ntn workers webhooks list\`)}"

event="${1:-star}"
case "$event" in
	star)   fixture=test/fixtures/github-star.json  ;;
	issues) fixture=test/fixtures/github-issue.json ;;
	*) echo "Unknown event: $event (use star|issues)"; exit 1 ;;
esac

raw_body=$(cat "$fixture")
signature="sha256=$(printf '%s' "$raw_body" \
	| openssl dgst -sha256 -hmac "$GITHUB_WEBHOOK_SECRET" -binary \
	| xxd -p -c 256)"

curl -fsS -X POST "$WEBHOOK_URL" \
	-H "Content-Type: application/json" \
	-H "X-GitHub-Event: $event" \
	-H "X-GitHub-Delivery: smoke-$(date +%s)" \
	-H "X-Hub-Signature-256: $signature" \
	--data-binary "$raw_body"

echo
echo "✔ POSTed $event fixture to webhook"
echo "  → tail logs with: ntn workers runs logs \$(ntn workers runs list --plain | head -1 | cut -f1)"
