/**
 * Newsletter Blurb — start one generation run, adopt a generated version, and
 * save an edit (Publishing Suite Phase 2D slice 2, Fizzy #1988).
 *
 * The same three-endpoint, single-draft shape as the Case Study, Stakeholder
 * Email and Webinar Script family: one editable draft rather than Short Post's
 * three options, and the FIRST run seeds the working draft inside the activity,
 * so this module owns what happens afterwards — adopting a later version over
 * saved work, and editing the text. Both must be compare-and-set, because both
 * can be racing the other.
 *
 * The composed working draft is short: a headline, one blurb paragraph, and a
 * call to action only when there is one. That is why `BODY_MAX` here follows
 * the Stakeholder Email's 24,000 rather than the Webinar Script's 40,000 —
 * see the constant's own comment.
 *
 * Like the Webinar Script, the generated document carries more fields than the
 * working draft renders, so `readNewsletterBlurbDocument` re-validates the
 * stored `content` through the SHARED
 * {@link PublishingNewsletterBlurbSchema} — the very schema the generation
 * activity validates the model's output against — but only over the fields the
 * composer actually reads. `suggestedAssets` is deliberately replaced rather
 * than re-checked: the activity's asset clamp runs AFTER validation and appends
 * to `needsConfirmation` with no cap of its own, so re-checking that field's
 * `.max(8)` would turn an activity-produced document into one adopt can never
 * read again. See `readNewsletterBlurbDocument` for the detail.
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
import {
	composeNewsletterBlurbWorkingDraftBody,
	NEWSLETTER_BLURB_BODY_MAX,
	type NewsletterBlurbDocument,
	PublishingNewsletterBlurbSchema,
} from "@repo/utils/publishing-newsletter-blurb-body";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	recordEditedWorkingDraft,
	recordPublishingOutcome,
	recordSupersededDraft,
} from "../../lib/publishing-outcome";
import { readRefinementSource } from "../../lib/publishing-refine-source";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

/**
 * Bound on the per-run guidance.
 *
 * 2000, the family's shared figure — the same number
 * `StakeholderEmailPanel.tsx` puts on its own guidance box, and the same one
 * `buildShortPostVariables` clamps to at `GUIDANCE_CHAR_CAP` when the prompt is
 * composed. Both bounds exist because they protect different things: this one
 * protects the column and the audit trail, the other protects the model's
 * context window from a value written before the bound existed.
 */
const GUIDANCE_MAX = 2000;

/**
 * Bound on an edited body.
 *
 * The SHARED constant from `@repo/utils`, not a local literal — unlike the
 * Webinar Script, whose module declares its own 40,000 beside the package's and
 * documents that nothing keeps the two equal. There is one number here, so
 * there is nothing to drift.
 *
 * 24,000 follows the Stakeholder Email rather than the Webinar Script: a blurb
 * is the SHORTEST thing this suite writes — one headline and one or two short
 * paragraphs — so the Webinar Script's cap would be several times the largest
 * document this content type's schema can even express. It exists to keep an
 * unbounded write off a `@db.Text` column, not to impose a house style.
 */
const BODY_MAX = NEWSLETTER_BLURB_BODY_MAX;

export const generateNewsletterBlurbProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/newsletter-blurb",
		tags: ["Projects", "Publishing Suite"],
		summary: "Generate a newsletter blurb draft for a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			guidance: z.string().max(GUIDANCE_MAX).nullable().optional(),
			/**
			 * Revise the saved working blurb rather than draft a new one from
			 * the planning analysis (Fizzy #1851, A7 — same flag the rest of the
			 * family carries).
			 *
			 * A FLAG, not a body. The server reads the text it revises out of
			 * its own store — see `readRefinementSource` for why a client-
			 * supplied body would be a different and much worse endpoint.
			 * `guidance` carries the edit instruction on this path, which is
			 * what puts it on the attempt row and in the audit trail.
			 */
			refineFromWorkingDraft: z.boolean().optional(),
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

		// BEFORE the attempt row, for the reason the Temporal check above is
		// before it: a refine against a topic with nothing saved must fail
		// having created nothing. Creating the row first and discovering the
		// missing draft second would leave a GENERATING row holding the partial
		// unique index, so the button would refuse for ten minutes over a
		// mistake that cost nothing to detect.
		const currentDraft = input.refineFromWorkingDraft
			? await readRefinementSource({
					topicId: input.topicId,
					projectId: project.id,
					postType: "NEWSLETTER_BLURB",
					label: "newsletter blurb",
				})
			: null;

		const attempt = await startTopicDraftAttempt({
			topicId: input.topicId,
			projectId: project.id,
			postType: "NEWSLETTER_BLURB",
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
			// the workflow memo so a newsletter blurb run can be traced end to
			// end.
			await client.workflow.start(
				"generatePublishingNewsletterBlurbWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					// Keyed on the ATTEMPT, not the topic: each attempt is a
					// distinct row with its own terminal state, and reusing a
					// topic-keyed id would make a second run collide with a
					// finished one's history. The `-nb:` prefix keeps this family
					// distinguishable from `-ws:` and `-cs:` in Temporal's UI.
					workflowId: `publishing-topic-nb:${attempt.draftId}`,
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
							currentDraft,
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
					"[publishing-newsletter-blurb] start rollback skipped",
					rollback.reason,
					{ draftId: attempt.draftId, projectId: project.id },
				);
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Could not start the newsletter blurb",
			});
		}

		// Measurement only, after the run is safely started (Fizzy #1851 A9).
		// A regeneration that passes over a candidate already on screen is a
		// rejection of it; the helper swallows its own failures, so nothing
		// here can turn a started run into an error.
		await recordSupersededDraft({
			topicId: input.topicId,
			projectId: project.id,
			organizationId: project.organizationId,
			postType: "NEWSLETTER_BLURB",
			userId: context.user.id,
		});

		return {
			started: true as const,
			draftId: attempt.draftId,
			version: attempt.version,
		};
	});

