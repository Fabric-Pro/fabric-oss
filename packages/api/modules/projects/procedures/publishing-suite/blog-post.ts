/**
 * Blog Post — start one generation run, adopt a generated version, and save an
 * edit (Publishing Suite Phase 2B-3, Fizzy #1853).
 *
 * All three are writes; the read side is `listTopicDrafts`, polled while a run
 * is in flight. Scoped exactly like `generateShortPost`: no procedure trusts a
 * topic id alone. The DB helpers re-scope to `{ topicId, projectId }` inside the
 * Project-row lock, so a real topic id belonging to another project produces the
 * answer a missing one produces and cannot be used to probe for topics in
 * projects the caller cannot see (DV16).
 *
 * WHY THERE ARE THREE AND THE SHORT POST HAS TWO. A blog generation seeds the
 * working draft on the FIRST run (DV5/FR21) — that write happens in the
 * activity, not here — so this module's job is what happens afterwards: adopting
 * a later version over saved work, and editing the text. Both must be
 * compare-and-set, because both can now be racing the other.
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
 * Bound on the per-run guidance (FR13).
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
 * Matches the schema's own cap on generated body text, so a person cannot save
 * a draft the generator would have been refused for producing. Generous: this is
 * long-form content, and the cap exists to stop an unbounded write reaching a
 * `@db.Text` column, not to impose a house style.
 */
const BODY_MAX = 40000;

export const generateBlogPostProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/blog-post",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate a blog post draft for a topic",
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

		// Security ratchet, identical to `generateShortPost`: the permission
		// middleware proved the caller is authorized for THIS project, but it
		// never inspects the org. The tenant is derived from the loaded Project
		// row, and `input.organizationId` is a guard only — never a scoping key.
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
			postType: "BLOG_POST",
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
			// the workflow memo so a blog run can be traced end to end. Its two
			// publishing siblings do NOT do this — the gap is family-wide and
			// predates this slice — but new code meets the current standard
			// rather than matching the neighbours' omission. Raised by review.
			await client.workflow.start(
				"generatePublishingBlogPostWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					// Keyed on the ATTEMPT, not the topic: each attempt is a
					// distinct row with its own terminal state, and reusing a
					// topic-keyed id would make a second run collide with a
					// finished one's history.
					workflowId: `publishing-topic-bp:${attempt.draftId}`,
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
					"[publishing-blog-post] start rollback skipped",
					rollback.reason,
					{ draftId: attempt.draftId, projectId: project.id },
				);
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the blog post",
			});
		}

		return {
			started: true as const,
			draftId: attempt.draftId,
			version: attempt.version,
		};
	});

/**
 * Adopt a generated blog version as the topic's working draft (FR34/FR35).
 *
 * The counterpart to `selectShortPostOption`, and it takes no label — a blog
 * generation produces one draft rather than a labeled set. Like its sibling it
 * does NOT accept the text: the client names a candidate, and the server reads
 * the body out of that draft's own stored `content`. Accepting a body would make
 * this endpoint a way to write arbitrary text into a project's published-content
 * pipeline under the guise of "adopting" a generated version — and the stored
 * draft would then no longer be evidence of what the model actually produced.
 * Editing is `saveBlogPostBody`, which is explicit about being an edit and
 * records who made it.
 *
 * Reaching this at all means a working draft already exists, because the FIRST
 * generation seeded one. That is the whole reason the compare-and-set matters
 * here: adopting version 4 over a body someone has been editing is exactly the
 * silent overwrite FR35 forbids.
 */
export const adoptBlogPostDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/blog-post/adopt",
		tags: ["Projects", "Publishing Suite"],
		summary: "Adopt a generated blog post version as the working draft",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			draftId: z.string(),
			/**
			 * The working draft's `updatedAt` as the client last saw it, or null
			 * for "nothing is saved". Optimistic concurrency, and not optional
			 * here the way it is on the short post's selection: this endpoint
			 * shipped with the editor that makes a concurrent body change
			 * possible, so there is no older client whose absent expectation has
			 * to keep working.
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
		const blog = drafts.find((d) => d.postType === "BLOG_POST");
		const candidate =
			blog?.latestReady?.id === input.draftId ? blog.latestReady : null;
		if (!candidate) {
			// Deliberately the same answer for "no such draft" and "that draft is
			// not the current one": a caller who guessed an id learns nothing
			// about whether it exists, and a stale tab learns it needs to refresh
			// either way.
			throw new ORPCError("NOT_FOUND", { message: "Draft not found" });
		}

		const body = readBlogBody(candidate.content);
		if (body === null) {
			// The stored document is not one this code can read — an older
			// content shape, or a row written by a future one. A 500 rather than
			// a NOT_FOUND: the draft is right there and the failure is ours.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"This draft could not be read as a blog post. Regenerate it.",
			});
		}

		const saved = await saveWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			postType: "BLOG_POST",
			sourceDraftId: input.draftId,
			// No option to name: a blog generation produces one draft rather
			// than a labeled set.
			sourceOptionLabel: null,
			body,
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
					"The saved blog post changed while you were reading. Refresh and try again.",
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
 * Save an edit to the topic's working blog post (FR21).
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
export const saveBlogPostBodyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/blog-post/body",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save an edit to the working blog post draft",
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
			postType: "BLOG_POST",
			body: input.body,
			updatedById: context.user.id,
			expectedUpdatedAt: input.expectedUpdatedAt,
		});

		if (saved.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (saved.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved blog post to edit",
			});
		}
		if (saved.status === "stale") {
			throw new ORPCError("CONFLICT", {
				message:
					"The saved blog post changed while you were editing. Refresh and try again.",
			});
		}

		return { saved: true as const, updatedAt: saved.updatedAt };
	});

/**
 * Compose the editable Markdown from a stored blog draft.
 *
 * Defensive about the shape rather than trusting it: `content` is `Json?` in the
 * schema, so a row written by an older code path — or by a future one — is not
 * guaranteed to match today's document. Returning null makes that an error the
 * caller can render instead of a `TypeError` in a handler.
 *
 * Deliberately reproduces `composeWorkingDraftBody` rather than importing it.
 * The reason is bundling, not layering: `@repo/api` DOES declare `@repo/temporal`
 * (package.json), and this file already dynamically imports from it — so an
 * earlier version of this comment saying the API package "does not and should
 * not depend on" it was half wrong, and is corrected here. What is true is that
 * pulling the whole activity module in for a string join is not worth it.
 *
 * The pairing is pinned by a test asserting both produce the same text for the
 * same document. That test did NOT exist until #1854 added it — this comment
 * claimed it for two releases while the two copies agreed only by coincidence
 * between hardcoded literals. A duplicated rule with nothing checking the
 * copies is how the two silently diverge and an adopted version stops matching
 * the one that was seeded, which is exactly why the 2C families skip the
 * duplication entirely and share one composer from `@repo/utils`.
 */
function readBlogBody(content: unknown): string | null {
	if (content == null || typeof content !== "object") {
		return null;
	}
	const doc = content as {
		title?: unknown;
		subtitle?: unknown;
		body?: unknown;
	};
	if (typeof doc.title !== "string" || typeof doc.body !== "string") {
		return null;
	}
	const title = doc.title.trim();
	const body = doc.body.trim();
	if (!title || !body) {
		return null;
	}
	const parts = [`# ${title}`];
	const subtitle =
		typeof doc.subtitle === "string" ? doc.subtitle.trim() : "";
	if (subtitle) {
		parts.push(`_${subtitle}_`);
	}
	parts.push(body);
	return parts.join("\n\n");
}
