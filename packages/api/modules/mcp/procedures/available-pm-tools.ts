import { listAvailablePmTools } from "@repo/database";
import {
	inspectGitLabPersonalConnection,
	readGitLabPersonalConnection,
} from "@repo/integrations/gitlab";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { authorizeGitLabTenant } from "../../integrations/lib/gitlab-request-tenant";

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
	 * True iff the wizard is in org context, GitLab is not usable in this
	 * organization, and the caller's personal-scope GitLab connection is.
	 * Surfaces a "connect for this org" CTA in the picker.
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
		// The organization resolves as on every other GitLab screen (input,
		// else a guest write organization, else session; an explicit null
		// suppresses only the session fallback) and the caller's
		// membership and role are checked there before the GitLab read below,
		// which can classify (write) a legacy connection row in this tenant.
		// No organization is refused: the project wizard runs in one.
		const { userId, organizationId } = await authorizeGitLabTenant(
			Permissions.MCP_READ,
			input.organizationId,
			context,
		);
		// GitLab's status comes from the GitLab connection service — the
		// same read every other GitLab screen uses — and is handed to the
		// query, which cannot import that service. The personal-scope hint
		// is read without adoption, so an org-context request never writes
		// to the caller's personal-scope rows.
		const [{ summary }, personalScope] = await Promise.all([
			readGitLabPersonalConnection({ userId, organizationId }),
			inspectGitLabPersonalConnection({ userId, organizationId: null }),
		]);
		return await listAvailablePmTools({
			userId,
			organizationId,
			gitlab: {
				state: summary.state,
				personalScopeConnected: personalScope.state === "connected",
			},
		});
	});
