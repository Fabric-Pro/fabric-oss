/**
 * Short Post / Tweet — start one generation run, and save the chosen option
 * (Publishing Suite Phase 2B-2, Fizzy #1853).
 *
 * Both writes; the read side is `listTopicDrafts`, polled while a run is in
 * flight. Scoped exactly like `generatePlanningAnalysis`: neither procedure
 * trusts a topic id alone. The DB helpers re-scope to `{ topicId, projectId }`
 * inside the Project-row lock, so a real topic id belonging to another project
 * produces the answer a missing one produces and cannot be used to probe for
 * topics in projects the caller cannot see (DV16).
 */

import { ORPCError } from "@orpc/client";
import {
	failTopicDraft,
	listTopicDrafts,
	logDraftRefusal,
	saveWorkingDraft,
	startTopicDraftAttempt,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Bound on the per-run guidance (FR12).
 *
 * Enforced here AND again where it is composed into the prompt. Both, because a
 * bound that exists only at the edge stops guarding the moment a second caller
 * appears — and because these two protect different things: this one protects
 * the column and the audit trail, the other protects the model's context window
 * from a value written before the bound existed.
 */
const GUIDANCE_MAX = 2000;

export const generateShortPostProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/short-post",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate short post options for a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			guidance: z.string().max(GUIDANCE_MAX).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// Security ratchet, identical to `generatePlanningAnalysis`: the
		// permission middleware proved the caller is authorized for THIS project,
		// but it never inspects the org. The tenant is derived from the loaded
		// Project row, and `input.organizationId` is a guard only — never a
		// scoping key.
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		// Temporal is checked BEFORE the row is created. Creating it first and
		// discovering the outage second would leave a GENERATING row holding the
		// partial unique index, so the button would go on refusing for ten
		// minutes over an outage that may already be over.
		const { isTemporalAvailable } = await import("@repo/temporal");
		if (!(await isTemporalAvailable())) {
			return { started: false as const, reason: "unavailable" as const };
		}

		// Empty guidance is stored as null, not "". The column's meaning is "what
		// the user asked for on this run", and an empty string would render as a
		// guidance section containing nothing — which reads to the model as an
		// instruction it failed to understand rather than as no instruction.
		const guidance = input.guidance?.trim() ? input.guidance.trim() : null;

		const attempt = await startTopicDraftAttempt({
			topicId: input.topicId,
			projectId: project.id,
			postType: "TWEET",
			requestedById: context.user.id,
			guidance,
		});
		// Two causes, two messages. The helper re-checks the project under its own
		// lock, so it can find the project archived between the ratchet above and
		// the transaction — reporting that as "Topic not found" would send a
		// reader looking for a topic that is perfectly fine.
		if (attempt.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (attempt.status === "not_found") {
			throw new ORPCError("NOT_FOUND", { message: "Topic not found" });
		}
		if (attempt.status === "in_flight") {
			// A double-click, or a poll that raced the first click. The row the UI
			// is about to poll already exists and a run is filling it.
			return { started: false as const, reason: "in-progress" as const };
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		try {
			await client.workflow.start("generatePublishingShortPostWorkflow", {
				taskQueue: "fabric-worker",
				// Keyed on the ATTEMPT, not the topic: each attempt is a distinct
				// row with its own terminal state, and reusing a topic-keyed id
				// would make a second run collide with a finished one's history.
				workflowId: `publishing-topic-sp:${attempt.draftId}`,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				// Backstop for a run that never finds a worker at all: without it
				// the row would sit GENERATING until the deadline sweep, which is
				// the same ten minutes but with nothing recorded about why.
				workflowExecutionTimeout: "10m",
				args: [
					{
						draftId: attempt.draftId,
						topicId: input.topicId,
						projectId: project.id,
						organizationId: project.organizationId ?? null,
						actorUserId: context.user.id,
						guidance,
					},
				],
			});
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "WorkflowExecutionAlreadyStartedError"
			) {
				return {
					started: false as const,
					reason: "in-progress" as const,
				};
			}

			// Roll the row back, or the UI polls a GENERATING row no workflow will
			// ever complete — and the partial unique index refuses every retry
			// until the deadline sweep clears it.
			// The rollback can itself be refused, and silently dropping that is
			// how a row ends up GENERATING with nothing recorded about why: the
			// caller gets a 500, the panel keeps polling, and the deadline sweep
			// is the only thing that ever clears it. Reported, not retried —
			// every refusal reason means this attempt is no longer ours to write.
			const rollback = await failTopicDraft({
				id: attempt.draftId,
				projectId: project.id,
				error:
					error instanceof Error
						? `Could not start generation: ${error.message}`
						: "Could not start generation",
			});
			if (!rollback.persisted) {
				logDraftRefusal(
					"[publishing-short-post] start rollback skipped",
					rollback.reason,
					{ draftId: attempt.draftId, projectId: project.id },
				);
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the short post",
			});
		}

		return {
			started: true as const,
			draftId: attempt.draftId,
			version: attempt.version,
		};
	});

/**
 * Adopt one generated option as the topic's working short post (FR19/FR20).
 *
 * The option's TEXT is not taken from the request. The client sends which
 * candidate and which label; the server reads the option out of that draft's own
 * stored `content` and saves what it finds. Accepting the body from the client
 * would make this endpoint a way to write arbitrary text into a project's
 * published-content pipeline under the guise of "selecting" a generated option —
 * and the stored draft would then no longer be evidence of what the model
 * actually produced.
 *
 * Editing a working draft is a different operation, and it is 2B-3's, where an
 * editor exists to make the edit visible and attributable.
 */
