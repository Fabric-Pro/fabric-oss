import { listAvailablePmTools } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const pmToolOptionSchema = z.object({
	key: z.string(),
	displayName: z.string(),
	iconKey: z.string(),
	isDefault: z.boolean(),
	isConfigured: z.boolean(),
	mcpServerId: z.string(),
	mcpConfigId: z.string().nullable(),
	configDisplayName: z.string().nullable(),
	transport: z.enum(["mcp", "rest"]).nullable(),
	/**
	 * True iff the wizard is in org context AND the calling user has a
	 * personal-scope GitLab integration but no org-scoped one. Surfaces
	 * a "connect for this org" CTA in the picker.
	 */
	connectedInPersonalScope: z.boolean().optional(),
});

/**
 * List PM tools available to the calling tenant for the project setup
 * wizard.
 *
 * Returns the union of platform defaults (Fizzy, Azure DevOps, Jira)
 * and the tenant's enabled MCPConfigs in the "Project Management"
 * category — deduplicated by `MCPServer.key`. Defaults always render
 * regardless of MCPConfig presence.
 *
 * Tenant isolation is enforced via `tenantProtectedProcedure`'s
 * tenant-context middleware. The optional `organizationId` input
 * mirrors `mcp.configs.list` so the wizard can pass its resolved
 * `effectiveOrgId` explicitly.
 */
export const listAvailablePmToolsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.MCP_READ))
	.route({
		method: "POST",
		path: "/mcp/available-pm-tools",
		tags: ["MCP"],
		summary: "List available PM tools for the project setup wizard",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.array(pmToolOptionSchema))
	.handler(async ({ input, context }) => {
		return await listAvailablePmTools({
			userId: context.user.id,
			organizationId: input.organizationId ?? null,
		});
	});
