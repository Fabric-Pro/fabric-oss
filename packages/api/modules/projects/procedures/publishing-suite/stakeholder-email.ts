/**
 * Stakeholder Email — start one generation run, adopt a generated version, and
 * save an edit (Publishing Suite Phase 2C, Fizzy #1854).
 *
 * The same three-endpoint shape as the Case Study and the Blog Post, and for the
 * same reason: a stakeholder email generation seeds the working draft on the
 * FIRST run inside the activity, so this module owns what happens afterwards —
 * adopting a later version over saved work, and editing the text. Both must be
 * compare-and-set, because both can be racing the other.
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
	logDraftRefusal,
	saveWorkingDraft,
	startTopicDraftAttempt,
	updateWorkingDraftBody,
} from "@repo/database";
import { composeStakeholderEmailWorkingDraftBody } from "@repo/utils/publishing-stakeholder-email-body";
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
 * The composed working draft is the subject line plus the email body, so this is
 * the generated document's own `body` cap (20,000) with room for the subject and
 * the two headings above it. Deliberately half the case study's: an email a
 * person will actually send is short, and a cap that would accept a novel is a
 * cap that stops meaning anything. It exists to keep an unbounded write off a
 * `@db.Text` column, not to impose a house style.
 */
const BODY_MAX = 24000;

export const generateStakeholderEmailProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/stakeholder-email",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate a stakeholder email draft for a topic",
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
			postType: "STAKEHOLDER_EMAIL",
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
			// the workflow memo so a stakeholder email run can be traced end to
			// end.
			await client.workflow.start(
				"generatePublishingStakeholderEmailWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					// Keyed on the ATTEMPT, not the topic: each attempt is a
					// distinct row with its own terminal state, and reusing a
					// topic-keyed id would make a second run collide with a
					// finished one's history. The `-se:` prefix keeps this family
					// distinguishable from `-bp:`, `-sp:` and `-cs:` in
					// Temporal's UI.
					workflowId: `publishing-topic-se:${attempt.draftId}`,
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
					"[publishing-stakeholder-email] start rollback skipped",
					rollback.reason,
					{ draftId: attempt.draftId, projectId: project.id },
				);
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the stakeholder email",
			});
		}

		return {
			started: true as const,
			draftId: attempt.draftId,
			version: attempt.version,
		};
	});

/**
 * Adopt a generated stakeholder email version as the topic's working draft.
 *
 * Takes no option label — a stakeholder email generation produces one draft
 * rather than a labeled set. Like its siblings it does NOT accept the text: the
 * client names a candidate, and the server reads the subject and body out of
 * that draft's own stored `content`. Accepting a body would make this endpoint a
 * way to write arbitrary text into a project's published-content pipeline under
 * the guise of "adopting" a generated version — and the stored draft would then
 * no longer be evidence of what the model actually produced. Editing is
 * `saveStakeholderEmailBody`, which is explicit about being an edit and records
 * who made it.
 *
 * Reaching this at all means a working draft already exists, because the FIRST
 * generation seeded one. That is the whole reason the compare-and-set matters
 * here: adopting version 4 over a body someone has been editing is exactly the
 * silent overwrite the working draft's `updatedAt` guard exists to prevent.
 */
export const adoptStakeholderEmailDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/stakeholder-email/adopt",
		tags: ["Projects", "Publishing Suite"],
		summary:
			"Adopt a generated stakeholder email version as the working draft",
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
		const email = drafts.find((d) => d.postType === "STAKEHOLDER_EMAIL");
		const candidate =
			email?.latestReady?.id === input.draftId ? email.latestReady : null;
		if (!candidate) {
			// Deliberately the same answer for "no such draft" and "that draft is
			// not the current one": a caller who guessed an id learns nothing
			// about whether it exists, and a stale tab learns it needs to refresh
			// either way.
			throw new ORPCError("NOT_FOUND", { message: "Draft not found" });
		}

		const document = readStakeholderEmailDocument(candidate.content);
		if (document === null) {
			// The stored document is not one this code can read — an older
			// content shape, or a row written by a future one. A 500 rather than
			// a NOT_FOUND: the draft is right there and the failure is ours.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"This draft could not be read as a stakeholder email. Regenerate it.",
			});
		}

		const saved = await saveWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			postType: "STAKEHOLDER_EMAIL",
			sourceDraftId: input.draftId,
			// No option to name: a stakeholder email generation produces one
			// draft rather than a labeled set.
			sourceOptionLabel: null,
			// The SHARED composer, not a copy of it — `@repo/temporal` seeds the
			// working draft with this exact function
			// (`generate-stakeholder-email.ts`), so the adopted text cannot drift
			// from the seeded text. The Blog Post sibling duplicates its composer
			// into this layer as `readBlogBody` and the copies went unpinned for
			// two releases; #1854 backfilled that parity test, and this family
			// avoids the duplication instead.
			body: composeStakeholderEmailWorkingDraftBody(document),
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
					"The saved stakeholder email changed while you were reading. Refresh and try again.",
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
 * Save an edit to the topic's working stakeholder email.
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
export const saveStakeholderEmailBodyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/stakeholder-email/body",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save an edit to the working stakeholder email draft",
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
			postType: "STAKEHOLDER_EMAIL",
			body: input.body,
			updatedById: context.user.id,
			expectedUpdatedAt: input.expectedUpdatedAt,
		});

		if (saved.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (saved.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved stakeholder email to edit",
			});
		}
		if (saved.status === "stale") {
			throw new ORPCError("CONFLICT", {
				message:
					"The saved stakeholder email changed while you were editing. Refresh and try again.",
			});
		}

		return { saved: true as const, updatedAt: saved.updatedAt };
	});

/**
 * Narrow a stored stakeholder email draft's `content` to the two fields the
 * working draft is composed from.
 *
 * Defensive about the shape rather than trusting it: `content` is `Json?` in the
 * schema, so a row written by an older code path — or by a future one — is not
 * guaranteed to match today's document. Returning null makes that an error the
 * caller can render instead of a `TypeError` in a handler.
 *
 * This narrows ONLY; it does not compose. The Markdown is built by
 * `composeStakeholderEmailWorkingDraftBody` in `@repo/utils`, the same function
 * the generation activity seeds the working draft with, so the adopted text and
 * the seeded text cannot diverge.
 */
function readStakeholderEmailDocument(
	content: unknown,
): { subject: string; body: string } | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const doc = content as { subject?: unknown; body?: unknown };
	if (typeof doc.subject !== "string" || typeof doc.body !== "string") {
		return null;
	}
	const subject = doc.subject.trim();
	const body = doc.body.trim();
	if (!subject || !body) {
		return null;
	}
	return { subject, body };
}
