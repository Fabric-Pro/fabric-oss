/**
 * The point-of-use authorization re-check shared by every Publishing Suite
 * generation activity (Fizzy #1854 follow-up).
 *
 * ## What it replaced, and why that was wrong
 *
 * Each of the five activities carried its own copy of:
 *
 *     if (organizationId != null && !(await isCurrentOrgMember(actor, org)))
 *         throw ... "AI actor is no longer an org member"
 *
 * That asks whether the actor is in an organization. The API gate that
 * authorized the run asked whether the actor has `PUBLISHING_TOPIC_UPDATE` on
 * the PROJECT, and its precedence is owner -> active ProjectMember -> org role.
 * Org membership is the last of the three. So the re-check refused a class of
 * actor the gate had just admitted: a project-scoped guest with an EDITOR row.
 * Their run got a `GENERATING` draft row and then failed, deterministically,
 * with a sentence that was untrue about them.
 *
 * A re-check that asks a different question than the gate is not a second
 * opinion — it is a second policy, and the two will disagree by construction.
 *
 * ## Why the re-check is still worth doing
 *
 * Everything a generation run touches is downstream of a decision made when the
 * run was QUEUED: the topic's documents, transcripts, pull requests and
 * decisions are collected, an organization-bound prompt is resolved, and a model
 * call is billed. The gap between queueing and running is a model call wide.
 * Re-asking the gate's question at the point of use is what stops a revoked
 * collaborator from spending an organization's credits on its material.
 *
 * ## The order matters more than the check
 *
 * This runs BEFORE anything resolves a model or collects a source. A guard that
 * fires after the model call has already been paid for is a log line, not a
 * guard, so every call site puts it above the `Promise.all` — and a test asserts
 * `getAIModelWithMetadata` was never reached on refusal.
 */

import { checkPublishingGenerationActor } from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/common";

export interface AssertGenerationActorInput {
	projectId: string;
	/** The organization the run was authorized under, from the workflow input. */
	organizationId: string | null;
	/** Who pressed the button — the identity the model is resolved under. */
	actorUserId: string;
	/**
	 * Which activity is asking, for the operator log. The ACTIVITY's own name
	 * rather than a content type, so the line greps against the code and cannot
	 * be mistaken for the `PublishingTopicPostType` enum — the short-post
	 * activity's post type is `TWEET`, and an operator filtering on that would
	 * quietly miss it. Not used in the decision: all five gate on the same
	 * permission, and a type needing a different one would need a different
	 * function, not a different string.
	 */
	activity: string;
}

/**
 * Throws non-retryably unless the actor may still generate on this project.
 *
 * Two distinct failure types, kept distinct because they are two different
 * events: `PUBLISHING_TENANT_MISMATCH` says the project is not the one this run
 * was authorized against, `PUBLISHING_ACTOR_INVALID` says the person is not.
 * Both codes predate this function and keep their meanings.
 */
export async function assertGenerationActorAuthorized(
	input: AssertGenerationActorInput,
): Promise<void> {
	const check = await checkPublishingGenerationActor({
		projectId: input.projectId,
		organizationId: input.organizationId,
		actorUserId: input.actorUserId,
	});
	if (check.ok) {
		return;
	}

	// Log before the throw, and log the REASON. The only production signal for a
	// refusal used to be the workflow's generic "generation failed" line, which
	// carries no error type — so a revoked actor and a provider timeout were
	// indistinguishable in the logs. A guard nobody can observe firing is a
	// guard nobody can trust. Shape borrowed from the newsletter's sibling guard
	// (`curate-newsletter-from-releases.ts`) so both are greppable together.
	logger.warn("[Publishing] Refusing generation: actor re-check failed", {
		reason: check.reason,
		activity: input.activity,
		projectId: input.projectId,
		organizationId: input.organizationId,
		currentOrganizationId: check.currentOrganizationId,
		actorUserId: input.actorUserId,
	});

	// Third person, both of them, on purpose. These strings are stored on the
	// FAILED draft row and the panel renders them verbatim to ANYONE who can see
	// the tab — not only to whoever pressed the button. "You no longer have
	// permission" is then false for most of its readers.
	if (check.reason === "TENANT_MISMATCH") {
		throw ApplicationFailure.nonRetryable(
			"This project moved to a different organization after the draft was started",
			"PUBLISHING_TENANT_MISMATCH",
		);
	}

	throw ApplicationFailure.nonRetryable(
		"The account that started this draft is no longer authorized to generate on this project",
		"PUBLISHING_ACTOR_INVALID",
	);
}
