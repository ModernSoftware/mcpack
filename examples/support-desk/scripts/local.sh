#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose build
# Moto is ephemeral. Rerun seed whenever S3 is recreated; DB writes are preserved.
docker compose up -d --wait db s3
docker compose run --rm seed
docker compose up -d --wait refunds mcp
printf 'Support Desk ready at http://localhost:3000/mcp (local-only token: local-mcp-only)\n'
