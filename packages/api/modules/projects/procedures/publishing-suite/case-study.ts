/**
 * Case Study — start one generation run, adopt a generated version, and save an
 * edit (Publishing Suite Phase 2C, Fizzy #1854).
 *
 * The same three-endpoint shape as the Blog Post, and for the same reason: a
 * case study generation seeds the working draft on the FIRST run inside the
 * activity, so this module owns what happens afterwards — adopting a later
 * version over saved work, and editing the text. Both must be compare-and-set,
 * because both can be racing the other.
 *
 * All three are writes; the read side is `listTopicDrafts`, polled while a run
 * is in flight. No procedure trusts a topic id alone: the DB helpers re-scope to
 * `{ topicId, projectId }` inside the Project-row lock, so a real topic id
 * belonging to another project produces the answer a missing one produces and
 * cannot be used to probe for topics in projects the caller cannot see.
 */

import { ORPCError } from "@orpc/client";
import {
	failTopicDraft,
	listTopicDrafts,
	saveWorkingDraft,
	startTopicDraftAttempt,
	updateWorkingDraftBody,
} from "@repo/database";
import { composeCaseStudyWorkingDraftBody } from "@repo/utils/publishing-case-study-body";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Bound on the per-run guidance.
 *
 * Enforced here AND again where it is composed into the prompt. Both, because a
 * bound that exists only at the edge stops guarding the moment a second caller
 * appears — and because these two protect different things: this one protects
 * the column and the audit trail, the other protects the model's context window
 * from a value written before the bound existed.
 */
const GUIDANCE_MAX = 2000;

/**
 * Bound on an edited body.
 *
 * Matches the generated document's own cap on body text, so a person cannot
 * save a draft the generator would have been refused for producing. Generous:
 * a case study is long-form, and the cap exists to stop an unbounded write
 * reaching a `@db.Text` column, not to impose a house style.
 */
const BODY_MAX = 40000;

export const generateCaseStudyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/case-study",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate a case study draft for a topic",
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

		// Security ratchet: the permission middleware proved the caller is
		// authorized for THIS project, but it never inspects the org. The tenant
		// is derived from the loaded Project row, and `input.organizationId` is
		// a guard only — never a scoping key.
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
			postType: "CASE_STUDY",
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
			// `withCorrelationMemo` propagates the request's correlation id into
			// the workflow memo so a case study run can be traced end to end.
			await client.workflow.start(
				"generatePublishingCaseStudyWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					// Keyed on the ATTEMPT, not the topic: each attempt is a
					// distinct row with its own terminal state, and reusing a
					// topic-keyed id would make a second run collide with a
					// finished one's history. The `-cs:` prefix keeps this family
					// distinguishable from `-bp:` and `-sp:` in Temporal's UI.
					workflowId: `publishing-topic-cs:${attempt.draftId}`,
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
					workflowIdConflictPolicy: "FAIL",
					// Backstop for a run that never finds a worker at all:
					// without it the row would sit GENERATING until the deadline
					// sweep, which is the same ten minutes but with nothing
					// recorded about why.
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
				}),
			);
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
			await failTopicDraft({
				id: attempt.draftId,
				projectId: project.id,
				error:
					error instanceof Error
						? `Could not start generation: ${error.message}`
						: "Could not start generation",
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the case study",
			});
		}

		return {
			started: true as const,
			draftId: attempt.draftId,
			version: attempt.version,
		};
	});

/**
 * Adopt a generated case study version as the topic's working draft.
 *
 * Takes no option label — a case study generation produces one draft rather
 * than a labeled set. Like its siblings it does NOT accept the text: the client
 * names a candidate, and the server reads the body out of that draft's own
 * stored `content`. Accepting a body would make this endpoint a way to write
 * arbitrary text into a project's published-content pipeline under the guise of
 * "adopting" a generated version — and the stored draft would then no longer be
 * evidence of what the model actually produced. Editing is `saveCaseStudyBody`,
 * which is explicit about being an edit and records who made it.
 *
 * Reaching this at all means a working draft already exists, because the FIRST
 * generation seeded one. That is the whole reason the compare-and-set matters
 * here: adopting version 4 over a body someone has been editing is exactly the
 * silent overwrite the working draft's `updatedAt` guard exists to prevent.
 */
