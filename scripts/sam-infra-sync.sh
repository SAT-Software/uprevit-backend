#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="${SAM_STACK_NAME:-uprevit-test}"
REGION="${AWS_REGION:-us-east-1}"
WATCH=false

if [[ "${1:-}" == "--watch" ]]; then
  WATCH=true
fi

trap 'npm run install:src' EXIT

SAM_ARGS=(
  --no-build-in-source
  --stack-name "$STACK_NAME"
  --region "$REGION"
)

set +e
if $WATCH; then
  sam sync --watch "${SAM_ARGS[@]}"
else
  sam sync "${SAM_ARGS[@]}"
fi
exit "$?"
