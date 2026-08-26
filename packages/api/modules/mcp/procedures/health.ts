import { ORPCError } from "@orpc/client";
import { getMcpConfigByIdInternal, setMcpConfigHealth } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const healthProcedures = {
	update: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "POST",
			path: "/mcp/health",
			tags: ["MCP"],
			summary: "Update MCP config health status",
		})
		.input(
			z.object({
				id: z.string(),
				status: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]),
				failoverUrl: z.string().url().nullable().optional(),
				consecutiveFailures: z.number().int().min(0).optional(),
			}),
		)
		.output(z.any())
		.handler(async ({ input, context }) => {
			const { user } = context;

			// Verify the user has access to this MCP config
			// Use internal version - authorization is done below based on config ownership
			const config = await getMcpConfigByIdInternal(input.id);
			if (!config) {
				throw new ORPCError("NOT_FOUND", {
					message: "MCP configuration not found",
				});
			}

			// Check authorization: user must own the config or be member of the org
			if (config.userId && config.userId !== user.id) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You do not have permission to update this MCP configuration",
				});
			}

			if (config.organizationId) {
				const membership = await verifyOrganizationMembership(
					config.organizationId,
					user.id,
				);
				if (!membership) {
					throw new ORPCError("FORBIDDEN", {
						message:
							"You are not a member of the organization that owns this MCP configuration",
					});
				}
			}

			const rec = await setMcpConfigHealth({
				id: input.id,
				status: input.status,
				failoverUrl: input.failoverUrl ?? null,
				consecutiveFailures: input.consecutiveFailures,
			});
			return rec;
		}),
};
