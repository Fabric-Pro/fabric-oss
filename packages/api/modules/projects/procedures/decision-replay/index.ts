import {
	getDecisionReplayProposalTimeline,
	getDecisionReplaySummary,
	listDecisionReplayNeedsReview,
} from "@repo/database";
import { z } from "zod";
import { usageRangeSchema } from "../usage/shared";
import { getDecisionReplayEmbedToken } from "./embed-token";
import { decisionReplayProcedure, decisionReplayScopeSchema } from "./shared";

const acceptanceSchema = z.object({
	accepted: z.number().int(),
	decided: z.number().int(),
	rate: z.number().nullable(),
});
const periodSchema = z.object({
	acceptance: acceptanceSchema,
	changeAcceptance: acceptanceSchema,
	changeOutcomes: z.object({
		applied: z.number().int(),
		alreadyOnRoadmap: z.number().int(),
		notSelected: z.number().int(),
		failed: z.number().int(),
		inProgress: z.number().int(),
		rejected: z.number().int(),
		superseded: z.number().int(),
		pending: z.number().int(),
	}),
	partlyApplied: z.number().int(),
	medianReviewSeconds: z.number().nullable(),
	keptAsApplied: z.object({
		kept: z.number().int(),
		mature: z.number().int(),
		rate: z.number().nullable(),
	}),
	outcomes: z.object({
		applied: z.number().int(),
		rejected: z.number().int(),
		pending: z.number().int(),
		other: z.number().int(),
	}),
});

export const getSummaryProcedure = decisionReplayProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/decision-replay/summary",
		tags: ["Projects", "Decision Replay"],
		summary: "Get AI decision outcomes",
		description:
			"Live waiting count and current/previous period outcomes. Periods are half-open; all has no previous period. Rates and medians are null without observations.",
	})
	.input(decisionReplayScopeSchema.extend({ range: usageRangeSchema }))
	.output(
		z.object({
			waiting: z.number().int(),
			oldestWaitingAt: z.date().nullable(),
			changeCoverageStartedAt: z.date().nullable(),
			current: periodSchema,
			previous: periodSchema.nullable(),
		}),
	)
	.handler(({ input, context }) =>
		getDecisionReplaySummary({
			...input,
			organizationId: context.decisionReplayOrganizationId,
		}),
	);

export const listNeedsReviewProcedure = decisionReplayProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/decision-replay/needs-review",
		tags: ["Projects", "Decision Replay"],
		summary: "List proposals awaiting review",
		description:
			"Oldest PENDING proposals, ordered by creation time then id, plus the total waiting count.",
	})
	.input(
		decisionReplayScopeSchema.extend({
			limit: z.number().int().min(1).max(100).default(5),
		}),
	)
	.handler(({ input, context }) =>
		listDecisionReplayNeedsReview({
			...input,
			organizationId: context.decisionReplayOrganizationId,
		}),
	);

export const getProposalTimelineProcedure = decisionReplayProcedure
	.route({
		method: "GET",
		path: "/projects/{projectId}/decision-replay/proposals/{proposalId}/timeline",
		tags: ["Projects", "Decision Replay"],
		summary: "Get proposal decision timeline",
		description:
			"Returns { events, truncated } with the latest 200 captured proposal and related events by event time then id, presented oldest first. Actor names require current organization membership. Actor ids and raw payloads are omitted.",
	})
	.input(
		decisionReplayScopeSchema.extend({
			proposalId: z.string().min(1).max(900),
		}),
	)
	.output(
		z.object({
			truncated: z.boolean(),
			events: z.array(
				z.object({
					occurredAt: z.date(),
					eventType: z.string(),
					fromState: z.string().nullable(),
					toState: z.string().nullable(),
					actorKind: z.string(),
					actorName: z.string().nullable(),
					subjectType: z.string(),
					changeIndex: z.number().int().nullable(),
					action: z.string().nullable(),
					createdEntityType: z.string().nullable(),
					offeredCount: z.number().int().nullable(),
					selectedCount: z.number().int().nullable(),
					offeredListComplete: z.boolean().nullable(),
					notSelectedTitles: z.array(z.string()).max(20),
				}),
			),
		}),
	)
	.handler(({ input, context }) =>
		getDecisionReplayProposalTimeline({
			...input,
			organizationId: context.decisionReplayOrganizationId,
		}),
	);

// This read grants a project-filtered view without changing Fabric state,
// so it does not emit a mutation audit action.
export const getEmbedTokenProcedure = decisionReplayProcedure
	.route({
		method: "POST",
		path: "/projects/{projectId}/decision-replay/embed-token",
		tags: ["Projects", "Decision Replay"],
		summary: "Get scoped dashboard token",
		description:
			"Returns a short-lived project-scoped viewer token or an unavailable reason. Clients should refresh before expiresAt and keep tokens out of persistent storage.",
	})
	.input(decisionReplayScopeSchema)
	.handler(({ input, context }) =>
		getDecisionReplayEmbedToken({
			projectId: input.projectId,
			userId: context.user.id,
		}),
	);
