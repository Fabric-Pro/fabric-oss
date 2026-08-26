import { getAvailableMcpConfigsForKeys } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Get available MCP configs matching required server keys
 * Returns all configs (system + custom) that match by key, server name, or config name
 * Allows users to select which config to use for an agent
 */
export const getAvailableConfigsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.MCP_READ))
	.route({
		method: "POST",
		path: "/mcp/available-configs",
		tags: ["MCP"],
		summary: "Get available MCP configs matching required server keys",
	})
	.input(
		z.object({
			keys: z.array(z.string()),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.array(
			z.object({
				key: z.string(),
				configs: z.array(
					z.object({
						configId: z.string(),
						configName: z.string(),
						serverId: z.string().nullable(),
						serverName: z.string().nullable(),
						serverKey: z.string().nullable(),
						isSystemServer: z.boolean(),
						iconUrl: z.string().nullable(),
					}),
				),
			}),
		),
	)
	.handler(async ({ input, context }) => {
		return await getAvailableMcpConfigsForKeys({
			keys: input.keys,
			userId: context.user.id,
			organizationId: input.organizationId ?? null,
		});
	});
