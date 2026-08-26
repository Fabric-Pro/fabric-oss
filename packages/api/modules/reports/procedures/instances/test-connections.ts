import { ORPCError } from "@orpc/server";
import { db, getTemplateInstance } from "@repo/database";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import type { McpServerDiagnostic } from "@repo/temporal/report-diagnostics";
import {
	classifyConnectionError,
	classifyToolOutcome,
	deriveProviders,
	isReadOnlyTool,
	redactMessage,
} from "@repo/temporal/report-diagnostics";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

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
const testConnectionsOutputSchema = z.object({
	diagnostics: z.array(diagnosticSchema),
});

/**
 * Pre-flight: connect to the instance's bound MCP configs and report per-server
 * read-only-tool availability WITHOUT running a full report. Lets a user verify
 * (or repair) connections before triggering an expensive generation.
 *
 * Uses the SAME shared helpers (deriveProviders / classifyToolOutcome /
 * classifyConnectionError) as the actual generation run, so the pre-flight and
 * the run can't disagree about a server's outcome.
 *
 * AUTHORIZATION: tenantProtectedProcedure + REPORT_EXECUTE — this opens live
 * outbound MCP connections (network egress, possible token refresh), matching
 * the bar of `execute`, the only other report op that touches MCP servers.
 * Forwards organizationId to every MCP call so tenant-isolated configs resolve.
 */
export const testInstanceConnectionsProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_EXECUTE))
	.input(testConnectionsInputSchema)
	.output(testConnectionsOutputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
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

		const connections = (instance.connections ?? {}) as {
			mcpConfigs?: string[];
		};
		const definition = (instance.template?.definition ?? {}) as {
			dataSources?: Array<{
				provider?: string;
				config?: { mcpServerKey?: string };
			}>;
		};
		const providers = deriveProviders(definition.dataSources);

		const configIds = Array.isArray(connections.mcpConfigs)
			? connections.mcpConfigs
			: [];

		// Friendly-name fallback for connections that fail before the server
		// identifies itself (otherwise the UI shows a raw config id).
		const displayRows = configIds.length
			? await db.mCPConfig.findMany({
					// TENANT ISOLATION (SOC 2 CC6.1): scope the display-name
					// lookup to the caller's tenant so a stray/foreign configId
					// can never surface another tenant's config/server names.
					where: {
						id: { in: configIds },
						...(organizationId
							? { organizationId }
							: {
									userId: context.user.id,
									organizationId: null,
								}),
					},
					select: {
						id: true,
						displayName: true,
						mcpServer: { select: { name: true } },
					},
				})
			: [];
		const displayNames: Record<string, string> = {};
		for (const r of displayRows) {
			const name = r.displayName || r.mcpServer?.name;
			if (name) {
				displayNames[r.id] = name;
			}
		}

		// Probe every config concurrently — independent network round trips, each
		// with its own connection timeout. Sequential probing made one slow/dead
		// server block all the others (N x timeout latency on a user-facing call).
		const diagnostics = await Promise.all(
			configIds.map(async (configId): Promise<McpServerDiagnostic> => {
				try {
					const result = await getCachedMcpClientForConfig({
						configId,
						userId: context.user.id,
						organizationId: organizationId ?? undefined,
					});
					const serverName =
						result.serverName || displayNames[configId] || configId;
					const allTools = await result.client.tools();
					const total = Object.keys(allTools).length;
					let readOnly = 0;
					for (const toolName of Object.keys(allTools)) {
						if (isReadOnlyTool(toolName, providers)) {
							readOnly++;
						}
					}
					return {
						configId,
						serverName,
						outcome: classifyToolOutcome(total, readOnly),
						toolCount: total,
						readOnlyToolCount: readOnly,
					};
				} catch (error) {
					const raw =
						error instanceof Error ? error.message : String(error);
					const serverName =
						(error as { serverName?: string })?.serverName ||
						displayNames[configId] ||
						configId;
					return {
						configId,
						serverName,
						outcome: classifyConnectionError(error),
						toolCount: 0,
						readOnlyToolCount: 0,
						errorMessage: redactMessage(raw),
					};
				}
			}),
		);

		return { diagnostics };
	});
