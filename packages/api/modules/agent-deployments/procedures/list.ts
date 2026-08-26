/**
 * List Deployments Procedure
 */

import {
	type AgentDeploymentStatus,
	listAgentDeployments,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const listInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	status: z
		.enum([
			"PENDING",
			"DEPLOYING",
			"ACTIVE",
			"PAUSED",
			"DEGRADED",
			"FAILED",
			"TERMINATED",
			"ALL",
		])
		.default("ALL"),
	limit: z.number().min(1).max(100).default(20),
	offset: z.number().min(0).default(0),
});

export const listDeploymentsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if querying org deployments
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error(
					"You must be a member of the organization to view deployments",
				);
			}
		}

		// Map status filter
		let statusFilter:
			| AgentDeploymentStatus
			| AgentDeploymentStatus[]
			| undefined;
		if (input.status !== "ALL") {
			statusFilter = input.status as AgentDeploymentStatus;
		}

		const result = await listAgentDeployments({
			userId,
			organizationId,
			status: statusFilter,
			limit: input.limit,
			offset: input.offset,
		});

		return {
			deployments: result.deployments,
			total: result.total,
			limit: input.limit,
			offset: input.offset,
		};
	});
