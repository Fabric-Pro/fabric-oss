import {
	clearAiOutcome,
	getAiOutcomesForSubjects,
	recordAiOutcome,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Human verdicts on AI-generated output (Fizzy #2230, Phase 2).
 *
 * Chat has no natural accept/reject action — the user just reads the answer
 * and moves on — so an explicit rating is the only acceptance signal available
 * there. The same procedures serve any surface that wants to record one.
 *
 * AUTHORIZATION: tenantProtectedProcedure + XOR resolution. A verdict is
 * always the calling user's own (the unique key includes userId), so there is
 * no way to read or overwrite someone else's.
 */

const OUTCOME = z.enum([
	"ACCEPTED_AS_IS",
	"ACCEPTED_WITH_EDITS",
	"REJECTED",
	"RATED_UP",
	"RATED_DOWN",
]);

const SUBJECT = z.object({
	featureKey: z.string().min(1).max(64),
	subjectType: z.string().min(1).max(64),
	subjectId: z.string().min(1).max(128),
});

export const rateAiOutput = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/feedback/rate",
		tags: ["AI"],
		summary: "Rate AI output",
		description:
			"Record this user's verdict on one piece of AI-generated output.",
	})
	.input(
		SUBJECT.extend({
			outcome: OUTCOME,
			// Snapshots of what produced the output, supplied by the caller
			// because only it knows which model/prompt served this subject.
			modelCanonicalName: z.string().max(128).nullish(),
			promptVersionId: z.string().max(64).nullish(),
			comment: z.string().max(2000).nullish(),
			projectId: z.string().nullish(),
		}),
	)
	.handler(async ({ input, context }) => {
		// The tenant comes from the SESSION only — this procedure deliberately
		// takes no organizationId from the caller. `resolveOrganizationId`
		// returns caller input verbatim with no membership lookup, so
		// accepting one would let anybody file a verdict under an
		// organization they do not belong to. Nothing needs to: a verdict is
		// always about output the caller just saw in their own session.
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		const event = await recordAiOutcome({
			featureKey: input.featureKey,
			outcome: input.outcome,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			userId: context.user.id,
			organizationId,
			projectId: input.projectId,
			modelCanonicalName: input.modelCanonicalName,
			promptVersionId: input.promptVersionId,
			comment: input.comment,
		});

		return { outcome: event.outcome };
	});

export const clearAiOutputRating = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/feedback/clear",
		tags: ["AI"],
		summary: "Clear AI output rating",
		description: "Remove this user's verdict on one piece of AI output.",
	})
	.input(SUBJECT)
	.handler(async ({ input, context }) => {
		const cleared = await clearAiOutcome({
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			userId: context.user.id,
		});
		return { cleared: cleared > 0 };
	});

export const listAiOutputRatings = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "GET",
		path: "/ai/feedback",
		tags: ["AI"],
		summary: "List AI output ratings",
		description:
			"This user's own verdicts for a set of subjects, for rendering rating controls.",
	})
	.input(
		z.object({
			featureKey: z.string().min(1).max(64),
			subjectType: z.string().min(1).max(64),
			subjectIds: z.array(z.string().min(1).max(128)).max(200),
		}),
	)
	.handler(async ({ input, context }) => {
		const outcomes = await getAiOutcomesForSubjects({
			featureKey: input.featureKey,
			subjectType: input.subjectType,
			subjectIds: input.subjectIds,
			userId: context.user.id,
		});
		return { outcomes };
	});
