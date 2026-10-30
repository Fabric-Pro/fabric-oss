import {
	clearAiOutcome,
	getAiOutcomesForSubjects,
	recordAiOutcome,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { resolveOutputProvenance } from "./output-provenance";

/**
 * Human verdicts on AI-generated output (Fizzy #2230, Phase 2).
 *
 * Chat has no natural accept/reject action — the user just reads the answer
 * and moves on — so an explicit rating is the only acceptance signal available
 * there. The same procedures serve any surface that wants to record one.
 *
 * Project ratings require AI_CHAT on the project and bind organization
 * resolution to that authorized project. Projectless ratings require AI_CHAT
 * in the session tenant. Reads, writes and clears use the calling user's id.
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
	projectId: z.string().nullish(),
});

const projectChatPermission = requireProjectPermission(Permissions.AI_CHAT);
const chatPermission = requirePermission(Permissions.AI_CHAT);

export const rateAiOutput = tenantProtectedProcedure
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
			comment: z.string().max(2000).nullish(),
		}),
	)
	.use((options, input, output) =>
		input.projectId != null
			? projectChatPermission(options, input, output)
			: chatPermission(options, input, output),
	)
	.handler(async ({ input, context }) => {
		// The project permission middleware binds the target tenant for guests.
		// Projectless ratings use the caller's session tenant.
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		const matchingProvenance = await resolveOutputProvenance(
			input,
			organizationId,
			context.user.id,
		);

		const event = await recordAiOutcome({
			featureKey: input.featureKey,
			outcome: input.outcome,
			subjectType: input.subjectType,
			subjectId: input.subjectId,
			userId: context.user.id,
			organizationId,
			projectId: input.projectId ?? null,
			modelCanonicalName: matchingProvenance?.modelCanonicalName ?? null,
			promptVersionId: matchingProvenance?.promptVersionId ?? null,
			comment: input.comment,
		});

		return { outcome: event.outcome };
	});

export const clearAiOutputRating = tenantProtectedProcedure
	.route({
		method: "POST",
		path: "/ai/feedback/clear",
		tags: ["AI"],
		summary: "Clear AI output rating",
		description: "Remove this user's verdict on one piece of AI output.",
	})
	.input(SUBJECT)
	.use((options, input, output) =>
		input.projectId != null
			? projectChatPermission(options, input, output)
			: chatPermission(options, input, output),
	)
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
			projectId: z.string().nullish(),
		}),
	)
	.use((options, input, output) =>
		input.projectId != null
			? projectChatPermission(options, input, output)
			: chatPermission(options, input, output),
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