/**
 * Adopt a generated newsletter blurb version as the topic's working draft.
 *
 * Takes no option label — a newsletter blurb generation produces one draft
 * rather than a labeled set. Like its siblings it does NOT accept the text:
 * the client names a candidate, and the server reads the document out of that
 * draft's own stored `content`. Accepting a body would make this endpoint a
 * way to write arbitrary text into a project's published-content pipeline
 * under the guise of "adopting" a generated version — and the stored draft
 * would then no longer be evidence of what the model actually produced.
 * Editing is `saveNewsletterBlurbBody`, which is explicit about being an edit
 * and records who made it.
 *
 * Reaching this at all means a working draft already exists, because the FIRST
 * generation seeded one. That is the whole reason the compare-and-set matters
 * here: adopting version 4 over a body someone has been editing is exactly the
 * silent overwrite the working draft's `updatedAt` guard exists to prevent.
 */
export const adoptNewsletterBlurbDraftProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/newsletter-blurb/adopt",
		tags: ["Projects", "Publishing Suite"],
		summary:
			"Adopt a generated newsletter blurb version as the working draft",
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
		const newsletterBlurb = drafts.find(
			(d) => d.postType === "NEWSLETTER_BLURB",
		);
		const candidate =
			newsletterBlurb?.latestReady?.id === input.draftId
				? newsletterBlurb.latestReady
				: null;
		if (!candidate) {
			// Deliberately the same answer for "no such draft" and "that draft is
			// not the current one": a caller who guessed an id learns nothing
			// about whether it exists, and a stale tab learns it needs to refresh
			// either way.
			throw new ORPCError("NOT_FOUND", { message: "Draft not found" });
		}

		const document = readNewsletterBlurbDocument(candidate.content);
		if (document === null) {
			// The stored document is not one this code can read — an older
			// content shape, or a row written by a future one. A 500 rather than
			// a NOT_FOUND: the draft is right there and the failure is ours.
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"This draft could not be read as a newsletter blurb. Regenerate it.",
			});
		}

		const saved = await saveWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			postType: "NEWSLETTER_BLURB",
			sourceDraftId: input.draftId,
			// No option to name: a newsletter blurb generation produces one
			// draft rather than a labeled set.
			sourceOptionLabel: null,
			// The SHARED composer, not a copy of it — `@repo/temporal` seeds the
			// working draft with this exact function, so the adopted text cannot
			// drift from the seeded text.
			body: composeNewsletterBlurbWorkingDraftBody(document),
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
					"The saved newsletter blurb changed while you were reading. Refresh and try again.",
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

		// Measurement only (Fizzy #1851 A9). Adopting is the cleanest
		// acceptance signal the Suite produces — the body saved IS the text the
		// model wrote, since this endpoint refuses to take one from the client.
		await recordPublishingOutcome({
			outcome: "ACCEPTED_AS_IS",
			subjectType: "publishing-newsletter-blurb",
			subjectId: candidate.id,
			userId: context.user.id,
			organizationId: project.organizationId,
			projectId: project.id,
			model: candidate.model,
			promptId: candidate.promptId,
			promptVersion: candidate.promptVersion,
		});

		return { saved: true as const, updatedAt: saved.updatedAt };
	});

