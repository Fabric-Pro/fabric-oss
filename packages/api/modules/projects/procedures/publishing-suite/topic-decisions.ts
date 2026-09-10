/**
 * A topic's decision thread — read it, and answer an open question on it
 * (Publishing Suite Phase 2A-3, Fizzy #1851).
 *
 * `listTopicDecisionsProcedure` is a single GET, shaped like
 * `getPlanningAnalysisProcedure`: the DB helper re-scopes the read to
 * `{ topicId, projectId }`, so a topic id belonging to another project yields
 * an empty thread list — the same answer a topic with no decisions yet
 * produces. This endpoint cannot be used to probe for the existence of topics
 * in projects the caller cannot see (DV16).
 *
 * Deliberately no `requireEligibleProjectForTopic()` ratchet on the READ,
 * unlike `answerTopicQuestionProcedure` below and the other write side
 * (`generatePlanningAnalysisProcedure`). That ratchet also filters on
 * `status: "ACTIVE", deletedAt: null` — right for a write, which must not
 * start new work on a project that is gone, but wrong for a read: it would
 * 404 this ONE tab of the Topic Item Page on an archived project while the
 * header and the Planning & Analysis tab (`getPlanningAnalysisProcedure`,
 * which carries no such check either) render normally, leaving the page's
 * own tabs disagreeing about whether the project exists. Reads stay
 * permissive; writes ratchet — answering a question on an archived project is
 * new work, and must be refused the same way starting a new analysis run is.
 */

import { ORPCError } from "@orpc/client";
import {
	amendTopicQuestionAnswer,
	answerTopicQuestion,
	listTopicDecisions,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPublishingSuiteFeatureEnabled } from "../../lib/publishing-suite-feature";
import { requireEligibleProjectForTopic } from "../../lib/publishing-topic-project";

const TopicDecisionEntrySchema = z.object({
	id: z.string(),
	parentId: z.string().nullable(),
	// BLOCKER rides the same table and the same read: it is a thread with a
	// status, an author and a history, exactly as a question is. Both existing
	// readers filter by kind, so widening this cannot leak one into a surface
	// built for questions.
	kind: z.enum(["QUESTION", "AI_UPDATE", "BLOCKER"]),
	status: z.string(),
	authorType: z.enum(["USER", "AGENT"]),
	authorUserId: z.string().nullable(),
	/**
	 * The author's own name, so the log can say who decided.
	 *
	 * `nullish`, not required: an AI turn has no author, and a person whose
	 * account was removed leaves `authorUserId` null under `ON DELETE SET
	 * NULL`. Readers fall back to a generic label in both cases rather than
	 * inventing a name. Three fields only — a decision log is not a reason to
	 * put an email address on the wire.
	 */
	author: z
		.object({
			id: z.string(),
			name: z.string(),
			image: z.string().nullable(),
		})
		.nullish(),
	questionId: z.string().nullable(),
	decisionKind: z.string().nullable(),
	subject: z.string().nullable(),
	summary: z.string().nullable(),
	content: z.string().nullable(),
	recommendedResponse: z.string().nullable(),
	/**
	 * Several answers to choose between, as Feature Maturation offers.
	 *
	 * `nullish` and not required: every row minted before this carries none,
	 * and a reader falls back to `recommendedResponse` above — so nothing had
	 * to be backfilled and an old question reads exactly as it always did.
	 */
	answerOptions: z
		.array(z.object({ text: z.string(), justification: z.string() }))
		.nullish(),
	whyItMatters: z.string().nullable(),
	answerSource: z.string().nullable(),
	analysisVersion: z.number().int().nullable(),
	createdAt: z.date(),
	/**
	 * Who the question is waiting on, oldest assignment first (Fizzy #1851).
	 *
	 * `default([])` rather than required: replies and AI Update notes can never
	 * carry one, and an absent key must read as "nobody is on this" — the state
	 * the panel renders as a dashed placeholder — rather than fail validation
	 * and take the whole thread down with it.
	 */
	assignees: z
		.array(
			z.object({
				assigneeUserId: z.string(),
				assignedByUserId: z.string(),
			}),
		)
		.default([]),
});

export const listTopicDecisionsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/publishing-topics/{topicId}/decisions",
		tags: ["Projects", "Publishing Suite"],
		summary: "List a topic's decision thread",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			threads: z.array(
				z.object({
					root: TopicDecisionEntrySchema,
					replies: z.array(TopicDecisionEntrySchema),
				}),
			),
		}),
	)
	.handler(async ({ input }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// No project-eligibility ratchet (see module doc): the scoping that
		// matters for isolation — {topicId, projectId} inside the query below —
		// stays; requireProjectPermission above already proved the caller is
		// authorized for this project.
		const threads = await listTopicDecisions({
			projectId: input.projectId,
			topicId: input.topicId,
		});

		return { threads };
	});

