import { ORPCError } from "@orpc/client";
import {
	amendQuestionAnswer,
	findDecisionByQuestionId,
	getFeatureMaturationState,
	hasProjectAccess,
	type MaturationTenantFilter,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { amendAnswerInSpec } from "../../../lib/record-answer-in-spec";
import { AnswerSourceSchema, DecisionStatusSchema } from "./schemas";

/**
 * `maturation.amendAnswer` (#1910) — correct the answer to an ALREADY-RESOLVED
 * question.
 *
 * APPEND, NEVER MUTATE. The Decision Log is an append-only changelog, so an
 * amendment is a NEW turn carrying `supersedesId` -> the turn it replaces. The
 * superseded turn stays byte-identical and readable as history, which is what
 * lets the Decisions tab show "what this used to say" without becoming an editor
 * over the log.
 *
 * THE SPEC MUST CARRY EXACTLY ONE ANSWER. The Clean Spec is the only thing the AI
 * reads, and answers land in its `## Resolved Decisions (pending integration)`
 * appendix. Appending a second bullet for the same question would hand the next
 * maturation run two contradictory decisions, so this path UPSERTS the question's
 * bullet (`amendAnswerInSpec`) rather than appending.
 *
 * The root keeps its RESOLVED status throughout: amending changes the answer, not
 * whether the question is settled. Permissions mirror `answerQuestion` exactly —
 * `STORY_UPDATE` plus a project-access check — so a read-only member cannot amend.
 */
export const amendAnswerProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/maturation/amend-answer",
		tags: ["Projects", "Features", "Maturation"],
		summary: "Amend the answer to an already-resolved question",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			questionId: z.string().min(1).max(500),
			/** The live answer turn being replaced. */
			supersedesId: z.string().min(1),
			answer: z.string().min(1).max(10_000),
			answerSource: AnswerSourceSchema.optional(),
		}),
	)
	.output(
		z.object({
			decision: z.object({
				id: z.string(),
				status: DecisionStatusSchema,
				summary: z.string().nullable(),
				content: z.string().nullable(),
				questionId: z.string().nullable(),
				createdAt: z.date(),
				supersedesId: z.string().nullable(),
				authorName: z.string().nullable().optional(),
			}),
			/**
			 * Whether the Clean Spec appendix was updated. `false` means the
			 * amendment stands in the log but the spec write failed — surfaced as a
			 * warning rather than losing a committed decision.
			 */
			specUpdated: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		// The org is NEVER taken from input. `resolveOrganizationId` returns a
		// caller-supplied id verbatim with no membership lookup, so accepting one
		// would let a caller pair a project they legitimately reach with an
		// organization they do not — `requireProjectPermission` resolves on
		// (projectId, userId) and never reads the org. Passing `undefined` falls
		// through to the permission middleware's `effectiveWriteOrgId`, set this
		// request after verifying project-scoped access, which also handles the
		// cross-org guest correctly.
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const feature = await getFeatureMaturationState({
			userStoryId: input.storyId,
			projectId: input.projectId,
		});
		if (!feature) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const tenantFilter: MaturationTenantFilter = {
			organizationId: organizationId ?? null,
			userId: context.user.id,
		};

		const root = await findDecisionByQuestionId({
			tenantFilter,
			userStoryId: input.storyId,
			questionId: input.questionId,
		});
		// Only a settled question has an answer to amend. An OPEN one is answered
		// through `answerQuestion`, not here.
		if (!root || root.status === "OPEN") {
			throw new ORPCError("NOT_FOUND", {
				message: "No resolved answer to amend for this question",
			});
		}

		const amended = await amendQuestionAnswer({
			tenantFilter,
			rootId: root.id,
			supersedesId: input.supersedesId,
			answer: input.answer,
			authorUserId: context.user.id,
			decidedBy: context.user.id,
			answerSource: input.answerSource ?? "MANUAL",
			authorName: context.user.name,
			sourceProvenance: `Feature Response — ${feature.title}`,
		});
		// null = wrong tenant, stale target, or the turn was superseded by someone
		// else first. Surface as not found rather than minting a parallel answer.
		if (!amended) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"That answer is no longer the current one — reload and try again",
			});
		}

		// Best-effort, exactly as answering is: the amendment is already committed,
		// so a failed spec write must not throw it away.
		let specUpdated = true;
		try {
			await amendAnswerInSpec({
				storyId: input.storyId,
				projectId: input.projectId,
				tenantFilter,
				lastEditedByName: context.user.name ?? null,
				question:
					root.content?.trim() ||
					root.summary?.trim() ||
					"Resolved decision",
				answer: input.answer,
			});
		} catch (err) {
			specUpdated = false;
			logger.error(
				{ err, storyId: input.storyId, decisionId: amended.id },
				"amendAnswer: Clean Spec appendix update failed; amendment stands",
			);
		}

		return {
			decision: {
				id: amended.id,
				status: amended.status,
				summary: amended.summary,
				content: amended.content,
				questionId: amended.questionId,
				createdAt: amended.createdAt,
				supersedesId: amended.supersedesId,
				authorName: amended.authorName,
			},
			specUpdated,
		};
	});
