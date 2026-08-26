/**
 * MCP Data Source Handler
 *
 * Handles data fetching from MCP servers for report templates.
 * Uses the existing MCP tool execution infrastructure.
 */

import { getMcpConfigByIdInternal } from "@repo/database";
import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import type {
	DataSourceDefinition,
	DataSourceHandler,
	FetchContext,
	FetchResult,
	InstanceConnections,
} from "../types";

export class McpDataSourceHandler implements DataSourceHandler {
	type = "mcp" as const;
	supportedProviders = [
		"github",
		"linear",
		"jira",
		"notion",
		"fizzy",
		"confluence",
		"asana",
		"trello",
		"azure_devops",
	];

	async validateConnection(
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		_userId: string,
		_organizationId?: string,
	): Promise<{ valid: boolean; error?: string }> {
		// Check for explicit binding first
		const mcpConfigId = connections.mcpBindings?.[dataSource.id];

		if (!mcpConfigId) {
			// Check legacy mcpConfigs array
			if (!connections.mcpConfigs?.length) {
				return {
					valid: false,
					error: `No MCP server configured for data source "${dataSource.id}". Please select an MCP server in the instance configuration.`,
				};
			}
			// Legacy mode - we have some configs but no explicit binding
			console.log(
				`[McpHandler] Using legacy mcpConfigs for ${dataSource.id}, explicit binding recommended`,
			);
		}

		// Verify MCP config exists and is accessible
		const configId = mcpConfigId || connections.mcpConfigs?.[0];
		if (configId) {
			try {
				// Use internal version - authorization was already done at API layer before starting workflow
				const config = await getMcpConfigByIdInternal(configId);
				if (!config) {
					return {
						valid: false,
						error: `MCP server configuration ${configId} not found`,
					};
				}
				if (!config.enabled) {
					return {
						valid: false,
						error: `MCP server "${config.displayName || config.mcpServer?.name}" is disabled`,
					};
				}
				if (config.status === "UNAVAILABLE") {
					return {
						valid: false,
						error: `MCP server "${config.displayName || config.mcpServer?.name}" is unavailable`,
					};
				}
			} catch (error) {
				return {
					valid: false,
					error: `Failed to validate MCP config: ${error instanceof Error ? error.message : "Unknown error"}`,
				};
			}
		}

		return { valid: true };
	}

