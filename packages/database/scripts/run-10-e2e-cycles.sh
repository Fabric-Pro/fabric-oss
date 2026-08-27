#!/usr/bin/env bash
# Orchestrate 10 consecutive full E2E dedup cycles.
#
# Each cycle:
#   1. Seed 2 baselines (exact-title + [BUG]-prefixed) with a unique tag
#   2. POST a synthetic 5-change proposal via the real HTTP API (using the
#      Playwright-extracted session cookie)
#   3. Wait for the Temporal workflow to reach COMPLETED
#   4. Verify DB state matches 5 dedup expectations
#   5. Cleanup
#
# Aggregates pass/fail across all 10 cycles. Exits non-zero if any fail.

set -uo pipefail

# Override with E2E_REPO_ROOT / E2E_COOKIE_JAR for a non-default checkout or
# cookie-jar location (e.g. on Windows under Git Bash).
REPO_ROOT="${E2E_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
COOKIE_JAR="${E2E_COOKIE_JAR:-${TMPDIR:-/tmp}/fabric-cookies.txt}"
TEMPORAL_UI="http://127.0.0.1:53354"
WEB_BASE="http://localhost:3001"
PROJECT_ID="cmpdzedh7000zck5hdtdgd12n"

cd -- "$REPO_ROOT" || {
  printf 'Unable to enter E2E repository root: %s\n' "$REPO_ROOT" >&2
  exit 1
}

mk_change() {
  local title="$1"
  local type="$2"
  cat <<JSON
{"action":"create","type":"$type","title":{"to":"$title","from":null},"description":{"to":"E2E loop test","from":null},"priority":{"to":"P2_MEDIUM","from":null},"size":{"to":"M","from":null},"parentEpicIdentifier":null,"parentFeatureIdentifier":null,"parentEpicTitle":null,"parentFeatureTitle":null,"existingExternalId":null,"reasoning":"E2E loop","sourceContext":"multiple"}
JSON
}

PASS=0
FAIL=0
FAILED_TAGS=()

for i in $(seq 1 10); do
  echo ""
  echo "============================================================"
  echo "CYCLE $i / 10"
  echo "============================================================"

  # Step 1: Seed baselines, capture fixture JSON
  echo "[$i] Seeding baselines..."
  FIXTURE=$(npx dotenv -c -e .env.local -- pnpm tsx packages/database/scripts/seed-e2e-baselines.ts 2>&1 | tail -1)
  if ! echo "$FIXTURE" | grep -q '"tag"'; then
    echo "[$i] FAIL: seed did not return fixture JSON: $FIXTURE"
    FAIL=$((FAIL+1))
    continue
  fi
  TAG=$(echo "$FIXTURE" | python -c "import json,sys; print(json.load(sys.stdin)['tag'])")
  echo "[$i] Tag: $TAG"

  # Step 2: Build approvedChanges array
  EXACT="$TAG Login crashes on Safari"
  PREFIXED_BARE="$TAG Pricing page misaligned"
  IN_BATCH="$TAG Desktop notifications"
  NOVEL="$TAG Novel feature with no collision"

  BODY=$(cat <<JSON
{"json":{"projectId":"$PROJECT_ID","organizationId":null,"syncToPM":false,"approvedChanges":[$(mk_change "$EXACT" story),$(mk_change "$PREFIXED_BARE" bug),$(mk_change "$IN_BATCH" story),$(mk_change "$IN_BATCH" story),$(mk_change "$NOVEL" story)]}}
JSON
)

  # Step 3: POST via curl with session cookie
  echo "[$i] POSTing workflow..."
  RESP=$(curl -s --cookie "$COOKIE_JAR" -X POST "$WEB_BASE/api/rpc/projects/backlog/applyChanges" \
    -H "Content-Type: application/json" \
    -H "x-correlation-id: e2e-loop-$i-$(date +%s)" \
    -d "$BODY")
  WORKFLOW_ID=$(echo "$RESP" | python -c "import json,sys; print(json.load(sys.stdin)['json']['workflowId'])" 2>/dev/null || echo "")
  if [ -z "$WORKFLOW_ID" ] || [ "$WORKFLOW_ID" = "None" ]; then
    echo "[$i] FAIL: no workflowId in response: $RESP"
    FAIL=$((FAIL+1))
    FAILED_TAGS+=("$TAG")
    continue
  fi
  echo "[$i] Workflow: $WORKFLOW_ID"

  # Step 4: Wait for completion (up to 60s per cycle)
  echo "[$i] Waiting for workflow..."
  for w in $(seq 1 30); do
    sleep 2
    STATUS=$(curl -s "$TEMPORAL_UI/api/v1/namespaces/default/workflows/$WORKFLOW_ID" 2>&1 | grep -oE 'WORKFLOW_EXECUTION_STATUS_[A-Z]+' | head -1)
    if [ "$STATUS" = "WORKFLOW_EXECUTION_STATUS_COMPLETED" ]; then
      echo "[$i] Workflow completed in ${w}*2s"
      break
    elif [ "$STATUS" = "WORKFLOW_EXECUTION_STATUS_FAILED" ] || [ "$STATUS" = "WORKFLOW_EXECUTION_STATUS_TERMINATED" ]; then
      echo "[$i] FAIL: workflow ended in $STATUS"
      FAIL=$((FAIL+1))
      FAILED_TAGS+=("$TAG")
      continue 2
    fi
  done
  if [ "$STATUS" != "WORKFLOW_EXECUTION_STATUS_COMPLETED" ]; then
    echo "[$i] FAIL: workflow did not complete (status=$STATUS)"
    FAIL=$((FAIL+1))
    FAILED_TAGS+=("$TAG")
    continue
  fi

  # Step 5: Verify DB
  echo "[$i] Verifying DB..."
  VERIFY_OUT=$(npx dotenv -c -e .env.local -- pnpm tsx packages/database/scripts/verify-e2e-result.ts "$TAG" 2>&1)
  echo "$VERIFY_OUT" | grep -E "PASS|FAIL —"
  PASS_COUNT=$(echo "$VERIFY_OUT" | grep -cE "PASS — ")
  FAIL_COUNT=$(echo "$VERIFY_OUT" | grep -cE "FAIL — ")
  if [ "$PASS_COUNT" = "5" ] && [ "$FAIL_COUNT" = "0" ]; then
    echo "[$i] CYCLE PASS (5/5)"
    PASS=$((PASS+1))
  else
    echo "[$i] CYCLE FAIL ($PASS_COUNT/5 PASS, $FAIL_COUNT FAIL)"
    FAIL=$((FAIL+1))
    FAILED_TAGS+=("$TAG")
  fi
done

echo ""
echo "============================================================"
echo "AGGREGATE RESULT: $PASS/10 PASS, $FAIL/10 FAIL"
echo "============================================================"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed tags: ${FAILED_TAGS[*]}"
  exit 1
fi
echo "ALL 10 CYCLES PASSED — no duplicates created across 50 dedup scenarios."
