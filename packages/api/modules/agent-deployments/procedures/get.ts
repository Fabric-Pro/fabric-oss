/**
 * Get Deployment Procedure
 */

import {
	getAgentDeploymentById,
	getAgentDeploymentBySlug,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const getInputSchema = z
	.object({
		deploymentId: z.string().optional(),
		slug: z.string().optional(),
		organizationId: z.string().nullable().optional(),
	})
	.refine((data) => data.deploymentId || data.slug, {
		message: "Either deploymentId or slug must be provided",
	});

export const getDeploymentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.input(getInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if querying org deployment
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

		// biome-ignore lint/suspicious/noImplicitAnyLet: type inferred from two different query functions — union would be overly complex
		let deployment;

		if (input.deploymentId) {
			deployment = await getAgentDeploymentById(input.deploymentId, {
				userId,
				organizationId,
			});
		} else if (input.slug) {
			deployment = await getAgentDeploymentBySlug(input.slug, {
				userId,
				organizationId,
			});
		}

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		return { deployment };
	});
