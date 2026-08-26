/**
 * Execute MCP Tool Procedure
 *
 * Directly executes an MCP tool with the provided arguments.
 * This enables custom UI components to call MCP tools without going through CopilotKit.
 *
 * SECURITY: Always validates tenant context and verifies the user has access to the MCP config.
 */

import { getMcpConfigById } from "@repo/database";
import {
	callMcpTool,
	closeMcpClient,
	createMcpClientForConfig,
	type McpClientType,
} from "@repo/mcp";
import {
	isReadOnlyBlockedOutput,
	READ_ONLY_MODE_ERROR_CODE,
	READ_ONLY_MODE_MESSAGE,
} from "@repo/utils";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const executeToolProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.MCP_CONNECT))
	.route({
		method: "POST",
		path: "/mcp/tools/execute",
		tags: ["MCP"],
		summary: "Execute an MCP tool",
		description:
			"Execute an MCP tool directly with the provided arguments. Validates tenant context and user permissions.",
	})
	.input(
		z.object({
			configId: z
				.string()
				.describe("The MCP configuration ID to execute the tool on"),
			toolName: z.string().describe("The name of the tool to execute"),
			args: z
				.record(z.string(), z.unknown())
				.describe("The arguments to pass to the tool"),
			// IMPORTANT: For proper tenant isolation, pass organizationId explicitly:
			// - Pass org ID string when in organization context
			// - Pass null explicitly when in personal context
			// - Only omit (undefined) to fall back to session context
			organizationId: z
				.string()
				.nullable()
				.optional()
				.describe(
					"Organization ID for tenant isolation. Pass null for personal context.",
				),
			// Read-only mode: when this call is made in a project
			// context, pass the project id so a write tool is blocked while the
			// project is read-only. A configId does not map to a project, so it
			// must be supplied explicitly by the caller.
			projectId: z
				.string()
				.optional()
				.describe(
					"Owning project id — enables the Read-only mode write-gate for this call.",
				),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			result: z.unknown().optional(),
			error: z.string().optional(),
			errorCode: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const { configId, toolName, args } = input;

		// Use resolveOrganizationId for proper tenant isolation
		// This handles: explicit string (org context), null (personal context), undefined (session fallback)
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		let mcpClient: McpClientType | undefined;

		try {
			// Verify the config exists and belongs to this tenant
			const mcpConfig = await getMcpConfigById(configId, {
				userId,
				organizationId,
			});

			if (!mcpConfig) {
				return {
					success: false,
					error: "MCP server configuration not found",
					errorCode: "CONFIG_NOT_FOUND",
				};
			}

			const mcpServer = mcpConfig.mcpServer as {
				defaultUrl?: string;
				name?: string;
				transport?: string;
			} | null;

			const serverName =
				mcpConfig.displayName || mcpServer?.name || "Unknown Server";

			if (!mcpConfig.enabled) {
				return {
					success: false,
					error: `MCP server "${serverName}" is disabled`,
					errorCode: "CONFIG_DISABLED",
				};
			}

			console.log(
				`[MCP Tools] Executing tool "${toolName}" on server "${serverName}"`,
			);

			// Create MCP client
			try {
				const clientResult = await createMcpClientForConfig({
					configId,
					userId,
					organizationId,
				});
				mcpClient = clientResult.client;
			} catch (clientError) {
				console.error(
					`[MCP Tools] Failed to create client for ${serverName}:`,
					clientError,
				);

				const errorMessage =
					clientError instanceof Error
						? clientError.message
						: "Failed to connect to MCP server";

				return {
					success: false,
					error: errorMessage,
					errorCode: "CONNECTION_ERROR",
				};
			}

			// Get available tools
			const tools = await mcpClient.tools();

			// Check if the tool exists
			const tool = tools[toolName];
			if (!tool) {
				return {
					success: false,
					error: `Tool "${toolName}" not found on server "${serverName}"`,
					errorCode: "TOOL_NOT_FOUND",
				};
			}

			// Execute the tool
			// The AI SDK tool has an execute function
			const toolAny = tool as unknown as {
				execute?: (args: unknown) => Promise<unknown>;
			};

			const executeTool = toolAny.execute;
			if (!executeTool) {
				return {
					success: false,
					error: `Tool "${toolName}" does not support direct execution`,
					errorCode: "TOOL_NOT_EXECUTABLE",
				};
			}

			// Route through the shared external-dispatch funnel so a
			// write-classified tool is blocked when the project is read-only.
			// `projectId` is explicit here — this procedure is
			// org-scoped, so there is no ambient project context to fall back on.
			const result = await callMcpTool({
				toolName,
				projectId: input.projectId,
				execute: () => executeTool(args),
			});

			if (isReadOnlyBlockedOutput(result)) {
				return {
					success: false,
					error: READ_ONLY_MODE_MESSAGE,
					errorCode: READ_ONLY_MODE_ERROR_CODE,
				};
			}

			console.log(
				`[MCP Tools] Tool "${toolName}" executed successfully on "${serverName}"`,
			);

			return {
				success: true,
				result,
			};
		} catch (err: unknown) {
			console.error(
				`[MCP Tools] Error executing tool "${toolName}":`,
				err,
			);

			// Extract a meaningful error message
			let errorMessage = "Unknown error";
			let errorCode = "EXECUTION_ERROR";

			if (err instanceof Error) {
				errorMessage = err.message;

				// Check for specific error types
				if (
					err.message.includes("401") ||
					err.message.includes("Unauthorized")
				) {
					errorCode = "AUTH_ERROR";
					errorMessage =
						"Authentication failed. Please re-authenticate your MCP server.";
				} else if (err.message.includes("429")) {
					errorCode = "RATE_LIMIT";
					errorMessage =
						"Rate limit exceeded. Please try again later.";
				} else if (err.message.includes("timeout")) {
					errorCode = "TIMEOUT";
					errorMessage = "Tool execution timed out.";
				}
			}

			return {
				success: false,
				error: errorMessage,
				errorCode,
			};
		} finally {
			// Always close the MCP client to clean up resources
			await closeMcpClient(mcpClient);
		}
	});
