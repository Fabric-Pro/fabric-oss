#!/usr/bin/env bash

set -euo pipefail

SOURCE_SHA="${1:-}"
EVIDENCE_PATH="${2:-oss-snapshot-consumer-manifest.json}"
SOURCE_REF="refs/heads/master"
SOURCE_REPOSITORY="Fabric-Pro/fabric-oss"
SIGNER_WORKFLOW="Fabric-Pro/fabric-oss/.github/workflows/oss-snapshot-images.yml"
SNAPSHOT_NAMESPACE="ghcr.io/fabric-pro/fabric-oss-snapshots"
POLL_INTERVAL_SECONDS="${SNAPSHOT_POLL_INTERVAL_SECONDS:-20}"
MAX_WAIT_SECONDS="${SNAPSHOT_MAX_WAIT_SECONDS:-1500}"

COMPONENTS=(
	api-agent
	backlog-updater
	data-analyst
	document-generator
	mcp-stdio-wrapper
	migration-runner
	project-document-generator
	prompt-enhancer
	story-breakdown
	task-planner
	temporal-worker
	weave-planners
	weave-readers
	weave-shuttle
)

fail() {
	echo "::error::$*" >&2
	exit 1
}

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] \
	|| fail "source SHA must be an exact lowercase 40-character commit OID"
