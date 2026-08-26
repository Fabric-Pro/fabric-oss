/**
 * OAuth Integration Tool Ingestion Activity
 *
 * Ingests OAuth integration tools (Microsoft Teams, GitHub) into Qdrant for:
 * - Semantic search across all tools
 * - Fast loading from cache
 * - Consistent filtering with MCP tools
 * - Version-based synchronization
 *
 * Flow:
 * 1. Load tool definitions from @repo/mcp-registry
 * 2. Generate embeddings for semantic search
 * 3. Store in Qdrant with version metadata
 * 4. Auto-sync when registry version changes
 */

import { AIProviderNotConfiguredError, getRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import {
	type AccountDefinition,
	GITHUB_ACCOUNT,
	MICROSOFT_TEAMS_ACCOUNT,
} from "@repo/mcp-registry";
import { generateEmbeddings } from "@repo/rag/lib/embedding";
import type { CapabilityPoint } from "@repo/rag/lib/vector-store/capability-store";
import {
	deleteCapabilitiesByConfigId,
	upsertCapabilities,
} from "@repo/rag/lib/vector-store/capability-store";
import { Context } from "@temporalio/activity";

export interface IngestOAuthToolsInput {
	/** WorkflowIntegration ID */
	integrationId: string;
	/** Provider type (MICROSOFT_GRAPH or GITHUB) */
	provider: "MICROSOFT_GRAPH" | "GITHUB";
	/** User ID */
	userId: string;
	/** Organization ID (optional) */
	organizationId?: string;
}

export interface IngestOAuthToolsOutput {
	success: boolean;
	toolCount: number;
	accountName: string;
	version: string;
	error?: string;
}

export interface IngestOAuthServerInput {
	/** WorkflowIntegration ID */
	integrationId: string;
	/** Provider type (MICROSOFT_GRAPH or GITHUB) */
	provider: "MICROSOFT_GRAPH" | "GITHUB";
	/** User ID */
	userId: string;
	/** Organization ID (optional) */
	organizationId?: string;
}

export interface IngestOAuthServerOutput {
	success: boolean;
	accountName: string;
	configId: string;
	error?: string;
}

/**
 * Get account definition by provider type
 */
function getAccountByProvider(
	provider: "MICROSOFT_GRAPH" | "GITHUB",
): AccountDefinition {
	switch (provider) {
		case "MICROSOFT_GRAPH":
			return MICROSOFT_TEAMS_ACCOUNT;
		case "GITHUB":
			return GITHUB_ACCOUNT;
		default:
			throw new Error(`Unknown provider: ${provider}`);
	}
}

/**
 * Ingest OAuth integration tools into Qdrant
 */
export async function ingestOAuthIntegrationToolsActivity(
	input: IngestOAuthToolsInput,
): Promise<IngestOAuthToolsOutput> {
	const { integrationId, provider, userId, organizationId } = input;

	logger.info("[OAuth Tool Ingestion] Starting ingestion", {
		integrationId,
		provider,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		// Verify integration exists and belongs to user
		const integration = await db.workflowIntegration.findUnique({
			where: { id: integrationId },
		});

		if (!integration) {
			return {
				success: false,
				toolCount: 0,
				accountName: provider,
				version: "0.0.0",
				error: `Integration not found: ${integrationId}`,
			};
		}

		// Verify ownership
		if (organizationId) {
			if (integration.organizationId !== organizationId) {
				return {
					success: false,
					toolCount: 0,
					accountName: provider,
					version: "0.0.0",
					error: "Integration does not belong to this organization",
				};
			}
		} else if (integration.userId !== userId) {
			return {
				success: false,
				toolCount: 0,
				accountName: provider,
				version: "0.0.0",
				error: "Integration does not belong to this user",
			};
		}

		// Get account definition from registry
		const account = getAccountByProvider(provider);
		const version = account.version || "1.0.0";

		logger.info("[OAuth Tool Ingestion] Loading tools from registry", {
			accountName: account.name,
			version,
		});

		// Collect all tools from all MCPs in this account
		const toolDescriptions: string[] = [];
		const toolSchemas: Array<{
			name: string;
			description: string;
			inputSchema: Record<string, unknown>;
			serverName: string;
			mcpId: string;
		}> = [];

		for (const mcp of account.mcps) {
			if (mcp.available === false) {
				continue;
			}

			const serverName = mcp.serverName || mcp.name;

			if (mcp.tools) {
				for (const tool of mcp.tools) {
					const toolName = `${serverName}__${tool.name}`;
					const description =
						tool.description ||
						`${tool.name} tool from ${serverName}`;

					toolDescriptions.push(`${toolName}: ${description}`);
					toolSchemas.push({
						name: toolName,
						description,
						inputSchema: tool.inputSchema || { type: "object" },
						serverName,
						mcpId: mcp.id,
					});
				}
			}
		}

		if (toolSchemas.length === 0) {
			logger.info("[OAuth Tool Ingestion] No tools found in registry", {
				accountName: account.name,
			});
			return {
				success: true,
				toolCount: 0,
				accountName: account.name,
				version,
			};
		}

		logger.info("[OAuth Tool Ingestion] Collected tools from registry", {
			accountName: account.name,
			toolCount: toolSchemas.length,
		});

		// Send heartbeat after collecting tools
		Context.current().heartbeat();

		// Get AI provider config for embeddings
		const effectiveUserId = userId || integration.userId;
		if (!effectiveUserId) {
			return {
				success: false,
				toolCount: 0,
				accountName: account.name,
				version,
				error: "No user ID available for AI provider lookup",
			};
		}

		const effectiveOrgId =
			organizationId || integration.organizationId || undefined;

		let providerConfig:
			| Awaited<ReturnType<typeof getRAGProviderConfig>>
			| undefined;
		try {
			providerConfig = await getRAGProviderConfig({
				userId: effectiveUserId,
				organizationId: effectiveOrgId,
			});
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				return {
					success: false,
					toolCount: 0,
					accountName: account.name,
					version,
					error: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
				};
			}
			throw error;
		}

		logger.info(
			"[OAuth Tool Ingestion] Using centralized AI provider config for embeddings",
		);

		// Send heartbeat before generating embeddings
		Context.current().heartbeat();

		// Generate embeddings for all tools
		const embeddingResult = await generateEmbeddings(
			toolDescriptions,
			{ userId: effectiveUserId, organizationId: effectiveOrgId },
			providerConfig,
		);

		// Send heartbeat after generating embeddings
		Context.current().heartbeat();

		if (
			!embeddingResult.embeddings ||
			embeddingResult.embeddings.length !== toolSchemas.length
		) {
			return {
				success: false,
				toolCount: 0,
				accountName: account.name,
				version,
				error: "Failed to generate embeddings for tools",
			};
		}

		// Create capability points for Qdrant
		// Use configId format: oauth:integration:{integrationId}
		// This matches the format used in OrchestratorConfigPanel preferences
		const configId = `oauth:integration:${integrationId}`;

		const capabilityPoints: CapabilityPoint[] = toolSchemas.map(
			(tool, index) => {
				// Tool ID includes userId to make it unique per user's integration
				const toolId = userId
					? `${userId}:${tool.serverName}:${tool.name}`
					: `${tool.serverName}:${tool.name}`;

				return {
					id: toolId,
					type: "mcp_tool" as const,
					name: tool.name,
					description: tool.description,
					embedding: embeddingResult.embeddings[index],
					userId: userId || null,
					organizationId: organizationId || null,
					metadata: {
						serverName: tool.serverName,
						configId,
						version, // Store version for sync checking
						provider: account.id, // Store provider ID (github, microsoft_teams)
						category: "automation", // OAuth tools are typically automation
						riskLevel: "medium", // OAuth tools can modify external data
						isReadOnly: false,
						inputSchema: tool.inputSchema,
						updatedAt: new Date().toISOString(),
					},
				};
			},
		);

		// Delete existing tools for this integration before upserting new ones
		// This ensures clean updates when tools change or version updates
		await deleteCapabilitiesByConfigId(configId, userId, organizationId);

		// Send heartbeat before Qdrant upsert
		Context.current().heartbeat();

		// Upsert to Qdrant
		const result = await upsertCapabilities(capabilityPoints);

		// Send heartbeat after Qdrant upsert
		Context.current().heartbeat();

		logger.info("[OAuth Tool Ingestion] Tool ingestion complete", {
			accountName: account.name,
			version,
			toolCount: result.success,
			failed: result.failed,
		});

		return {
			success: true,
			toolCount: result.success,
			accountName: account.name,
			version,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[OAuth Tool Ingestion] Tool ingestion failed", {
			integrationId,
			provider,
			error: errorMessage,
		});

		return {
			success: false,
			toolCount: 0,
			accountName: provider,
			version: "0.0.0",
			error: errorMessage,
		};
	}
}

