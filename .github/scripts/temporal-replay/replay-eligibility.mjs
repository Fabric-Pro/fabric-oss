const PRIVATE_REPLAY_REPOSITORIES = Object.freeze([
	"Fabric-Pro/fabric",
	"Fabric-Pro/fabric-dev",
]);
const PUBLIC_REPLAY_REPOSITORY = "Fabric-Pro/fabric-oss";
const RELAY_APP_LOGIN = "fabric-relay[bot]";
const RELAY_HEAD_PREFIX = "relay/";

// GitHub evaluates this before assigning the dev environment to the replay
// job. Keep it in sync with temporal-replay-validation.yml; the static test
// compares the normalized expressions so a policy change cannot update only
// the executable helper or only the secret-bearing job.
export const REPLAY_JOB_CONDITION = `
needs.initialize_status.result == 'success' &&
needs.authorize.result == 'success' &&
needs.authorize.outputs.secret_eligible == 'true' &&
(github.event_name == 'workflow_dispatch' ||
 needs.authorize.outputs.workflows == 'true')
`.trim();

export const REQUIRED_CHECK_NAME = "replay-validation";
export const DELEGATED_CHECK_NAME = "replay-validation-unprivileged";

// jobs.<job_id>.name may use both github and needs contexts. This expression
// makes the credential-free CheckRun distinct exactly when the trusted
// workflow must become the sole producer of the required context.
export const CREDENTIAL_FREE_JOB_NAME_EXPRESSION = `
needs.changes.result == 'success' &&
needs.changes.outputs.workflows == 'true' &&
github.event.pull_request.head.repo.full_name == github.repository &&
((github.repository == 'Fabric-Pro/fabric' ||
  github.repository == 'Fabric-Pro/fabric-dev') ||
 (github.repository == 'Fabric-Pro/fabric-oss' &&
  github.event.pull_request.user.login == 'fabric-relay[bot]' &&
  startsWith(github.event.pull_request.head.ref, 'relay/'))) &&
'replay-validation-unprivileged' || 'replay-validation'
`.trim();

// `authorize` performs change detection and metadata authorization in one
// trusted job, so a failure of either half arrives as one job result and the
// old separate `needs.authorize.result != 'success'` clause is subsumed by the
// first line of the disjunction.
export const TRUSTED_DENIAL_JOB_CONDITION = `
always() &&
github.event_name == 'pull_request_target' &&
(needs.authorize.result != 'success' ||
 (needs.authorize.outputs.workflows != 'true' &&
  needs.authorize.outputs.workflows != 'false') ||
 (needs.authorize.outputs.workflows == 'true' &&
  (((github.repository == 'Fabric-Pro/fabric' ||
     github.repository == 'Fabric-Pro/fabric-dev') &&
    needs.authorize.outputs.secret_eligible != 'true') ||
   (github.repository == 'Fabric-Pro/fabric-oss' &&
    needs.authorize.outputs.reason == 'public_pr_outside_relay_namespace'))))
`.trim();

/**
 * Describes whether an event may receive the private dev Temporal credentials.
 *
 * pull_request_target's pull_request.user.login is GitHub's authenticated PR
 * creator, not commit metadata. The relay namespace is an additional
 * repository-enforced boundary: its branch rules must continue to admit only
 * the Relay App. Neither string check replaces those GitHub controls.
 */
export function evaluateReplayEligibility({
	eventName,
	repository,
	headRepository,
	pullRequestAuthor,
	headRef,
}) {
	if (eventName === "workflow_dispatch") {
		return { eligible: true, reason: "trusted_manual_dispatch" };
	}

	if (eventName !== "pull_request_target") {
		return { eligible: false, reason: "unsupported_event" };
	}

	if (headRepository !== repository) {
		return { eligible: false, reason: "untrusted_head_repository" };
	}

	if (PRIVATE_REPLAY_REPOSITORIES.includes(repository)) {
		return { eligible: true, reason: "private_same_repository_pr" };
	}

	if (repository !== PUBLIC_REPLAY_REPOSITORY) {
		return { eligible: false, reason: "repository_not_allowlisted" };
	}

	if (pullRequestAuthor !== RELAY_APP_LOGIN) {
		return {
			eligible: false,
			reason: "public_pr_not_created_by_relay_app",
		};
	}

	if (typeof headRef !== "string" || !headRef.startsWith(RELAY_HEAD_PREFIX)) {
		return { eligible: false, reason: "public_pr_outside_relay_namespace" };
	}

	return { eligible: true, reason: "authenticated_public_relay_pr" };
}

export function shouldRunReplay(input) {
	const eligibility = evaluateReplayEligibility(input);
	if (!eligibility.eligible) {
		return { run: false, reason: eligibility.reason };
	}

	if (input.eventName === "workflow_dispatch") {
		return { run: true, reason: eligibility.reason };
	}

	if (!input.workflowsChanged) {
		return { run: false, reason: "no_workflow_changes" };
	}

	return { run: true, reason: eligibility.reason };
}