[[ "$POLL_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]] \
	|| fail "poll interval must be a positive integer"
[[ "$MAX_WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] \
	|| fail "maximum wait must be a positive integer"
[[ -n "${GH_TOKEN:-}" ]] || fail "GH_TOKEN is required"
command -v docker >/dev/null || fail "docker is required"
command -v gh >/dev/null || fail "gh is required"
command -v jq >/dev/null || fail "jq is required"

mkdir -p "$(dirname "$EVIDENCE_PATH")"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

declare -A resolved_digests=()
started_at=$SECONDS

verify_attestation() {
	local component="$1"
	local predicate="$2"
	shift 2
	local output_file="${work_dir}/${component}.${predicate}.output"
	local error_file="${work_dir}/${component}.${predicate}.error"

	while true; do
		if gh attestation verify "$@" >"$output_file" 2>"$error_file"; then
			cat "$output_file"
			return 0
		fi

		if grep -Eqi \
			'(denied|unauthorized|authentication required|insufficient[_ ]scope|permission)' \
			"$error_file"; then
			cat "$error_file" >&2
			fail "fabric-dev cannot read ${predicate} attestations for ${component}"
		fi
		if ! grep -Eqi \
			'(no attestations? found|no associated attestations?|no attestation bundles?|no referrers|referrers?.*not found|manifest unknown)' \
			"$error_file"; then
			cat "$error_file" >&2
			fail "${predicate} attestation verification failed for ${component}"
		fi

		elapsed=$((SECONDS - started_at))
		if ((elapsed >= MAX_WAIT_SECONDS)); then
			cat "$error_file" >&2
			fail "timed out after ${elapsed}s waiting for ${component} ${predicate} attestation"
		fi
		echo "Waiting for ${component} ${predicate} attestation"
		sleep "$POLL_INTERVAL_SECONDS"
	done
}

while ((${#resolved_digests[@]} < ${#COMPONENTS[@]})); do
	for component in "${COMPONENTS[@]}"; do
		[[ -z "${resolved_digests[$component]:-}" ]] || continue

		image="${SNAPSHOT_NAMESPACE}/${component}"
		error_file="${work_dir}/${component}.inspect-error"
		config_error_file="${work_dir}/${component}.config-error"
		if descriptor=$(docker buildx imagetools inspect \
			"${image}:${SOURCE_SHA}" \
			--format '{{json .Manifest}}' 2>"$error_file"); then
			digest=$(jq -er \
				'.digest | select(type == "string" and test("^sha256:[0-9a-f]{64}$"))' \
				<<<"$descriptor") \
				|| fail "${component} returned an invalid OCI index digest"
			if jq -e '.manifests != null' <<<"$descriptor" >/dev/null; then
				jq -e \
					'[.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64")] | length == 1' \
					<<<"$descriptor" >/dev/null \
					|| fail "${component} does not contain exactly one linux/amd64 manifest"
			else
				jq -e \
					'.mediaType == "application/vnd.oci.image.manifest.v1+json" or .mediaType == "application/vnd.docker.distribution.manifest.v2+json"' \
					<<<"$descriptor" >/dev/null \
					|| fail "${component} returned an unsupported manifest type"
				if ! image_config=$(docker buildx imagetools inspect \
					"${image}@${digest}" \
					--format '{{json .Image}}' 2>"$config_error_file"); then
					if grep -Eqi \
						'(denied|unauthorized|authentication required|insufficient[_ ]scope|permission)' \
						"$config_error_file"; then
						cat "$config_error_file" >&2
						fail "fabric-dev does not have read access to ${image}@${digest}"
					fi
					continue
				fi
				jq -e '.os == "linux" and .architecture == "amd64"' \
					<<<"$image_config" >/dev/null \
					|| fail "${component} is not a linux/amd64 image"
			fi
			resolved_digests["$component"]="$digest"
			echo "Resolved ${component} to ${digest}"
		elif grep -Eqi \
			'(denied|unauthorized|authentication required|insufficient[_ ]scope|permission)' \
			"$error_file"; then
			cat "$error_file" >&2
			fail "fabric-dev does not have read access to ${image}"
		fi
	done

	((${#resolved_digests[@]} < ${#COMPONENTS[@]})) || break
	elapsed=$((SECONDS - started_at))
	if ((elapsed >= MAX_WAIT_SECONDS)); then
		missing=()
		for component in "${COMPONENTS[@]}"; do
			[[ -n "${resolved_digests[$component]:-}" ]] || missing+=("$component")
		done
		fail "timed out after ${elapsed}s waiting for exact-SHA snapshots: ${missing[*]}"
	fi

	echo "Waiting for $(( ${#COMPONENTS[@]} - ${#resolved_digests[@]} )) exact-SHA snapshot(s)"
	sleep "$POLL_INTERVAL_SECONDS"
done

evidence_jsonl="${work_dir}/verified-images.jsonl"
: >"$evidence_jsonl"

for component in "${COMPONENTS[@]}"; do
	image="${SNAPSHOT_NAMESPACE}/${component}"
	digest="${resolved_digests[$component]}"
	common_args=(
		--bundle-from-oci
		--repo "$SOURCE_REPOSITORY"
		--signer-workflow "$SIGNER_WORKFLOW"
		--source-digest "$SOURCE_SHA"
		--source-ref "$SOURCE_REF"
		--deny-self-hosted-runners
	)

	verify_attestation "$component" provenance \
		"oci://${image}@${digest}" "${common_args[@]}"
	verify_attestation "$component" spdx \
		"oci://${image}@${digest}" \
		"${common_args[@]}" \
		--predicate-type https://spdx.dev/Document/v2.3

	jq -cn \
		--arg component "$component" \
		--arg image "$image" \
		--arg tag "$SOURCE_SHA" \
		--arg digest "$digest" \
		'{component: $component, image: $image, tag: $tag, digest: $digest}' \
		>>"$evidence_jsonl"
done

jq -s \
	--arg sourceSha "$SOURCE_SHA" \
	--arg sourceRef "$SOURCE_REF" \
	--arg sourceRepository "$SOURCE_REPOSITORY" \
	--arg signerWorkflow "$SIGNER_WORKFLOW" \
	'{
		schemaVersion: "1.0.0",
		mode: "verification-only",
		sourceSha: $sourceSha,
		sourceRef: $sourceRef,
		sourceRepository: $sourceRepository,
		signerWorkflow: $signerWorkflow,
		attestationSource: "oci-registry",
		images: .
	}' "$evidence_jsonl" >"$EVIDENCE_PATH"

echo "Verified ${#COMPONENTS[@]} private snapshots for ${SOURCE_SHA}"