/**
 * Ingest OAuth server metadata into Qdrant for semantic routing
 *
 * This enables Phase 1 semantic routing: queries like "schedule a meeting"
 * can semantically match to Microsoft Teams at the server level before
 * searching for specific tools.
 */
export async function ingestOAuthServerActivity(
	input: IngestOAuthServerInput,
): Promise<IngestOAuthServerOutput> {
	const { integrationId, provider, userId, organizationId } = input;

	logger.info("[OAuth Server Ingestion] Starting server ingestion", {
		integrationId,
		provider,
		userId: userId ? `${userId.slice(0, 8)}...` : undefined,
		organizationId,
	});

	try {
		// Verify integration exists and belongs to user
		const integration = await db.workflowIntegration.findUnique({
			where: { id: integrationId },
		});

		if (!integration) {
			return {
				success: false,
				accountName: provider,
				configId: `oauth:integration:${integrationId}`,
				error: `Integration not found: ${integrationId}`,
			};
		}

		// Verify ownership
		if (organizationId) {
			if (integration.organizationId !== organizationId) {
				return {
					success: false,
					accountName: provider,
					configId: `oauth:integration:${integrationId}`,
					error: "Integration does not belong to this organization",
				};
			}
		} else if (integration.userId !== userId) {
			return {
				success: false,
				accountName: provider,
				configId: `oauth:integration:${integrationId}`,
				error: "Integration does not belong to this user",
			};
		}

		// Get account definition from registry
		const account = getAccountByProvider(provider);
		const configId = `oauth:integration:${integrationId}`;

		// Build server description from account metadata
		// Combine account name, MCP descriptions, and workflow guidance
		const mcpDescriptions = account.mcps
			.filter((mcp) => mcp.available !== false && mcp.description)
			.map((mcp) => mcp.description)
			.join(". ");

		const serverDescription = `${account.name}: ${mcpDescriptions}`;

		// Extract domain keywords from tool names and descriptions
		const domainKeywords = new Set<string>();
		for (const mcp of account.mcps) {
			if (mcp.available === false) {
				continue;
			}

			// Add keywords from MCP description
			if (mcp.description) {
				const words = mcp.description
					.toLowerCase()
					.split(/\W+/)
					.filter(
						(word) =>
							word.length > 3 &&
							!["this", "that", "with"].includes(word),
					);
				for (const word of words) {
					domainKeywords.add(word);
				}
			}

			// Add keywords from tool names
			if (mcp.tools) {
				for (const tool of mcp.tools) {
					const toolWords = tool.name
						.split(/[_-]/)
						.filter((word) => word.length > 2);
					for (const word of toolWords) {
						domainKeywords.add(word.toLowerCase());
					}
				}
			}
		}

		// Build example queries from workflow guidance if available
		const exampleQueries: string[] = [];
		for (const mcp of account.mcps) {
			if (
				mcp.workflowGuidance &&
				typeof mcp.workflowGuidance === "object" &&
				"exampleQueries" in mcp.workflowGuidance
			) {
				const guidance = mcp.workflowGuidance as {
					exampleQueries?: string[];
				};
				if (Array.isArray(guidance.exampleQueries)) {
					exampleQueries.push(...guidance.exampleQueries);
				}
			}
		}

		// Create searchable text combining description, keywords, and examples
		const searchableText = [
			serverDescription,
			Array.from(domainKeywords).join(" "),
			...exampleQueries,
		].join(" ");

		// Get AI provider config for embeddings
		const effectiveUserId = userId || integration.userId;
		if (!effectiveUserId) {
			return {
				success: false,
				accountName: account.name,
				configId,
				error: "No user ID available for AI provider lookup",
			};
		}

		const effectiveOrgId =
			organizationId || integration.organizationId || undefined;

		let providerConfig:
			| Awaited<ReturnType<typeof getRAGProviderConfig>>
			| undefined;
		try {
			providerConfig = await getRAGProviderConfig({
				userId: effectiveUserId,
				organizationId: effectiveOrgId,
			});
		} catch (error) {
			if (error instanceof AIProviderNotConfiguredError) {
				return {
					success: false,
					accountName: account.name,
					configId,
					error: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
				};
			}
			throw error;
		}

		logger.info(
			"[OAuth Server Ingestion] Using centralized AI provider config for embeddings",
		);

		// Send heartbeat before generating embeddings
		Context.current().heartbeat();

		// Generate embedding for server description
		const embeddingResult = await generateEmbeddings(
			[searchableText],
			{ userId: effectiveUserId, organizationId: effectiveOrgId },
			providerConfig,
		);

		// Send heartbeat after generating embeddings
		Context.current().heartbeat();

		if (
			!embeddingResult.embeddings ||
			embeddingResult.embeddings.length === 0
		) {
			return {
				success: false,
				accountName: account.name,
				configId,
				error: "Failed to generate embedding for server",
			};
		}

		// Create capability point for the server
		// Server ID includes userId to make it unique per user's integration
		const serverId = userId
			? `${userId}:oauth:${account.id}`
			: `oauth:${account.id}`;

		const capabilityPoint: CapabilityPoint = {
			id: serverId,
			type: "mcp_server" as const,
			name: account.name,
			description: serverDescription,
			embedding: embeddingResult.embeddings[0],
			userId: userId || null,
			organizationId: organizationId || null,
			metadata: {
				configId,
				serverName: account.name,
				domainKeywords: Array.from(domainKeywords).slice(0, 20), // Limit to top 20 keywords
				exampleQueries: exampleQueries.slice(0, 5), // Limit to top 5 examples
				updatedAt: new Date().toISOString(),
			},
		};

		// Send heartbeat before Qdrant upsert
		Context.current().heartbeat();

		// Upsert to Qdrant
		const result = await upsertCapabilities([capabilityPoint]);

		// Send heartbeat after Qdrant upsert
		Context.current().heartbeat();

		logger.info("[OAuth Server Ingestion] Server ingestion complete", {
			accountName: account.name,
			configId,
		});

		return {
			success: result.success > 0,
			accountName: account.name,
			configId,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error("[OAuth Server Ingestion] Server ingestion failed", {
			integrationId,
			provider,
			error: errorMessage,
		});

		return {
			success: false,
			accountName: provider,
			configId: `oauth:integration:${integrationId}`,
			error: errorMessage,
		};
	}
}
