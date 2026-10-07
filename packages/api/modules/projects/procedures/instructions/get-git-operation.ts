import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { canReviewInstructionProposals } from "./proposal-authorization";

/** Read a changed-path operation's outcome without treating it as published instruction content. */
export const getGitInstructionOperationProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/repository/operations/:operationId",
		tags: ["Projects", "Instructions"],
		summary: "Read a repository change operation",
	})
	.input(z.object({ projectId: z.string(), operationId: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const canReviewProposals = await canReviewInstructionProposals({
			projectId: input.projectId,
			userId: context.user.id,
		});
		const operation = await getInstructionSnapshot(
			input.operationId,
			input.projectId,
			organizationId,
			{ viewerUserId: context.user.id, canReviewProposals },
		);
		if (!operation || operation.contentKind !== "GIT_INTENT") {
			throw new ORPCError("NOT_FOUND", {
				message: "Repository operation not found",
			});
		}
		return {
			operationId: operation.id,
			status: operation.status,
			commitOutcome: operation.commitOutcome,
			proposalStatus: operation.proposalStatus,
		};
	});
