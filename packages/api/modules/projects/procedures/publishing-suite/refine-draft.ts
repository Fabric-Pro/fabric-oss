/**
 * Working-draft refinement — start one, accept the result, or reject it
 * (Fizzy #1851 follow-up).
 *
 * ONE set of procedures for all seven content types, where generation needs
 * seven. `postType` is an input here rather than baked into the path, because a
 * refinement does not vary by content type: it revises a Markdown body to an
 * instruction, and every working draft body is Markdown.
 *
 * ## What changed, and why these are new endpoints rather than a flag
 *
 * Refining used to be `refineFromWorkingDraft: true` on the seven generate
 * procedures, which ran the ordinary generation path. That inherited the
 * generation CONTRACT by accident — for Short Post and LinkedIn,
 * `PublishingShortPostSchema.options` is `.length(3)` and the locked clauses
 * require the three to be DISTINCT, so "remove the last line" returned three
 * rewrites, at least two of which had to change something nobody asked for. It
 * also wrote a `PublishingTopicDraft` row, consuming a version number and
 * putting a punctuation fix in the candidates grid beside real generations.
 *
 * A refinement is now a PROPOSAL held on the working draft. One result, no
 * version number, nothing in the grid — and `refinedFromWorkingDraft` stops
 * being a flag every reader has to interpret correctly, because there is no
 * candidate row to interpret.
 *
 * Scoped exactly like the generate procedures: neither the topic id nor
 * `organizationId` is trusted. The tenant is derived from the loaded Project
 * row, and the DB helpers re-scope to `{ topicId, projectId }` inside the
 * Project-row lock, so a real topic id belonging to another project produces the
 * answer a missing one produces (DV16).
 */

