import { ORPCError } from "@orpc/server";
import { getTemplateInstance } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertReportPermission,
	canEditReportInstance,
	canGenerateReportInstance,
} from "../../lib/report-access";
import { probeReportConnections } from "../../lib/report-connection-test";

const testConnectionsInputSchema = z.object({
	instanceId: z.string(),
	organizationId: z.string().nullable().optional(),
});

// Output schema so the wire shape is validated and typed end-to-end (the UI
// previously had to cast the response, hiding any drift).
const diagnosticSchema = z.object({
	configId: z.string(),
	serverName: z.string(),
	provider: z.string().optional(),
	outcome: z.enum([
		"connected",
		"auth_failed",
		"unreachable",
		"zero_tools",
		"no_read_only_tools",
		"error",
	]),
	toolCount: z.number(),
	readOnlyToolCount: z.number(),
	errorMessage: z.string().optional(),
});
export const testConnectionsOutputSchema = z.object({
	diagnostics: z.array(diagnosticSchema),
});

/**
 * Pre-flight: connect to the instance's bound MCP configs and report per-server
 * read-only-tool availability WITHOUT running a full report. Lets a user verify
 * (or repair) connections before triggering an expensive generation. Every
 * Generate runs the same test (`report-connection-test`) for the report's
 * required data sources before it admits a run.
 *
 * AUTHORIZATION: tenantProtectedProcedure + REPORT_EXECUTE — this opens live
 * outbound MCP connections (network egress, possible token refresh), matching
 * the bar of `execute`, the only other report op that touches MCP servers.
 * Forwards organizationId to every MCP call so tenant-isolated configs resolve.
 * Whoever may generate the report or edit it may test it; someone who only reads
 * it has nothing to repair, and that includes an owner demoted to a Viewer row on
 * the report's project. The middleware only admits members and the handler
 * asks for REPORT_EXECUTE, which a platform admin holds wherever they belong.
 */
export const testInstanceConnectionsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
	.input(testConnectionsInputSchema)
	.output(testConnectionsOutputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_EXECUTE,
		);

		const instance = await getTemplateInstance({
			id: input.instanceId,
			userId: context.user.id,
			organizationId,
		});
		if (!instance) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found or access denied",
			});
		}
		if (
			!(await canGenerateReportInstance(instance, context.user)) &&
			!(await canEditReportInstance(instance, context.user))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"You can read this report, but not test its connections",
			});
		}

		const connections = (instance.connections ?? {}) as {
			mcpConfigs?: string[];
		};
		const configIds = Array.isArray(connections.mcpConfigs)
			? connections.mcpConfigs
			: [];

		const diagnostics = await probeReportConnections(
			configIds,
			instance.template?.definition,
			{ userId: context.user.id, organizationId: organizationId ?? null },
		);

		return { diagnostics };
	});
