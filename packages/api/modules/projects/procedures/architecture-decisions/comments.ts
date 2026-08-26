import { ORPCError } from "@orpc/client";
import {
	createArchitectureDecisionComment,
	db,
	hasProjectAccess,
	listArchitectureDecisionComments,
} from "@repo/database";
import { z } from "zod";
import { emitActivity } from "../../../../lib/realtime";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/** Verify the decision exists (and is not soft-deleted) within the project. */
async function assertDecision(projectId: string, id: string) {
	const decision = await db.architectureDecision.findFirst({
		where: { id, projectId, deletedAt: null },
		select: { id: true, title: true, currentVersion: true },
	});
	if (!decision) {
		throw new ORPCError("NOT_FOUND", {
			message: "Architecture decision not found",
		});
	}
	return decision;
}

export const listArchitectureDecisionCommentsProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.COMMENT_READ))
		.route({
			method: "GET",
			path: "/projects/{projectId}/architecture-decisions/{architectureDecisionId}/comments",
			tags: ["Projects", "Architecture Decisions", "Comments"],
			summary: "List architecture decision comments",
		})
		.input(
			z.object({
				projectId: z.string(),
				architectureDecisionId: z.string(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const organizationId = resolveOrganizationId(
				input.organizationId,
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

			await assertDecision(input.projectId, input.architectureDecisionId);

			const comments = await listArchitectureDecisionComments({
				architectureDecisionId: input.architectureDecisionId,
				organizationId,
			});
			return { comments };
		});

export const createArchitectureDecisionCommentProcedure =
	tenantProtectedProcedure
		.use(requireProjectPermission(Permissions.COMMENT_CREATE))
		.route({
			method: "POST",
			path: "/projects/{projectId}/architecture-decisions/{architectureDecisionId}/comments",
			tags: ["Projects", "Architecture Decisions", "Comments"],
			summary: "Create an architecture decision comment",
		})
		.input(
			z.object({
				projectId: z.string(),
				architectureDecisionId: z.string(),
				content: z.string().min(1).max(10_000),
				parentId: z.string().nullable().optional(),
				organizationId: z.string().nullable().optional(),
			}),
		)
		.handler(async ({ input, context }) => {
			const user = context.user;
			const organizationId = resolveOrganizationId(
				input.organizationId,
				context.session,
			);
			const canAccess = await hasProjectAccess(
				input.projectId,
				user.id,
				organizationId,
			);
			if (!canAccess) {
				throw new ORPCError("FORBIDDEN", {
					message: "You don't have access to this project",
				});
			}

			const decision = await assertDecision(
				input.projectId,
				input.architectureDecisionId,
			);

			const comment = await createArchitectureDecisionComment({
				architectureDecisionId: input.architectureDecisionId,
				authorId: user.id,
				content: input.content,
				parentId: input.parentId,
				decisionVersion: decision.currentVersion,
				organizationId,
			});

			await emitActivity({
				projectId: input.projectId,
				userId: user.id,
				userName: user.name || user.email || "Anonymous",
				activityType: "architecture_decision_commented",
				resourceType: "architecture_decision",
				resourceId: input.architectureDecisionId,
				resourceName: decision.title,
				timestamp: new Date().toISOString(),
			});

			return { comment };
		});
