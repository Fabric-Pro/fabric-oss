/**
 * Quota Procedures
 *
 * Provides endpoints for checking deployment and execution quotas.
 */

import {
	checkDeploymentRateLimit,
	getAgentDeploymentById,
	getQuotaUsageSummary,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// =============================================================================
// GET QUOTA STATUS
// =============================================================================

const getQuotaInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
});

export const getQuotaProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.input(getQuotaInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if checking org quota
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error(
					"You must be a member of the organization to view quota",
				);
			}
		}

		const summary = await getQuotaUsageSummary(
			userId,
			organizationId ?? undefined,
		);

		return { quota: summary };
	});

// =============================================================================
// GET DEPLOYMENT RATE LIMIT STATUS
// =============================================================================

const getDeploymentRateLimitInputSchema = z.object({
	deploymentId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const getDeploymentRateLimitProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.input(getDeploymentRateLimitInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify access
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				userId,
			);
			if (!membership) {
				throw new Error(
					"You don't have permission to view this deployment",
				);
			}
		}

		const deployment = await getAgentDeploymentById(input.deploymentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			throw new Error("Deployment not found");
		}

		const rateLimit = await checkDeploymentRateLimit(input.deploymentId);

		return {
			deploymentId: input.deploymentId,
			rateLimit: {
				allowed: rateLimit.allowed,
				reason: rateLimit.reason,
				limits: rateLimit.limits,
			},
		};
	});
