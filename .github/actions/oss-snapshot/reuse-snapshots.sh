#!/usr/bin/env bash
# The reuse job of .github/workflows/private-staging-images.yml, for the chunk
# of reused components in REUSED (the plan's reuse entries, as JSON).
#
#   verify   Checks each reused digest exactly as ops admission would for the
#            SHA it was reused from, and that it carries the planned inputs.
#            Writes the carried-forward SBOM and the reuse provenance, and the
#            step outputs component_N, image_N, digest_N, sbom_N and
#            provenance_N that the slot N attestation steps read.
#   publish  Run after both attestations exist. Tags each digest with the
#            full SHA, verifies it with exactly admission's arguments for this
#            SHA, and writes its manifest fragment.
#
# Every component runs in its own worker, all at once. The join is a hard
# barrier: the phase ends only after every worker has, and fails naming each
# component that failed. Status travels through per-worker files, read by an
# EXIT trap, so errexit still applies inside each worker (`worker || s=$?`
# would turn it off for the whole worker), the same pattern as admission's
# dev-snapshots.sh.
set -euo pipefail

MODULE=.github/actions/oss-snapshot/snapshot-reuse.mjs
WORK_DIR="$RUNNER_TEMP/reuse-snapshots"

COMPONENT_LIST=$(jq -er '.[].component' <<<"$REUSED")
mapfile -t COMPONENTS <<<"$COMPONENT_LIST"
if (( ${#COMPONENTS[@]} > REUSE_SLOTS )); then
  echo "::error::${#COMPONENTS[@]} reused components exceed the $REUSE_SLOTS attestation slots"
  exit 1
fi
mkdir -p "$WORK_DIR" "$EVIDENCE_DIR"

# Sets the reuse entry's fields for slot $1.
load() {
  local entry
  entry=$(jq -ce --argjson index "$1" '.[$index]' <<<"$REUSED")
  COMPONENT=$(jq -r '.component // ""' <<<"$entry")
  DOCKERFILE=$(jq -r '.dockerfile // ""' <<<"$entry")
  DIGEST=$(jq -r '.digest // ""' <<<"$entry")
  INPUTS=$(jq -r '.inputs // ""' <<<"$entry")
  REUSED_SHA=$(jq -r '.reusedSourceSha // ""' <<<"$entry")
  REUSED_RUN=$(jq -r '.reusedRun // ""' <<<"$entry")
  BUILT_SHA=$(jq -r '.builtSourceSha // ""' <<<"$entry")
  [[ "$COMPONENT" =~ ^[a-z0-9][a-z0-9-]*$ && "$DIGEST" =~ ^sha256:[0-9a-f]{64}$
    && "$REUSED_SHA" =~ ^[0-9a-f]{40}$ && "$BUILT_SHA" =~ ^[0-9a-f]{40}$ ]] \
    || { echo "::error::malformed reuse plan"; return 1; }
  IMAGE_NAME="$SNAPSHOT_NAMESPACE/$COMPONENT"
}

verify_one() {
  load "$1"
  local common_args=(
    --bundle-from-oci
    --repo "$REPOSITORY"
    --signer-workflow "$SIGNER_WORKFLOW"
    --source-digest "$REUSED_SHA"
    --source-ref "$GITHUB_REF"
    --deny-self-hosted-runners
  )
  gh attestation verify "oci://${IMAGE_NAME}@${DIGEST}" "${common_args[@]}" >/dev/null
  # Compact: the worker's SBOM pretty-printed exceeds the 16 MiB
  # attestation limit that the original file stays under.
  gh attestation verify "oci://${IMAGE_NAME}@${DIGEST}" "${common_args[@]}" \
    --predicate-type https://spdx.dev/Document/v2.3 --format json \
    | jq -ce '.[0].verificationResult.statement.predicate' >"$EVIDENCE_DIR/$COMPONENT.spdx.json"
  local image
  image=$(docker buildx imagetools inspect "${IMAGE_NAME}@${DIGEST}" --format '{{json .}}')
  jq -e --arg digest "$DIGEST" --arg label "$INPUTS_LABEL" --arg inputs "$INPUTS" --arg built "$BUILT_SHA" '
      .manifest.digest == $digest
      and .image.config.Labels[$label] == $inputs
      and .image.config.Labels["org.opencontainers.image.revision"] == $built' <<<"$image" >/dev/null \
    || { echo "::error::${IMAGE_NAME}@${DIGEST} does not carry the planned inputs"; return 1; }
  local reused
  reused=$(jq -n --arg image "$IMAGE_NAME" --arg digest "$DIGEST" --arg inputs "$INPUTS" \
    --arg reusedSourceSha "$REUSED_SHA" --arg reusedRun "$REUSED_RUN" --arg builtSourceSha "$BUILT_SHA" \
    '$ARGS.named')
  node "$MODULE" provenance --reused "$reused" >"$WORK_DIR/$COMPONENT.provenance.json"
}

publish_one() {
  load "$1"
  docker buildx imagetools create --prefer-index=false \
    --tag "${IMAGE_NAME}:${GITHUB_SHA}" "${IMAGE_NAME}@${DIGEST}"
  local tagged
  tagged=$(docker buildx imagetools inspect "${IMAGE_NAME}:${GITHUB_SHA}" --format '{{json .Manifest}}' | jq -r '.digest')
  [[ "$tagged" == "$DIGEST" ]] \
    || { echo "::error::${IMAGE_NAME}:${GITHUB_SHA} resolves to $tagged, expected $DIGEST"; return 1; }
  # Exactly the arguments ops admission uses, including registry-held
  # bundles: the digest now also carries the reused run's attestations.
  local common_args=(
    --bundle-from-oci
    --repo "$REPOSITORY"
    --signer-workflow "$SIGNER_WORKFLOW"
    --source-digest "$GITHUB_SHA"
    --source-ref "$GITHUB_REF"
    --deny-self-hosted-runners
  )
  gh attestation verify "oci://${IMAGE_NAME}@${DIGEST}" "${common_args[@]}"
  gh attestation verify "oci://${IMAGE_NAME}@${DIGEST}" \
    "${common_args[@]}" \
    --predicate-type https://spdx.dev/Document/v2.3
  jq -n \
    --arg component "$COMPONENT" \
    --arg dockerfile "$DOCKERFILE" \
    --arg image "$IMAGE_NAME" \
    --arg tag "$GITHUB_SHA" \
    --arg digest "$DIGEST" \
    --arg inputs "$INPUTS" \
    --arg sourceSha "$GITHUB_SHA" \
    --arg sourceRef "$GITHUB_REF" \
    --arg sourceRepository "$REPOSITORY" \
    --arg buildWorkflow "$WORKFLOW_REF" \
    --arg signerWorkflow "$SIGNER_WORKFLOW" \
    --arg sourceUrl "$SOURCE_URL" \
    --arg reusedSha "$REUSED_SHA" \
    --arg reusedRun "$REUSED_RUN" \
    --arg builtSha "$BUILT_SHA" \
    '{
      schemaVersion: "1.0.0",
      component: $component,
      dockerfile: $dockerfile,
      context: ".",
      image: $image,
      tag: $tag,
      digest: $digest,
      inputs: $inputs,
      sourceSha: $sourceSha,
      sourceRef: $sourceRef,
      sourceRepository: $sourceRepository,
      buildWorkflow: $buildWorkflow,
      signerWorkflow: $signerWorkflow,
      labels: {
        "org.opencontainers.image.source": $sourceUrl,
        "org.opencontainers.image.revision": $builtSha
      },
      attestations: {
        provenance: "https://slsa.dev/provenance/v1",
        sbom: "https://spdx.dev/Document/v2.3"
      },
      reuse: {
        reusedFromSourceSha: $reusedSha,
        reusedFromRun: $reusedRun,
        builtFromSourceSha: $builtSha
      }
    }' >"$EVIDENCE_DIR/$COMPONENT.manifest.json"
}

each_component() { # <what failed> <worker>
  local failure="$1" worker="$2" status_dir index pids=() failed=0
  status_dir=$(mktemp -d)
  for index in "${!COMPONENTS[@]}"; do
    (
      trap "printf '%s' \"\$?\" >'$status_dir/$index'" EXIT
      # Concurrent CLI processes can replace each other's TUF metadata
      # during initialization, so every worker has its own cache.
      export XDG_CACHE_HOME="$status_dir/$index-cache"
      "$worker" "$index"
    ) 2>&1 | sed "s|^|[${COMPONENTS[$index]}] |" &
    pids+=("$!")
  done
  # `|| true` because the pipeline's status is sed's; the status files are
  # the real answer.
  for index in "${!pids[@]}"; do
    wait "${pids[$index]}" || true
  done
  for index in "${!COMPONENTS[@]}"; do
    if [[ "$(cat "$status_dir/$index" 2>/dev/null)" != 0 ]]; then
      echo "::error::$failure for ${COMPONENTS[$index]}"
      failed=1
    fi
  done
  rm -rf "$status_dir"
  return "$failed"
}

case "${1:-}" in
  verify)
    each_component "reused snapshot verification failed" verify_one
    for index in "${!COMPONENTS[@]}"; do
      load "$index"
      {
        echo "component_$index=$COMPONENT"
        echo "image_$index=$IMAGE_NAME"
        echo "digest_$index=$DIGEST"
        echo "sbom_$index=$EVIDENCE_DIR/$COMPONENT.spdx.json"
        echo "provenance_$index=$WORK_DIR/$COMPONENT.provenance.json"
      } >>"$GITHUB_OUTPUT"
    done
    ;;
  publish)
    each_component "tagging or verifying the reused snapshot failed" publish_one
    ;;
  *)
    echo "usage: reuse-snapshots.sh verify|publish" >&2
    exit 2
    ;;
esac
