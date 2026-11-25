export const REQUIRED_CHECK_NAME = "replay-validation";

// The changes job uses this decision before selecting a runner or accessing
// the history cache. Keep it in sync with temporal-replay-pr-check.yml.
export const REPLAY_ELIGIBILITY_EXPRESSION = `
github.event_name == 'pull_request' &&
github.event.pull_request.head.repo.full_name == github.repository &&
github.repository == 'Fabric-Pro/fabric-dev'
`.trim();

const PUBLIC_REPOSITORY = "Fabric-Pro/fabric-oss";

export function evaluateCredentialFreeOutcome({
	eventName,
	changesResult,
	workflowsChanged,
	repository,
	headRepository,
	pullRequestAuthor,
	headRef,
}) {
	if (eventName !== "pull_request") {
		return { run: false, reason: "unsupported_event" };
	}
	if (changesResult !== "success") {
		return { run: false, reason: "change_detection_failed" };
	}
	if (typeof workflowsChanged !== "boolean") {
		return { run: false, reason: "invalid_change_detection_output" };
	}
	if (!workflowsChanged) {
		return { run: false, reason: "no_workflow_changes" };
	}

	const sameRepository = headRepository === repository;
	if (sameRepository && repository === "Fabric-Pro/fabric-dev") {
		return { run: true, reason: "private_same_repository_pr" };
	}
	if (sameRepository && repository === "Fabric-Pro/fabric") {
		return { run: false, reason: "ops_repository_replay_not_applicable" };
	}
	if (repository !== PUBLIC_REPOSITORY) {
		return { run: false, reason: "replay_not_authorized" };
	}
	if (sameRepository && pullRequestAuthor === "fabric-relay[bot]") {
		return {
			run: false,
			reason: headRef?.startsWith("relay/")
				? "authenticated_public_relay_pr"
				: "public_pr_outside_relay_namespace",
		};
	}

	return { run: false, reason: "public_credential_free_not_applicable" };
}
