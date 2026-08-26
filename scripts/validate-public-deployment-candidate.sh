#!/usr/bin/env bash
# Validate deployment assets that are retained in the public Fabric seed.
#
# This runs only a bounded, credential-free local Compose smoke before static
# rendering/compilation. It must remain safe for untrusted fork pull requests:
# no cloud login, image push, or cloud-deployment command belongs here.
set -euo pipefail

readonly CHART_DIR="deploy/helm/fabric"
readonly COMPOSE_FILE="docker-compose.yml"
readonly BICEP_DIR="deployment/azure"
readonly MAIN_BICEP_TEMPLATE="$BICEP_DIR/main.bicep"
readonly COMPOSE_PROJECT_NAME="fabric-public-candidate-${GITHUB_RUN_ID:-local}-${RANDOM}-$$"
readonly VALIDATION_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fabric-public-deployment-candidate.XXXXXX")"

cleanup() {
  local status=$?
  local cleanup_status=0

  # Avoid recursively re-entering this handler when it exits with the final
  # validation/cleanup status below.
  trap - EXIT

  # A failed or interrupted smoke test must not leave containers, networks, or
  # named volumes behind on the runner. Cleanup failure cannot turn an
  # otherwise successful validation green.
  if ! timeout 60 docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" \
    down --volumes --remove-orphans >/dev/null; then
    echo "Compose cleanup failed for project: $COMPOSE_PROJECT_NAME" >&2
    cleanup_status=1
  fi
  if ! rm -rf "$VALIDATION_TEMP_DIR"; then
    echo "Validation temp-directory cleanup failed: $VALIDATION_TEMP_DIR" >&2
    cleanup_status=1
  fi

  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  exit "$cleanup_status"
}
trap cleanup EXIT

# The Bicep binary is a bundled .NET application. Keep its extraction cache in
# a disposable runner directory instead of the checkout or a user home.
export DOTNET_BUNDLE_EXTRACT_BASE_DIR="${DOTNET_BUNDLE_EXTRACT_BASE_DIR:-${RUNNER_TEMP:-/tmp}/bicep-bundle}"
mkdir -p "$DOTNET_BUNDLE_EXTRACT_BASE_DIR"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $1" >&2
    exit 1
  }
}

require_command docker
require_command helm
require_command bicep
require_command jq
require_command timeout

echo '== Validation tool versions =='
docker compose version
printf 'Helm '
helm version --template '{{ .Version }}'
printf '\n'
bicep --version
jq --version

echo '== Compose configuration =='
# `config` parses and resolves the shipped Compose file without starting a
# container, contacting a registry, or modifying a Docker resource.
docker compose -f "$COMPOSE_FILE" config --quiet --no-interpolate

echo '== Compose smoke: PostgreSQL and Redis =='
# These two root-stack services are credential-free, self-contained public
# self-hosting dependencies. `--wait` requires both declared health checks to
# pass and bounds startup to 90 seconds. A successful check also requires the
# EXIT trap to remove their project-scoped containers, network, and volumes.
# The application/agent stack is deliberately excluded because it needs
# uncommitted provider configuration.
if ! docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" \
  up --detach --wait --wait-timeout 90 postgres redis; then
  docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps || true
  exit 1
fi
docker compose --project-name "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" ps

echo '== Helm chart =='
helm lint "$CHART_DIR"
for profile in values-dev.yaml values-prod.yaml; do
  echo "Rendering Helm profile: $profile"
  helm template fabric "$CHART_DIR" \
    --namespace fabric \
    --values "$CHART_DIR/values.yaml" \
    --values "$CHART_DIR/$profile" \
    --set global.imageRegistry=registry.example.invalid \
    --set global.imageTag=validation \
    --set ingress.certificateArn=arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000 \
    >/dev/null
done

echo '== Bicep templates =='
mapfile -t bicep_files < <(find "$BICEP_DIR" -type f -name '*.bicep' -print | LC_ALL=C sort)
if [ "${#bicep_files[@]}" -eq 0 ]; then
  echo "No Bicep templates found in $BICEP_DIR" >&2
  exit 1
fi

# Compile every template present in the tree. The public seed may remove
# private-only modules, and this discovery keeps the check correct in the
# private master, rehearsal exports, and public repository without a
# repository-name exception.
for template in "${bicep_files[@]}"; do
  echo "Compiling Bicep template: $template"
  bicep build "$template" --stdout --no-restore >/dev/null