/**
 * Save an edit to the topic's working newsletter blurb.
 *
 * The one endpoint in this family that DOES take body text from the client, and
 * it is safe for the reason the others are not: it is an edit. There is no
 * generated artefact whose evidentiary value it could undermine — the draft rows
 * keep saying exactly what the model produced, and `sourceDraftId` keeps naming
 * the version this text began as. What changes is the body the project owns,
 * which is what a person editing their own draft is entitled to change.
 *
 * `expectedUpdatedAt` is required rather than nullable in the sense that
 * OMITTING it is refused: an edit necessarily has something to edit, so "I
 * believe nothing is saved" is not a coherent claim here, and accepting the
 * absence would mean accepting an unconditional write.
 *
 * A literal `null` is a different matter and IS accepted — `z.coerce.date()`
 * runs `new Date(null)`, which is the Unix epoch rather than an Invalid Date.
 * That fails closed rather than opening the hole above: an epoch expectation
 * can never equal a real working draft's `updatedAt`, so the compare-and-set
 * answers CONFLICT and nothing is written. Measured, and pinned in this
 * module's suite; spelled the same way across every sibling in this family.
 */
export const saveNewsletterBlurbBodyProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/newsletter-blurb/body",
		tags: ["Projects", "Publishing Suite"],
		summary: "Save an edit to the working newsletter blurb draft",
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
			postType: "NEWSLETTER_BLURB",
			body: input.body,
			updatedById: context.user.id,
			expectedUpdatedAt: input.expectedUpdatedAt,
		});

		if (saved.status === "project_ineligible") {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		if (saved.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No saved newsletter blurb to edit",
			});
		}
		if (saved.status === "stale") {
			throw new ORPCError("CONFLICT", {
				message:
					"The saved newsletter blurb changed while you were editing. Refresh and try again.",
			});
		}

		// Measurement only (Fizzy #1851 A9). An edit over an adopted candidate
		// is that candidate's verdict downgraded from "as is" to "with edits" —
		// the pair of counts that answers "how much revision does this take".
		await recordEditedWorkingDraft({
			topicId: input.topicId,
			projectId: project.id,
			organizationId: project.organizationId,
			postType: "NEWSLETTER_BLURB",
			userId: context.user.id,
		});

		return { saved: true as const, updatedAt: saved.updatedAt };
	});

/**
 * The fields the composer never reads, supplied as inert placeholders so the
 * stored document can be re-validated without re-checking bounds it is allowed
 * to exceed.
 *
 * `suggestedAssets` is the one that matters. `BaseNewsletterBlurbSchema` bounds
 * `needsConfirmation` at `.max(8)` — the contract `generateObject` holds the
 * MODEL to — but `generate-newsletter-blurb.ts` runs its asset clamp AFTER that
 * validation and appends the moved labels with no cap of its own, so a stored
 * row can legitimately carry more than eight. Re-checking that bound here would
 * make such a row permanently unadoptable, including after a regeneration that
 * reproduces the same overflow while the approval that caused it stays open.
 * `audience`, `releaseStatus`, `inputsNeeded` and `safetyNote` are supplied for
 * the same reason in the weaker sense: the composer never reads them either, so
 * their bounds are not this path's business.
 */
const COMPOSER_IRRELEVANT_FIELDS = {
	suggestedAssets: { confirmed: [], needsConfirmation: [] },
	audience: "UNSPECIFIED",
	releaseStatus: "UNCONFIRMED",
	inputsNeeded: [],
	safetyNote: null,
} as const;

/**
 * Narrow a stored newsletter blurb draft's `content` to the parsed document
 * {@link composeNewsletterBlurbWorkingDraftBody} composes from.
 *
 * Defensive about the shape rather than trusting it: `content` is `Json?` in
 * the schema, so a row written by an older code path — or by a future one — is
 * not guaranteed to match today's document. Returning null makes that an error
 * the caller can render instead of a `TypeError` in a handler.
 *
 * Runs the SHARED {@link PublishingNewsletterBlurbSchema}, not a hand-narrowed
 * copy of the four fields the composer reads, so the `ctaState` reconciliation
 * that decides whether a call to action reaches the body is the SAME one the
 * generation activity applied before storing — a second implementation of that
 * six-cell table is exactly how the adopted text would come to differ from the
 * seeded text. The composer-irrelevant fields are replaced rather than passed
 * through; see {@link COMPOSER_IRRELEVANT_FIELDS} for why re-checking them
 * would be actively wrong.
 *
 * `content` also carries a `generation` block this schema does not declare;
 * Zod's default object mode strips unknown keys rather than erroring on them,
 * and the four fields read below are picked out by name in any case.
 */
function readNewsletterBlurbDocument(
	content: unknown,
): NewsletterBlurbDocument | null {
	// A non-object `content` yields `undefined` for every field below, which the
	// schema rejects on the required `headline` — so this stays total without a
	// separate typeof guard.
	const raw = (content ?? {}) as Record<string, unknown>;
	const parsed = PublishingNewsletterBlurbSchema.safeParse({
		headline: raw.headline,
		blurb: raw.blurb,
		ctaState: raw.ctaState,
		suggestedCta: raw.suggestedCta,
		...COMPOSER_IRRELEVANT_FIELDS,
	});
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}