export const adoptCaseStudyDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/case-study/adopt",
		tags: ["Projects", "Publishing Suite"],
		summary: "Adopt a generated case study version as the working draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			draftId: z.string(),
			/**
			 * The working draft's `updatedAt` as the client last saw it, or null
			 * for "nothing is saved". Optimistic concurrency: this endpoint ships
			 * alongside the editor that makes a concurrent body change possible,
			 * so there is no older client whose absent expectation has to keep
			 * working.
			 */
			expectedUpdatedAt: z.coerce.date().nullable(),
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
		const { drafts } = await listTopicDrafts({
			topicId: input.topicId,
			projectId: project.id,
		});
		const caseStudy = drafts.find((d) => d.postType === "CASE_STUDY");
		const candidate =
			caseStudy?.latestReady?.id === input.draftId
				? caseStudy.latestReady
				: null;
		if (!candidate) {
			// Deliberately the same answer for "no such draft" and "that draft is
			// not the current one": a caller who guessed an id learns nothing
			// about whether it exists, and a stale tab learns it needs to refresh
			// either way.
			throw new ORPCError("NOT_FOUND", { message: "Draft not found" });
		}

		const document = readCaseStudyDocument(candidate.content);
		if (document === null) {
			// The stored document is not one this code can read — an older
			// content shape, or a row written by a future one. A 500 rather than
			// a NOT_FOUND: the draft is right there and the failure is ours.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"This draft could not be read as a case study. Regenerate it.",
			});
		}

		const saved = await saveWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			postType: "CASE_STUDY",
			sourceDraftId: input.draftId,
			// No option to name: a case study generation produces one draft
			// rather than a labeled set.
			sourceOptionLabel: null,
			// The SHARED composer, not a copy of it — `@repo/temporal` seeds the
			// working draft with this exact function (`generate-case-study.ts`),
			// so the adopted text cannot drift from the seeded text.
			//
			// The Blog Post sibling still duplicates its composer into this
			// layer as `readBlogBody`, and for two releases the comment
			// justifying that claimed a parity test which did not exist: the
			// two copies agreed only by coincidence between hardcoded literals.
			// #1854 backfilled it — `__tests__/blog-post.test.ts` now imports
			// `composeWorkingDraftBody` from the activity and asserts the
			// adopted body equals it — and corrected the sibling's comment. So
			// the duplication is now pinned rather than merely asserted; not
			// duplicating remains the better shape, which is why this family
			// shares one function from `@repo/utils` instead.
			body: composeCaseStudyWorkingDraftBody(document),
			updatedById: context.user.id,
			expectedUpdatedAt: input.expectedUpdatedAt,
		});

		if (saved.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (saved.status === "stale") {
			// Someone edited or adopted while this caller was reading. A conflict
			// rather than a failure: nothing is wrong, the caller is simply
			// acting on a view that has moved.
			throw new ORPCError("CONFLICT", {
				message:
					"The saved case study changed while you were reading. Refresh and try again.",
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
 * Save an edit to the topic's working case study.
 *
 * The one endpoint in this family that DOES take body text from the client, and
 * it is safe for the reason the others are not: it is an edit. There is no
 * generated artefact whose evidentiary value it could undermine — the draft rows
 * keep saying exactly what the model produced, and `sourceDraftId` keeps naming
 * the version this text began as. What changes is the body the project owns,
 * which is what a person editing their own draft is entitled to change.
 *
 * `expectedUpdatedAt` is required rather than nullable: an edit necessarily has
 * something to edit, so "I believe nothing is saved" is not a coherent claim
 * here, and accepting it would mean accepting an unconditional write.
 */
export const saveCaseStudyBodyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/case-study/body",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save an edit to the working case study draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			body: z.string().min(1).max(BODY_MAX),
			expectedUpdatedAt: z.coerce.date(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		const project = await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId,
		});

		const saved = await updateWorkingDraftBody({
			topicId: input.topicId,
			projectId: project.id,
			postType: "CASE_STUDY",
			body: input.body,
			updatedById: context.user.id,
			expectedUpdatedAt: input.expectedUpdatedAt,
		});

		if (saved.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (saved.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved case study to edit",
			});
		}
		if (saved.status === "stale") {
			throw new ORPCError("CONFLICT", {
				message:
					"The saved case study changed while you were editing. Refresh and try again.",
			});
		}

		return { saved: true as const, updatedAt: saved.updatedAt };
	});

/**
 * Narrow a stored case study draft's `content` to the two fields the working
 * draft is composed from.
 *
 * Defensive about the shape rather than trusting it: `content` is `Json?` in the
 * schema, so a row written by an older code path — or by a future one — is not
 * guaranteed to match today's document. Returning null makes that an error the
 * caller can render instead of a `TypeError` in a handler.
 *
 * This narrows ONLY; it does not compose. The Markdown is built by
 * `composeCaseStudyWorkingDraftBody` in `@repo/utils`, the same function the
 * generation activity seeds the working draft with, so the adopted text and the
 * seeded text cannot diverge. That is the deliberate difference from
 * `readBlogBody` in `blog-post.ts`, which reimplements its sibling's composer
 * — a duplication #1854 pinned with the parity test its comment had claimed for
 * two releases, and which one shared function makes unnecessary here.
 */
function readCaseStudyDocument(
	content: unknown,
): { title: string; body: string } | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const doc = content as { title?: unknown; body?: unknown };
	if (typeof doc.title !== "string" || typeof doc.body !== "string") {
		return null;
	}
	const title = doc.title.trim();
	const body = doc.body.trim();
	if (!title || !body) {
		return null;
	}
	return { title, body };
}