done

readonly MAIN_TEMPLATE_JSON="$VALIDATION_TEMP_DIR/main-template.json"
bicep build "$MAIN_BICEP_TEMPLATE" --stdout --no-restore > "$MAIN_TEMPLATE_JSON"

echo '== Bicep parameter files =='
mapfile -t bicep_parameter_files < <(find "$BICEP_DIR" -type f -name '*.bicepparam' -print | LC_ALL=C sort)
for parameter_file in "${bicep_parameter_files[@]}"; do
  echo "Compiling Bicep parameter file: $parameter_file"
  bicep build-params "$parameter_file" --stdout --no-restore >/dev/null
done

echo '== JSON deployment parameters =='
mapfile -t json_parameter_files < <(find "$BICEP_DIR" -type f -name '*.parameters.json' -print | LC_ALL=C sort)
validate_json_parameter_file() {
  local parameter_file="$1"

  jq -e '
    def value_matches_template_type($template_type; $value):
      if $template_type == "string" or $template_type == "securestring" then
        ($value | type) == "string"
      elif $template_type == "bool" then
        ($value | type) == "boolean"
      elif $template_type == "int" or $template_type == "secureint" then
        (($value | type) == "number") and ($value | floor == $value)
      elif $template_type == "array" then
        ($value | type) == "array"
      elif $template_type == "object" or $template_type == "secureobject" then
        ($value | type) == "object"
      else
        false
      end;
    def value_is_allowed($definition; $value):
      if ($definition | has("allowedValues")) then
        ($definition.allowedValues | index($value)) != null
      else
        true
      end;
    def valid_key_vault_reference:
      type == "object"
      and ((keys - ["keyVault", "secretName", "secretVersion"]) | length == 0)
      and (.keyVault | type == "object" and ((keys - ["id"]) | length == 0)
           and (.id | type == "string" and length > 0))
      and (.secretName | type == "string" and length > 0)
      and ((has("secretVersion") | not)
           or (.secretVersion | type == "string" and length > 0));
    def valid_assignment($definition):
      if $definition == null then
        false
      elif ((has("value")) == (has("reference"))) then
        false
      elif has("value") then
        .value as $value
        | value_matches_template_type($definition.type; $value)
        and value_is_allowed($definition; $value)
      else
        ($definition.type == "securestring") and (.reference | valid_key_vault_reference)
      end;
    type == "object"
    and (.["$schema"] | type == "string")
    and (.contentVersion | type == "string")
    and (.parameters | type == "object")
    and all(
      .parameters | to_entries[];
      .key as $name
      | (.value | valid_assignment($template[0].parameters[$name]))
    )
  ' --slurpfile template "$MAIN_TEMPLATE_JSON" "$parameter_file" >/dev/null
}

for parameter_file in "${json_parameter_files[@]}"; do
  echo "Checking JSON deployment parameters: $parameter_file"
  validate_json_parameter_file "$parameter_file"
done

echo '== JSON deployment parameter negative checks =='
readonly JSON_PARAMETER_FIXTURE="$BICEP_DIR/main.parameters.json"
readonly STRING_BOOLEAN_FIXTURE="$VALIDATION_TEMP_DIR/string-boolean.parameters.json"
readonly NULL_REFERENCE_FIXTURE="$VALIDATION_TEMP_DIR/null-reference.parameters.json"

jq '.parameters.enableMultiDestinationOtlp = { value: "false" }' \
  "$JSON_PARAMETER_FIXTURE" > "$STRING_BOOLEAN_FIXTURE"
if validate_json_parameter_file "$STRING_BOOLEAN_FIXTURE" >/dev/null 2>&1; then
  echo 'String boolean parameter value unexpectedly passed validation' >&2
  exit 1
fi

jq '.parameters.alertsWebhookUrl = { reference: null }' \
  "$JSON_PARAMETER_FIXTURE" > "$NULL_REFERENCE_FIXTURE"
if validate_json_parameter_file "$NULL_REFERENCE_FIXTURE" >/dev/null 2>&1; then
  echo 'Null Key Vault reference unexpectedly passed validation' >&2
  exit 1
fi