	async fetchData(
		dataSource: DataSourceDefinition,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		const startTime = Date.now();

		// Get MCP config ID
		const mcpConfigId =
			connections.mcpBindings?.[dataSource.id] ||
			connections.mcpBindings?.[dataSource.provider] ||
			connections.mcpConfigs?.[0];

		if (!mcpConfigId) {
			return {
				success: false,
				data: [],
				recordCount: 0,
				hasMore: false,
				metadata: {
					provider: dataSource.provider,
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
				},
				error: `No MCP config found for data source "${dataSource.id}"`,
			};
		}

		// Get resource binding if any
		const resourceBinding =
			connections.resourceBindings?.[dataSource.id] ||
			connections.resourceBindings?.[dataSource.provider];

		// Get parameter bindings for this specific data source
		const parameterBinding =
			connections.parameterBindings?.[dataSource.id] ||
			connections.parameterBindings?.[dataSource.provider];

		// Build tool arguments
		// Priority: config.args < context.parameters < parameterBindings (most specific wins)
		const toolArgs: Record<string, unknown> = {
			...(dataSource.config.args || {}),
			...context.parameters,
			...(parameterBinding || {}),
		};

		// Add resource binding to args
		if (resourceBinding) {
			const resourceType = resourceBinding.resourceType.toLowerCase();
			// Add as both {type}Id and {type} for compatibility
			toolArgs[`${resourceType}Id`] = resourceBinding.resourceId;
			toolArgs[resourceType] = resourceBinding.resourceId;
			if (resourceBinding.resourceName) {
				toolArgs[`${resourceType}Name`] = resourceBinding.resourceName;
			}
		}

		// Add date range if provided
		if (context.dateRange) {
			toolArgs.startDate = context.dateRange.start;
			toolArgs.endDate = context.dateRange.end;
			// Also add as oldest/latest for Slack-style APIs
			toolArgs.oldest = this.dateToUnixTimestamp(context.dateRange.start);
			toolArgs.latest = this.dateToUnixTimestamp(context.dateRange.end);
		}

		// Add limit if configured
		if (dataSource.config.limit) {
			toolArgs.limit = dataSource.config.limit;
			toolArgs.per_page = dataSource.config.limit;
		}

		console.log("[McpHandler] Executing MCP tool", {
			dataSourceId: dataSource.id,
			provider: dataSource.provider,
			operation: dataSource.operation,
			mcpConfigId,
			hasResourceBinding: !!resourceBinding,
			hasParameterBinding: !!parameterBinding,
			parameterBindingValues: parameterBinding || {},
			toolArgKeys: Object.keys(toolArgs),
			toolArgValues: toolArgs,
		});

		try {
			const result = await executeMcpTool({
				toolName: dataSource.operation,
				args: toolArgs,
				userId: context.userId,
				organizationId: context.organizationId,
				mcpConfigId,
			});

			const durationMs = Date.now() - startTime;

			if (!result.success) {
				console.error("[McpHandler] MCP tool execution failed", {
					dataSourceId: dataSource.id,
					error: result.output,
				});
				return {
					success: false,
					data: [],
					recordCount: 0,
					hasMore: false,
					metadata: {
						provider: dataSource.provider,
						operation: dataSource.operation,
						fetchedAt: new Date().toISOString(),
					},
					error: String(result.output),
				};
			}

			// Normalize output to array
			const data = this.normalizeToArray(result.output);
			const latestTimestamp = this.extractLatestTimestamp(data);

			console.log("[McpHandler] MCP tool execution successful", {
				dataSourceId: dataSource.id,
				recordCount: data.length,
				durationMs,
			});

			return {
				success: true,
				data,
				recordCount: data.length,
				hasMore: false, // MCP tools don't typically support pagination
				metadata: {
					provider: dataSource.provider,
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
					latestTimestamp,
				},
			};
		} catch (error) {
			console.error("[McpHandler] Exception during MCP tool execution", {
				dataSourceId: dataSource.id,
				error: error instanceof Error ? error.message : "Unknown error",
			});
			return {
				success: false,
				data: [],
				recordCount: 0,
				hasMore: false,
				metadata: {
					provider: dataSource.provider,
					operation: dataSource.operation,
					fetchedAt: new Date().toISOString(),
				},
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	async fetchIncremental(
		dataSource: DataSourceDefinition,
		lastTimestamp: string,
		connections: InstanceConnections,
		context: FetchContext,
	): Promise<FetchResult> {
		// For incremental, modify the context to include date range from lastTimestamp
		const incrementalContext: FetchContext = {
			...context,
			dateRange: {
				start: lastTimestamp,
				end: new Date().toISOString(),
			},
		};

		return this.fetchData(dataSource, connections, incrementalContext);
	}

	private normalizeToArray(output: unknown): unknown[] {
		if (Array.isArray(output)) {
			return output;
		}

		// Handle common response structures
		if (output && typeof output === "object") {
			const obj = output as Record<string, unknown>;
			// Check for common array properties
			const arrayKeys = [
				"items",
				"data",
				"results",
				"messages",
				"issues",
				"nodes",
				"records",
				"entries",
				"cards",
				"columns",
			];
			for (const key of arrayKeys) {
				if (Array.isArray(obj[key])) {
					return obj[key] as unknown[];
				}
			}
		}

		// Wrap single item in array
		return output ? [output] : [];
	}

	private extractLatestTimestamp(data: unknown[]): string | undefined {
		if (data.length === 0) {
			return undefined;
		}

		// Try common timestamp fields
		const timestampFields = [
			"ts",
			"timestamp",
			"created_at",
			"createdAt",
			"updated_at",
			"updatedAt",
			"date",
		];

		for (const item of data) {
			if (item && typeof item === "object") {
				const obj = item as Record<string, unknown>;
				for (const field of timestampFields) {
					const value = obj[field];
					if (value) {
						// Handle Slack-style timestamps (Unix float as string)
						if (
							typeof value === "string" &&
							/^\d+\.\d+$/.test(value)
						) {
							return new Date(
								Number.parseFloat(value) * 1000,
							).toISOString();
						}
						// Handle ISO strings or dates
						if (
							typeof value === "string" ||
							value instanceof Date
						) {
							const date = new Date(value as string | Date);
							if (!Number.isNaN(date.getTime())) {
								return date.toISOString();
							}
						}
					}
				}
			}
		}

		return undefined;
	}

	private dateToUnixTimestamp(date: string): string {
		return String(new Date(date).getTime() / 1000);
	}
}
