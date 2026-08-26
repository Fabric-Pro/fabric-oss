#!/usr/bin/env bash
# Grant the Fabric worker read access to an environment's Log Analytics
# workspace, so bug-analysis log context (Fizzy #1234) can query it.
#
# WHY THIS IS A SCRIPT AND NOT PART OF THE BICEP TEMPLATE
#
# The deploy service principal does not hold
# `Microsoft.Authorization/roleAssignments/write`. When the template declared
# this assignment, ARM rejected the WHOLE deployment — not just the log
# feature — and every infrastructure deploy failed until it was removed.
#
# Giving the deploy SP that right means User Access Administrator, which would
# let it assign any role in the resource group. That is far more power than
# this feature justifies, so the grant stays a deliberate, one-time step run by
# somebody who already has the rights.
#
# WHY IT CALLS ARM DIRECTLY INSTEAD OF `az role assignment`
#
# `az role assignment list|create --scope <resource id>` fails with
# `MissingSubscription` on Azure CLI 2.89.0 even with an active default
# subscription and `--subscription` passed explicitly. The same query through
# `az rest` works. `--resource-group` also works, but that would assign at the
# resource-group scope, which is wider than this needs — the point is to grant
# read on ONE workspace, not on everything in the group. So the script speaks
# to the ARM REST API, which is the form that is both correct and functional.
#
# SAFE TO RE-RUN. It checks for an existing assignment first and does nothing
# if one is present, so it can be run after every environment rebuild.
#
# Until it is run the worker receives a 403 from the log platform, which the
# feature degrades to "logs were not available": the analysis still succeeds
# and the user is told why. No redeploy is needed once the role lands.
#
# Usage:
#   ./grant-log-analytics-reader.sh <resource-group> [workspace-name] [identity-name]
#
# Names default to the `<resource-group-prefix>-logs` / `-identity` convention
# this estate uses, so normally only the resource group is needed:
#   ./grant-log-analytics-reader.sh fabric-dev-rg

set -euo pipefail

RG="${1:-}"
if [ -z "$RG" ]; then
	echo "usage: $0 <resource-group> [workspace-name] [identity-name]" >&2
	exit 2
fi

# `fabric-dev-rg` -> `fabric-dev`
PREFIX="${RG%-rg}"
WORKSPACE="${2:-${PREFIX}-logs}"
IDENTITY="${3:-${PREFIX}-identity}"

# Log Analytics Reader. Read-only by construction: it cannot write, and it
# carries no rights over anything but the workspace it is scoped to.
ROLE_ID="73c42c96-874c-492b-b04d-ab87d138a893"

SUBSCRIPTION="$(az account show --query id -o tsv)"
if [ -z "$SUBSCRIPTION" ]; then
	echo "no active subscription — run 'az login' and 'az account set'" >&2
	exit 1
fi

PRINCIPAL_ID="$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)"
SCOPE="$(az monitor log-analytics workspace show -g "$RG" -n "$WORKSPACE" --query id -o tsv)"

if [ -z "$PRINCIPAL_ID" ] || [ -z "$SCOPE" ]; then
	echo "could not resolve the identity or the workspace — check the names" >&2
	exit 1
fi

echo "resource group : $RG"
echo "workspace      : $WORKSPACE"
echo "identity       : $IDENTITY"
echo "principal      : $PRINCIPAL_ID"
echo "scope          : $SCOPE"

ARM="https://management.azure.com"
LIST_URL="${ARM}${SCOPE}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&\$filter=atScope()"

# `atScope()` also returns assignments inherited from the resource group and
# subscription, which is what we want: an inherited grant is still a grant, and
# re-granting at the workspace would be noise.
count_existing() {
	az rest --method get --url "$LIST_URL" -o json 2>/dev/null | python -c "
import json,sys
try:
    data = json.load(sys.stdin)
except Exception:
    print(0); raise SystemExit
print(sum(
    1 for a in data.get('value', [])
    if a.get('properties', {}).get('principalId') == '$PRINCIPAL_ID'
    and a.get('properties', {}).get('roleDefinitionId', '').rsplit('/', 1)[-1] == '$ROLE_ID'
))"
}

if [ "$(count_existing)" != "0" ]; then
	echo "already granted — nothing to do"
	exit 0
fi

ASSIGNMENT_ID="$(python -c 'import uuid; print(uuid.uuid4())')"
BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT
cat > "$BODY_FILE" <<JSON
{
  "properties": {
    "roleDefinitionId": "/subscriptions/${SUBSCRIPTION}/providers/Microsoft.Authorization/roleDefinitions/${ROLE_ID}",
    "principalId": "${PRINCIPAL_ID}",
    "principalType": "ServicePrincipal"
  }
}
JSON

az rest --method put \
	--url "${ARM}${SCOPE}/providers/Microsoft.Authorization/roleAssignments/${ASSIGNMENT_ID}?api-version=2022-04-01" \
	--body "@${BODY_FILE}" \
	--output none

echo "granted Log Analytics Reader"

# Prove it, rather than trusting the exit code: RBAC writes are eventually
# consistent and a create can return before the assignment is readable.
for _ in 1 2 3 4 5 6; do
	if [ "$(count_existing)" != "0" ]; then
		echo "verified"
		exit 0
	fi
	sleep 5
done

echo "created but not yet visible — re-run to confirm" >&2
exit 1
