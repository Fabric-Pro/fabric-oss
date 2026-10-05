import { ORPCError } from "@orpc/server";
import {
	db,
	isShareableIntegrationProvider,
	workflowIntegrationAccessWhere,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { setIntegrationUsageScope } from "../../lib/integration-sharing";

export const listIntegrationSharingProcedure = tenantProtectedProcedure
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			provider: z.string().optional(),
		}),
	)
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "An organization is required",
			});
		}
		const member = await db.member.findFirst({
			where: { organizationId, userId: context.user.id },
			select: { role: true },
		});
		if (!member) {
			throw new ORPCError("FORBIDDEN", {
				message: "Organization membership is required",
			});
		}
		const admin = member.role === "owner" || member.role === "admin";
		const connections = await db.workflowIntegration.findMany({
			where: {
				...workflowIntegrationAccessWhere(
					context.user.id,
					organizationId,
				),
			},
			select: {
				id: true,
				userId: true,
				provider: true,
				name: true,
				usageScope: true,
				isActive: true,
			},
			orderBy: { createdAt: "desc" },
		});
		return {
			connections: connections
				.filter(
					(row) => !input.provider || row.provider === input.provider,
				)
				.map((row) => ({
					id: row.id,
					provider: row.provider,
					name: row.name,
					usageScope: row.usageScope,
					ownedByCaller: row.userId === context.user.id,
					canShare:
						row.userId === context.user.id &&
						admin &&
						row.isActive &&
						isShareableIntegrationProvider(row.provider),
					canRevoke: row.userId === context.user.id || admin,
					// Personal to its owner by design (GitLab): never shareable.
					personalOnly: !isShareableIntegrationProvider(row.provider),
				})),
		};
	});

export const setIntegrationUsageScopeProcedure = tenantProtectedProcedure
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			integrationId: z.string(),
			usageScope: z.enum(["OWNER_ONLY", "ORGANIZATION_SHARED"]),
		}),
	)
	// Every current member may withdraw consent for their own connection,
	// including viewers. The transactional policy separately authorizes sharing
	// and administrator revocation, so an admin-only gate here would block owners
	// who have been demoted from withdrawing their consent.
	.use(
		requireInputOrgPermission(Permissions.ORG_INTEGRATIONS_READ, {
			requireOrganization: true,
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message: "An organization is required",
			});
		}
		return setIntegrationUsageScope(
			{ ...input, organizationId },
			context.user,
		);
	});