function pullRequestTargetEligibility(input) {
	return evaluateReplayEligibility({
		...input,
		eventName: "pull_request_target",
	});
}

/**
 * Selects the pull_request job name. Eligible workflow-changing PRs delegate
 * the required context to the trusted workflow, so their automatic CheckRun
 * must have a different name. Every other PR receives the stable required
 * CheckRun from this credential-free workflow.
 */
export function credentialFreeCheckName(input) {
	const eligibility = pullRequestTargetEligibility(input);
	return input.changesResult === "success" &&
		input.workflowsChanged === true &&
		eligibility.eligible
		? DELEGATED_CHECK_NAME
		: REQUIRED_CHECK_NAME;
}

/**
 * Evaluates the credential-free pull_request producer. It never authorizes
 * secret use; it either supplies the stable not-applicable check or delegates
 * that context to the trusted producer.
 */
export function evaluateCredentialFreeOutcome(input) {
	if (input.changesResult !== "success") {
		return { success: false, reason: "change_detection_failed" };
	}
	if (typeof input.workflowsChanged !== "boolean") {
		return { success: false, reason: "invalid_change_detection_output" };
	}
	if (!input.workflowsChanged) {
		return { success: true, reason: "no_workflow_changes" };
	}

	const eligibility = pullRequestTargetEligibility(input);
	if (eligibility.eligible) {
		return { success: true, reason: "delegated_to_trusted_replay" };
	}

	if (input.repository === PUBLIC_REPLAY_REPOSITORY) {
		if (eligibility.reason === "public_pr_outside_relay_namespace") {
			return { success: false, reason: eligibility.reason };
		}
		if (
			eligibility.reason === "untrusted_head_repository" ||
			eligibility.reason === "public_pr_not_created_by_relay_app"
		) {
			return {
				success: true,
				reason: "public_credential_free_not_applicable",
			};
		}
	}

	return { success: false, reason: "replay_not_authorized" };
}

/**
 * The trusted workflow deliberately pairs a failing legacy status with any
 * automatic CheckRun an untrusted private fork may forge. Ordinary OSS PRs
 * remain status-free on the trusted path.
 */
export function evaluateTrustedDenial(input) {
	if (input.changesResult !== "success") {
		return { publish: true, reason: "trusted_change_detection_failed" };
	}
	if (typeof input.workflowsChanged !== "boolean") {
		return { publish: true, reason: "invalid_change_detection_output" };
	}
	if (!input.workflowsChanged) {
		return { publish: false, reason: "no_workflow_changes" };
	}
	if (input.authorizationResult !== "success") {
		return { publish: true, reason: "trusted_authorization_failed" };
	}

	const eligibility = pullRequestTargetEligibility(input);
	if (
		PRIVATE_REPLAY_REPOSITORIES.includes(input.repository) &&
		!eligibility.eligible
	) {
		return { publish: true, reason: "private_replay_not_authorized" };
	}
	if (
		input.repository === PUBLIC_REPLAY_REPOSITORY &&
		eligibility.reason === "public_pr_outside_relay_namespace"
	) {
		return { publish: true, reason: eligibility.reason };
	}

	return { publish: false, reason: "trusted_denial_not_required" };
}

export function evaluateAggregateOutcome(input) {
	if (input.initialStatusResult !== "success") {
		return { success: false, reason: "status_initialization_failed" };
	}
	if (input.authorizationResult !== "success") {
		return { success: false, reason: "authorization_failed" };
	}
	if (input.changesResult !== "success") {
		return { success: false, reason: "change_detection_failed" };
	}
	if (
		input.eventName === "pull_request_target" &&
		typeof input.workflowsChanged !== "boolean"
	) {
		return { success: false, reason: "invalid_change_detection_output" };
	}

	if (input.eventName !== "workflow_dispatch" && !input.workflowsChanged) {
		return { success: true, reason: "no_workflow_changes" };
	}

	const eligibility = evaluateReplayEligibility(input);
	if (!eligibility.eligible) {
		if (input.replayResult !== "skipped") {
			return { success: false, reason: "ineligible_replay_executed" };
		}
		if (
			input.eventName === "pull_request_target" &&
			input.repository === PUBLIC_REPLAY_REPOSITORY &&
			(eligibility.reason === "untrusted_head_repository" ||
				eligibility.reason === "public_pr_not_created_by_relay_app")
		) {
			return {
				success: true,
				reason: "public_credential_free_not_applicable",
			};
		}

		return { success: false, reason: "replay_not_authorized" };
	}

	if (input.replayResult === "skipped") {
		return { success: false, reason: "eligible_replay_skipped" };
	}

	if (input.replayResult !== "success") {
		return { success: false, reason: "replay_failed" };
	}

	return { success: true, reason: "replay_passed" };
}
