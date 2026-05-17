#!/usr/bin/env bash
# Smoke-test the local email webhook Express server.
#
# Usage:
#   Terminal 1: npm run dev:email-webhook
#   Terminal 2: npm run test:email-webhook
#
# Env (optional):
#   EMAIL_WEBHOOK_PORT   — dev server port (default: 3001)
#   EMAIL_WEBHOOK_URL    — curl target (default: http://localhost:${PORT}/onEmailReceived)
#
# For deployed Notion webhook, set EMAIL_WEBHOOK_URL from `ntn workers webhooks list`.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

port="${EMAIL_WEBHOOK_PORT:-3001}"
url="${EMAIL_WEBHOOK_URL:-http://localhost:${port}/onEmailReceived}"

payload='{"type":"email","subject":"Local smoke test","from":"test@example.com"}'

curl -fsS -X POST "$url" \
	-H "Content-Type: application/json" \
	-H "X-Delivery-Id: smoke-$(date +%s)" \
	--data-binary "$payload"

echo
echo "✔ POSTed email fixture to $url"
echo "  → local logs: check the dev:email-webhook terminal"
echo "  → prod logs:  ntn workers runs list --plain | grep onEmailReceived"