export const selectShortPostOptionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/short-post/select",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save a generated short post option as the working draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			draftId: z.string(),
			optionLabel: z.string().min(1).max(80),
			/**
			 * The working draft's `updatedAt` as the client last saw it, or null
			 * for "nothing is saved". Optimistic concurrency: two people choosing
			 * different options seconds apart both used to succeed, with the
			 * second silently erasing the first.
			 *
			 * `updatedAt` rather than `sourceDraftId`: an edit that changes the
			 * BODY leaves the source id alone, so a source-based check would pass
			 * while the row had changed. Nothing edits a body until 2B-3, which
			 * is precisely why it is worth getting right now.
			 *
			 * Optional on the wire so an older client still works; absent means
			 * "do not check", which is the pre-existing behaviour rather than a
			 * new hole. The clients in this repo always send it.
			 */
			expectedUpdatedAt: z.coerce.date().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		// Read the candidate through the SAME scoped helper the page reads, so
		// this endpoint cannot see a draft the page could not.
		const { drafts, workingDrafts } = await listTopicDrafts({
			topicId: input.topicId,
			projectId: project.id,
		});
		const tweet = drafts.find((d) => d.postType === "TWEET");
		const candidate =
			tweet?.latestReady?.id === input.draftId ? tweet.latestReady : null;
		if (!candidate) {
			// Deliberately the same answer for "no such draft" and "that draft is
			// not the current one": a caller who guessed an id learns nothing
			// about whether it exists, and a stale tab learns it needs to refresh
			// either way.
			throw new ORPCError("NOT_FOUND", {
				message: "Draft option not found",
			});
		}

		const lookup = findOption(candidate.content, input.optionLabel);
		if (lookup.status === "ambiguous") {
			// Not CONFLICT: the client treats that as "someone else saved first,
			// refresh and retry", and retrying this resolves to the same
			// unanswerable document every time.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"This draft has more than one option under that label, so the selection is ambiguous. Regenerate the short post.",
			});
		}
		if (lookup.status === "missing") {
			throw new ORPCError("NOT_FOUND", {
				message: "Draft option not found",
			});
		}
		const option = lookup.option;

		const saved = await saveWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			postType: "TWEET",
			sourceDraftId: input.draftId,
			sourceOptionLabel: option.label,
			body: option.text,
			updatedById: context.user.id,
			// `undefined` means the caller did not express an expectation, so
			// the helper is handed what is already there and the check passes.
			// Reading the CURRENT value for that is not a race: the helper does
			// its own read inside the project lock, and this one only decides
			// whether to opt in at all.
			expectedUpdatedAt:
				input.expectedUpdatedAt === undefined
					? (workingDrafts.find((w) => w.postType === "TWEET")
							?.updatedAt ?? null)
					: input.expectedUpdatedAt,
		});

		if (saved.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (saved.status === "stale") {
			// Someone else selected a different option while this caller was
			// deciding. A conflict rather than a failure: nothing is wrong, the
			// caller is simply acting on a view that has moved.
			throw new ORPCError("CONFLICT", {
				message:
					"The saved short post changed while you were choosing. Refresh and try again.",
			});
		}
		if (saved.status === "source_not_found") {
			// The draft was read a moment ago, so reaching here means it was
			// superseded or deleted in between. A conflict, not a 500.
			throw new ORPCError("CONFLICT", {
				message:
					"That draft is no longer available. Refresh and try again.",
			});
		}

		return { saved: true as const, updatedAt: saved.updatedAt };
	});

/**
 * The result of resolving a label against a stored short post document.
 *
 * `ambiguous` is separated from `missing` because the two need opposite
 * answers. A missing option is a stale tab and refreshing fixes it; an ambiguous
 * one means the stored document cannot answer the question at all, and the ONE
 * thing that must not happen is quietly picking a winner — that publishes text
 * the reader did not choose.
 */
type OptionLookup =
	| { status: "ok"; option: { label: string; text: string } }
	| { status: "missing" }
	| { status: "ambiguous" };

/**
 * Find one option inside a stored short post document.
 *
 * Defensive about the shape rather than trusting it: `content` is `Json?` in the
 * schema, so a row written by an older code path — or by a future one — is not
 * guaranteed to match today's document. Returning a status makes that an error
 * the client can act on instead of a `TypeError` in a handler.
 *
 * The duplicate-label check is belt-and-braces rather than a live path:
 * `PublishingShortPostSchema` refuses to persist a run whose labels collide, so
 * nothing this code writes can reach it. It is here because `content` is a JSON
 * column and this function already declines to trust any other part of its
 * shape — and because the failure it prevents, adopting a different option's
 * text than the one the reader picked, is silent everywhere else.
 */
function findOption(content: unknown, label: string): OptionLookup {
	if (content == null || typeof content !== "object") {
		return { status: "missing" };
	}
	const options = (content as { options?: unknown }).options;
	if (!Array.isArray(options)) {
		return { status: "missing" };
	}
	let found: { label: string; text: string } | null = null;
	for (const raw of options) {
		if (raw == null || typeof raw !== "object") {
			continue;
		}
		const candidate = raw as { label?: unknown; text?: unknown };
		if (
			typeof candidate.label === "string" &&
			typeof candidate.text === "string" &&
			candidate.label === label &&
			candidate.text.trim().length > 0
		) {
			if (found) {
				return { status: "ambiguous" };
			}
			found = { label: candidate.label, text: candidate.text };
		}
	}
	return found ? { status: "ok", option: found } : { status: "missing" };
}