import { ORPCError } from "@orpc/client";
import {
	acceptRefinement,
	rejectRefinement,
	startRefinement,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { recordEditedWorkingDraft } from "../../lib/publishing-outcome";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Bound on the revision instruction.
 *
 * The same 2,000 characters the generate procedures bound `guidance` to, and for
 * the same paired reason: this bound protects the column and the audit trail,
 * and `buildRefinementSection` bounds again where the value reaches the prompt.
 * A guard that exists only at the edge stops guarding the moment a second caller
 * appears.
 */
const INSTRUCTION_MAX = 2000;

/**
 * Every content type a working draft can exist for.
 *
 * Spelled out rather than imported as the Prisma enum, following the shape the
 * rest of this module uses for wire input: the API's accepted values are a
 * contract with the client, and a schema that widened automatically whenever a
 * database enum gained a value would accept a post type before any panel or
 * prompt existed for it.
 */
const PostTypeSchema = z.enum([
	"TWEET",
	"LINKEDIN_POST",
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
	"WEBINAR_SCRIPT",
	"NEWSLETTER_BLURB",
]);

/**
 * `publishingSuite.refineDraft` — start a refinement run.
 *
 * The body being revised is NOT taken from the request. `startRefinement` reads
 * it from the server's own store inside the transaction that claims the slot,
 * and hands it back. That is a security rule and a correctness one at once:
 *
 *   - Security: a generation prompt is the one place in this feature where
 *     arbitrary caller text becomes the model's instruction set. An endpoint
 *     accepting a body would let any project member put text of their choosing
 *     into a run attributed to the organization's key and quota.
 *   - Correctness: the text stored as the proposal's baseline and the text the
 *     prompt receives are the same string by construction. The path this
 *     replaces read the body in one query and opened the attempt in another, so
 *     an edit landing between them produced a run that revised one version while
 *     recording another.
 */
export const refineDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/refine",
		tags: ["Projects", "Publishing Suite"],
		summary: "Refine the saved working draft for one content type",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			postType: PostTypeSchema,
			/** What to change. Bounded, and stored verbatim as the audit trail. */
			instruction: z.string().max(INSTRUCTION_MAX).nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// Security ratchet: the permission middleware proved the caller is
		// authorized for THIS project but never inspects the org. The tenant
		// comes from the loaded Project row; `input.organizationId` is a guard
		// only, never a scoping key.
		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		// Temporal is checked BEFORE the slot is claimed. Claiming first and
		// discovering the outage second would leave a GENERATING proposal that
		// no workflow will ever finish — recoverable here after its deadline,
		// but only after a ten-minute wait over an outage that may already be
		// over.
		const { isTemporalAvailable } = await import("@repo/temporal");
		if (!(await isTemporalAvailable())) {
			return { started: false as const, reason: "unavailable" as const };
		}

		// Empty instruction is stored as null, not "". The column means "what
		// the user asked for on this run", and an empty string renders as an
		// instruction section containing nothing — which reads to the model as
		// an instruction it failed to understand rather than as no instruction.
		const instruction = input.instruction?.trim()
			? input.instruction.trim()
			: null;

		const claim = await startRefinement({
			topicId: input.topicId,
			projectId: project.id,
			postType: input.postType,
			instruction,
			requestedById: context.user.id,
		});

		// Two causes, two messages. The helper re-checks the project under its
		// own lock, so it can find the project archived between the ratchet
		// above and the transaction — reporting that as "nothing to refine"
		// would send a reader looking for a draft that is perfectly fine.
		if (claim.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (claim.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved draft to refine.",
			});
		}
		if (claim.status === "in_flight") {
			return { started: false as const, reason: "in-progress" as const };
		}

		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();

		try {
			await client.workflow.start("refinePublishingDraftWorkflow", {
				taskQueue: "fabric-worker",
				// Keyed on the RUN, not the topic: each claim mints a fresh id,
				// so a refinement started after a reclaim cannot collide with a
				// finished one's history.
				workflowId: `publishing-refine:${claim.runId}`,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				// Backstop for a run that never finds a worker at all: without
				// it the proposal would sit GENERATING until its own deadline,
				// with nothing recorded about why.
				workflowExecutionTimeout: "10m",
				args: [
					{
						runId: claim.runId,
						topicId: input.topicId,
						projectId: project.id,
						postType: input.postType,
						organizationId: project.organizationId ?? null,
						actorUserId: context.user.id,
						currentDraft: claim.baseline,
						instruction,
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

			// Release the slot, or the panel polls a GENERATING proposal no
			// workflow will ever complete and the button refuses until the
			// deadline passes. `rejectRefinement` is the release: it clears the
			// proposal columns and leaves the body untouched.
			await rejectRefinement({
				topicId: input.topicId,
				projectId: project.id,
				postType: input.postType,
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the refinement",
			});
		}

		return { started: true as const, runId: claim.runId };
	});

/**
 * `publishingSuite.acceptRefinement` — adopt the proposal as the working draft.
 *
 * The proposed TEXT is not taken from the request. The client says which content
 * type; the server reads the proposal out of the working draft row and saves
 * what it finds — the same rule `selectShortPostOption` and `adoptBlogPostDraft`
 * follow, and for the same reason: an endpoint that accepted a body would make
 * "accept" a way to write arbitrary text into a project's published-content
 * pipeline, and the stored proposal would stop being evidence of what the model
 * actually produced.
 *
 * The write goes through `acceptRefinement`, which appends a
 * `PublishingTopicDraftRevision` in the SAME transaction. Writing `body`
 * directly would bypass the revision history and reopen the exact gap the
 * draft-revision slice just closed.
 */
export const acceptRefinementProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/refine/accept",
		tags: ["Projects", "Publishing Suite"],
		summary: "Accept a refinement proposal as the working draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			postType: PostTypeSchema,
			/**
			 * The working draft's `updatedAt` as the client last saw it.
			 *
			 * REQUIRED, unlike `selectShortPostOption`'s optional one. That
			 * endpoint kept it optional so an older client still worked; this is
			 * a new endpoint with no older client, and accepting replaces a body
			 * outright — so there is no version of this call that should be
			 * allowed to skip the check.
			 */
			expectedUpdatedAt: z.coerce.date(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		const accepted = await acceptRefinement({
			topicId: input.topicId,
			projectId: project.id,
			postType: input.postType,
			acceptedById: context.user.id,
			expectedUpdatedAt: input.expectedUpdatedAt,
		});

		if (accepted.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (accepted.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved draft for that content type",
			});
		}
		if (accepted.status === "no_proposal") {
			// Not CONFLICT: there is nothing to retry against. The proposal was
			// accepted, rejected or superseded, and the panel needs to refetch
			// rather than offer the button again.
			throw new ORPCError("NOT_FOUND", {
				message: "There is no refinement to accept.",
			});
		}
		if (accepted.status === "baseline_changed") {
			// DISTINCT from `stale`, and the client message has to differ. This
			// one means the proposal revises text that is no longer saved, so
			// refreshing changes nothing — the refinement has to be run again.
			throw new ORPCError("CONFLICT", {
				message:
					"The draft changed since this refinement was computed, so accepting it would discard that change. Refine again.",
			});
		}
		if (accepted.status === "stale") {
			throw new ORPCError("CONFLICT", {
				message:
					"The saved draft changed while you were reviewing. Refresh and try again.",
			});
		}

		// Measurement only (Fizzy #1851 A9). An accepted refinement is the
		// adopted candidate's verdict downgraded from "as is" to "with edits":
		// the published text is no longer what the model first produced, and
		// the helper swallows its own failures so nothing here can turn a
		// completed accept into an error.
		await recordEditedWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			organizationId: project.organizationId,
			postType: input.postType,
			userId: context.user.id,
		});

		return {
			saved: true as const,
			updatedAt: accepted.updatedAt,
			version: accepted.version,
		};
	});

/**
 * `publishingSuite.rejectRefinement` — discard the proposal.
 *
 * Accepts a proposal in ANY state, including one still running and one that
 * failed: a failed proposal needs a way to be dismissed or its error sits on the
 * panel forever, and cancelling a run in flight is safe because
 * `completeRefinement` compare-and-sets on the run id, so the cancelled run's
 * eventual write matches nothing.
 *
 * No `expectedUpdatedAt`. Rejection destroys nothing — the body is untouched and
 * the proposal is reproducible by running it again — so a conflict check would
 * be protecting nothing.
 */
export const rejectRefinementProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/refine/reject",
		tags: ["Projects", "Publishing Suite"],
		summary: "Discard a refinement proposal",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			postType: PostTypeSchema,
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		const rejected = await rejectRefinement({
			topicId: input.topicId,
			projectId: project.id,
			postType: input.postType,
		});

		if (rejected.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (rejected.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved draft for that content type",
			});
		}

		// `no_proposal` is NOT an error. Rejecting nothing leaves the caller in
		// exactly the state they asked for, and a double-click or a stale tab
		// must not be told it failed.
		return { rejected: true as const };
	});
