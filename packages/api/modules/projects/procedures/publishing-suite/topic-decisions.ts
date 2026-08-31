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
import { answerTopicQuestion, listTopicDecisions } from "@repo/database";
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
	kind: z.enum(["QUESTION", "AI_UPDATE"]),
	status: z.string(),
	authorType: z.enum(["USER", "AGENT"]),
	authorUserId: z.string().nullable(),
	questionId: z.string().nullable(),
	decisionKind: z.string().nullable(),
	subject: z.string().nullable(),
	summary: z.string().nullable(),
	content: z.string().nullable(),
	recommendedResponse: z.string().nullable(),
	whyItMatters: z.string().nullable(),
	answerSource: z.string().nullable(),
	analysisVersion: z.number().int().nullable(),
	createdAt: z.date(),
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
		assertPublishingSuiteFeatureEnabled();

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
		}),
	)
	.output(
		z.object({
			status: z.enum(["resolved", "deduped"]),
			root: TopicDecisionEntrySchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertPublishingSuiteFeatureEnabled();

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