export const answerTopicQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/decisions/answer",
		tags: ["Projects", "Publishing Suite"],
		summary: "Answer an open question on a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			questionId: z.string().min(1).max(500),
			answer: z.string().min(1).max(10_000),
			answerSource: z.enum(["AI_SUGGESTED", "AI_EDITED", "MANUAL"]),
			/**
			 * Which kind of root is being settled — a question, or a blocker.
			 *
			 * Optional and `QUESTION` by default so an older client is
			 * unchanged. It is part of the address, not a filter: without it a
			 * blocker id could clear a question that happened to share one, and
			 * the write would look correct from every side.
			 */
			kind: z.enum(["QUESTION", "BLOCKER"]).optional(),
		}),
	)
	.output(
		z.object({
			status: z.enum(["resolved", "deduped"]),
			root: TopicDecisionEntrySchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		// Ratchet, unlike the read above (see module doc): a WRITE must not start
		// new work — recording a decision counts — on a project that is archived
		// or gone.
		await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId ?? null,
		});

		const result = await answerTopicQuestion({
			projectId: input.projectId,
			topicId: input.topicId,
			questionId: input.questionId,
			kind: input.kind,
			answer: input.answer,
			answerSource: input.answerSource,
			// The AUTHOR is the session, never the request body. A client-supplied
			// author id would let anyone with update access attribute a decision to
			// a colleague.
			authorUserId: context.user.id,
		});

		if (result.status === "not_found") {
			throw new ORPCError("NOT_FOUND", { message: "Question not found" });
		}

		return { status: result.status, root: result.root };
	});

/**
 * Change the answer to an already-resolved question.
 *
 * Every gate is `answerTopicQuestionProcedure`'s, deliberately unchanged: the
 * same `PUBLISHING_TOPIC_UPDATE` permission, the same feature assertion, and
 * the same project ratchet — amending a decision is new work on the project,
 * so an archived one must refuse it exactly as it refuses a first answer. A
 * read-only member cannot amend, for the same reason they cannot answer.
 *
 * `organizationId` stays a GUARD and never a scoping key: it is handed to
 * `requireEligibleProjectForTopic`, which rejects a positively-wrong value
 * against the loaded Project row and otherwise ignores it. Nothing here
 * resolves a tenant from caller input.
 *
 * `supersedesId` is the answer turn the client was looking at. Sending it is
 * what makes a concurrent amendment detectable — without it, whoever saved last
 * would silently overwrite a colleague's correction they never read.
 */
export const amendTopicQuestionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PUBLISHING_TOPIC_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/publishing-topics/{topicId}/decisions/amend",
		tags: ["Projects", "Publishing Suite"],
		summary: "Amend the answer to a resolved question on a topic",
	})
	.input(
		z.object({
			projectId: z.string(),
			topicId: z.string(),
			organizationId: z.string().nullable().optional(),
			questionId: z.string().min(1).max(500),
			/** The answer turn being replaced. */
			supersedesId: z.string().min(1),
			answer: z.string().min(1).max(10_000),
			answerSource: z.enum(["AI_SUGGESTED", "AI_EDITED", "MANUAL"]),
		}),
	)
	.output(
		z.object({
			// `stale` is a real outcome rather than an error: the amendment was
			// refused, but nothing is broken and the client's job is to reload
			// and show the answer that won, not to report a failure.
			status: z.enum(["amended", "deduped", "stale"]),
			root: TopicDecisionEntrySchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertPublishingSuiteFeatureEnabled(input.projectId);

		await requireEligibleProjectForTopic({
			projectId: input.projectId,
			clientOrganizationId: input.organizationId ?? null,
		});

		const result = await amendTopicQuestionAnswer({
			projectId: input.projectId,
			topicId: input.topicId,
			questionId: input.questionId,
			supersedesId: input.supersedesId,
			answer: input.answer,
			answerSource: input.answerSource,
			// The AUTHOR is the session, never the request body — same rule the
			// answer path states: a client-supplied author id would let anyone
			// with update access attribute a decision to a colleague.
			authorUserId: context.user.id,
		});

		if (result.status === "not_found") {
			throw new ORPCError("NOT_FOUND", {
				message: "No resolved answer to amend for this question",
			});
		}

		return { status: result.status, root: result.root };
	});
