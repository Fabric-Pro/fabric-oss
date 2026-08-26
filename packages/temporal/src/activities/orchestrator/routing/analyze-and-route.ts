/**
 * Analyze and Route Activity
 *
 * Analyzes user requests and determines the optimal routing strategy
 * for task execution. This includes identifying which agents and MCP
 * tools are best suited to handle the request.
 *
 * REFACTORED: Uses Tool Search Tool pattern for token-efficient routing.
 * Instead of loading all MCP tool definitions upfront (77K+ tokens),
 * we use semantic search to find relevant tools on-demand (~8.7K tokens).
 *
 * Features:
 * - Semantic search for MCP tools, agents, and workflows
 * - User intent detection for explicit capability requests
 * - Multi-tenant isolation (userId, organizationId)
 * - Priority-based routing (MCP > Agent > Workflow > LLM)
 */

import { generateText } from "@repo/ai";
import { db } from "@repo/database";
import type { RoutingDecision } from "../../../workflows/orchestrator/types";
import { getRoutingSystemPrompt } from "../../prompts";
import { getAgentCapabilities } from "../delegation/agent-capabilities";
import {
	detectMissingIntegrations,
	detectRequiredConnectionsWithRegistrySearch,
	fetchToolsFromServerIds,
	getFabricAiTools,
	searchAvailableAgents,
	searchAvailableIntegrations,
	searchAvailableTools,
	searchAvailableWorkflows,
} from "../tools";
import type { AnalyzeAndRouteInput } from "../types";
import { safeParseJson } from "../utils/json-parser";
import { getAiModel } from "../utils/model-selector";
import { detectUserIntent } from "./intent";

export function shouldSearchIntegrations(params: {
	message: string;
	toolResults: Array<{
		confidence: number;
		serverName: string;
		toolName: string;
	}>;
	userIntent: ReturnType<typeof detectUserIntent>;
}): boolean {
	const { message, toolResults, userIntent } = params;
	const messageLower = message.toLowerCase();
	const strongestToolConfidence = toolResults[0]?.confidence ?? 0;

	if (userIntent.requestedWorkflow || userIntent.requestedMcpTools) {
		return true;
	}

	if (strongestToolConfidence < 0.75) {
		return true;
	}

	return [
		"slack",
		"github",
		"teams",
		"microsoft teams",
		"linear",
		"email",
		"resend",
		"webhook",
		"notification",
		"message",
		"firecrawl",
		"perplexity",
	].some((keyword) => messageLower.includes(keyword));
}

/**
 * Analyzes a user's message and determines the best routing strategy.
 *
 * This activity:
 * 1. Detects explicit user intent for capabilities (workspace, workflow, MCP, agent)
 * 2. Uses semantic tool search to find relevant MCP tools (token-efficient)
 * 3. Uses semantic agent search to find relevant agents
 * 4. Searches for matching workflows
 * 5. Uses an LLM to determine the optimal routing
 * 6. Checks if the primary agent is a generalist for complete-task delegation
 */
export async function analyzeAndRoute(
	input: AnalyzeAndRouteInput,
): Promise<RoutingDecision> {
	const routingStartTime = Date.now();
	console.log("[Orchestrator] Analyzing and routing task");

	const model = await getAiModel(input.userId, input.organizationId);

	// ==========================================================================
	// USER INTENT DETECTION
	// Detect explicit user requests for specific capabilities
	// ==========================================================================
	const userIntent = detectUserIntent(input.message);

	if (userIntent.mentionedCapabilities?.length) {
		console.log("[Orchestrator] Detected user intent:", userIntent);
	}

	// ==========================================================================
	// TOKEN-EFFICIENT TOOL DISCOVERY
	// Use semantic search instead of loading all tools upfront
	// Reduces token usage from ~77K to ~8.7K tokens
	// ==========================================================================

	// Search for relevant tools based on the task using semantic search
	// NOTE: We use a higher threshold (0.4) to reduce false positives from semantic search
	// (e.g., "fitness" matching "fizzy", "plan" matching project management tools)
	// Credentials are fetched internally by the search function
	const toolSearchResult = await searchAvailableTools({
		query: input.message,
		limit: 10,
		minConfidence: userIntent.requestedMcpTools ? 0.3 : 0.4, // Higher threshold to reduce false positives
		userId: input.userId,
		organizationId: input.organizationId,
		enabledMcpConfigIds: input.enabledMcpConfigIds,
		enabledIntegrationIds: input.enabledIntegrationIds,
		enabledFabricToolIds: input.enabledFabricToolIds,
		// Semantic search is now the default - uses Qdrant vector search
	});

	// ==========================================================================
	// APPLY EXPLICIT FRAME/SLIDESHOW INTENT BOOSTS
	// When the user explicitly asks for a frame/deck/slideshow, ensure the
	// first-class Fabric frame tools are present with strong confidence.
	// ==========================================================================
	let boostedToolResults = [...toolSearchResult.results];

	if (userIntent.requestedFrameOutput) {
		const requestedToolName =
			userIntent.requestedFrameOutput === "slideshow"
				? "fabric_create_slideshow"
				: "fabric_create_frame";
		const existingToolNames = new Set(
			boostedToolResults.map((tool) => tool.toolName),
		);
		const fabricAiToolMap = new Map(
			getFabricAiTools().map((tool) => [tool.name, tool]),
		);
		const requestedTool = fabricAiToolMap.get(requestedToolName);
		const enabledFabricToolIds = input.enabledFabricToolIds;
		const canUseRequestedTool =
			enabledFabricToolIds == null ||
			enabledFabricToolIds.includes(requestedToolName);
		const explicitlyRequestedExcalidraw = input.message
			.toLowerCase()
			.includes("excalidraw");

		if (
			requestedTool &&
			canUseRequestedTool &&
			!existingToolNames.has(requestedToolName)
		) {
			boostedToolResults.push({
				toolId: requestedToolName,
				toolName: requestedToolName,
				configId: "fabric-ai",
				serverName: "Fabric AI",
				description: requestedTool.description || requestedToolName,
				confidence: 0.9,
				matchReason: `Explicit user request for a ${userIntent.requestedFrameOutput}`,
				riskLevel: "low",
				isReadOnly: false,
				inputSchema: requestedTool.inputSchema,
			});
		}

		boostedToolResults = boostedToolResults
			.map((tool) =>
				tool.toolName === requestedToolName
					? {
							...tool,
							confidence: Math.max(tool.confidence, 0.98),
							matchReason:
								(tool.matchReason || "") +
								" [EXPLICIT FRAME OUTPUT REQUEST]",
						}
					: tool,
			)
			.filter((tool) => {
				if (explicitlyRequestedExcalidraw) {
					return true;
				}
				if (tool.toolName === requestedToolName) {
					return true;
				}
				if (
					tool.serverName === "Fabric AI" &&
					[
						"fabric_create_frame",
						"fabric_create_slideshow",
						"fabric_update_frame",
						"fabric_get_frame",
						"fabric_list_frames",
						"fabric_share_frame",
					].includes(tool.toolName)
				) {
					return true;
				}
				return false;
			});

		boostedToolResults.sort((a, b) => b.confidence - a.confidence);
	}

	// ==========================================================================
	// APPLY PRIORITIZATION BOOSTS
	// User-selected tools/servers get boosted confidence
	// Prioritized tools are GUARANTEED to appear in results with high confidence
	// Prioritized MCP servers have ALL their tools included with elevated confidence
	// ==========================================================================

	if (
		input.prioritizedToolIds?.length ||
		input.prioritizedMcpConfigIds?.length
	) {
		// First, ensure all prioritized tools are in the results
		// They may have been filtered out due to low semantic similarity
		const existingToolNames = new Set(
			boostedToolResults.map((t) => t.toolName),
		);

		// Get Fabric AI tool definitions for schema lookup
		const fabricAiTools = getFabricAiTools();
		const fabricAiToolMap = new Map(fabricAiTools.map((t) => [t.name, t]));

		for (const prioritizedToolId of input.prioritizedToolIds || []) {
			if (!existingToolNames.has(prioritizedToolId)) {
				// Look up the tool definition for schema
				const toolDef = fabricAiToolMap.get(prioritizedToolId);

				// Add the prioritized tool with a base confidence that will be boosted
				// This ensures user-prioritized tools ALWAYS appear in results
				boostedToolResults.push({
					toolId: prioritizedToolId,
					toolName: prioritizedToolId,
					configId: "fabric-ai", // Fabric AI tools
					serverName: "Fabric AI",
					description:
						toolDef?.description ||
						`User prioritized Fabric AI tool: ${prioritizedToolId}`,
					confidence: 0.5, // Base confidence (will be boosted to 0.8)
					matchReason: "User prioritized tool",
					riskLevel: "low",
					isReadOnly: true,
					// CRITICAL: Include inputSchema so planner knows required parameters
					inputSchema: toolDef?.inputSchema,
				});
				console.log(
					`[Orchestrator] Added prioritized tool not in search results: ${prioritizedToolId} (hasSchema: ${!!toolDef?.inputSchema})`,
				);
			}
		}

		// For prioritized MCP servers, fetch ALL their tools directly (bypass semantic search)
		// This ensures that when user prioritizes an MCP server, its tools are always available
		if (input.prioritizedMcpConfigIds?.length) {
			const existingConfigIds = new Set(
				boostedToolResults.map((t) => t.configId),
			);
			const missingServerIds = input.prioritizedMcpConfigIds.filter(
				(id) => !existingConfigIds.has(id),
			);

			if (missingServerIds.length > 0) {
				console.log(
					"[Orchestrator] Fetching ALL tools directly from prioritized MCP servers:",
					missingServerIds,
				);

				// Fetch ALL tools directly from prioritized servers (no semantic search)
				const prioritizedServerTools = await fetchToolsFromServerIds(
					missingServerIds,
					input.userId,
					input.organizationId,
				);

				// Add ALL tools from prioritized servers
				for (const tool of prioritizedServerTools) {
					if (!existingToolNames.has(tool.toolName)) {
						boostedToolResults.push({
							toolId: `${tool.configId}:${tool.toolName}`,
							serverName: tool.serverName,
							toolName: tool.toolName,
							description: tool.description,
							confidence: 0.5, // Base confidence (will be boosted to 0.7 by server priority)
							matchReason: `User prioritized MCP server: ${tool.serverName}`,
							category: "unknown",
							riskLevel: "medium",
							isReadOnly: false,
							configId: tool.configId,
						});
						existingToolNames.add(tool.toolName);
						console.log(
							`[Orchestrator] Added tool from prioritized server: ${tool.toolName} (${tool.serverName})`,
						);
					}
				}

				console.log(
					`[Orchestrator] Added ${prioritizedServerTools.length} tools from prioritized servers`,
				);
			}

			console.log("[Orchestrator] MCP server prioritization complete:", {
				prioritizedMcpConfigIds: input.prioritizedMcpConfigIds,
				toolsFromPrioritizedServers: boostedToolResults
					.filter((t) =>
						input.prioritizedMcpConfigIds?.includes(t.configId),
					)
					.map((t) => t.toolName),
			});
		}

		// Now apply boosts to all tools
		const boostedToolNames: string[] = [];
		boostedToolResults = boostedToolResults.map((t) => {
			let boost = 0;
			let boostReason = "";

			// Boost if tool is directly prioritized
			if (input.prioritizedToolIds?.includes(t.toolName)) {
				boost = 0.3; // 30% boost for prioritized tools
				boostReason = "direct tool priority";
			}
			// Boost if tool's MCP server is prioritized
			else if (
				t.configId &&
				input.prioritizedMcpConfigIds?.includes(t.configId)
			) {
				boost = 0.2; // 20% boost for tools from prioritized servers
				boostReason = `server ${t.configId} priority`;
			}

			if (boost > 0) {
				boostedToolNames.push(
					`${t.toolName} (+${(boost * 100).toFixed(0)}% from ${boostReason})`,
				);
				return {
					...t,
					confidence: Math.min(t.confidence + boost, 1.0),
					matchReason: `${t.matchReason} [PRIORITIZED +${(boost * 100).toFixed(0)}%]`,
				};
			}
			return t;
		});

		// Re-sort by confidence after boosting
		boostedToolResults.sort((a, b) => b.confidence - a.confidence);

		console.log("[Orchestrator] Applied tool prioritization boosts:", {
			prioritizedTools: input.prioritizedToolIds,
			prioritizedServers: input.prioritizedMcpConfigIds,
			totalToolsAfterBoost: boostedToolResults.length,
			boostedTools: boostedToolNames,
		});
	}

	console.log("[Orchestrator] Tool search results:", {
		matchedToolCount: boostedToolResults.length,
		matchedTools: boostedToolResults.map((t) => ({
			name: t.toolName,
			confidence: t.confidence.toFixed(2),
		})),
		totalToolsSearched: toolSearchResult.totalToolsSearched,
		durationMs: toolSearchResult.durationMs,
	});
	const integrationSearchTriggered = shouldSearchIntegrations({
		message: input.message,
		toolResults: boostedToolResults,
		userIntent,
	});
	const integrationSearchReason = integrationSearchTriggered
		? "query_or_confidence_requires_integration_search"
		: "skipped_due_to_decisive_tool_result";

	// ==========================================================================
	// REQUIRED CONNECTION DETECTION
	// Check if any MCP servers need to be connected before proceeding
	// This implements the Composio-like pattern of prompting for connections
	// ==========================================================================
	const matchedServerNames = [
		...new Set(boostedToolResults.map((t) => t.serverName)),
	];
	const connectionDetection =
		await detectRequiredConnectionsWithRegistrySearch({
			query: input.message,
			userId: input.userId,
			organizationId: input.organizationId,
			matchedServerNames,
			searchRegistry: boostedToolResults.length === 0, // Search registry if no tools found
		});

	if (connectionDetection.hasRequiredConnections) {
		console.log("[Orchestrator] Detected required connections:", {
			count: connectionDetection.requiredConnections.length,
			servers: connectionDetection.requiredConnections.map((c) => ({
				name: c.serverName,
				authType: c.authType,
				confidence: c.confidence,
			})),
		});
	}

	// Check if high-confidence tools can handle the task directly
	const highConfidenceTools = boostedToolResults.filter(
		(t) => t.confidence >= 0.6,
	);
	const mcpCanHandle = highConfidenceTools.length > 0;
	const mcpConfidence = mcpCanHandle
		? Math.round(highConfidenceTools[0].confidence * 100)
		: 0;
	const isReadOnly = highConfidenceTools.every((t) => t.isReadOnly);

	// Build tool descriptions for routing prompt
	let mcpToolDescriptions = "";
	if (boostedToolResults.length > 0) {
		mcpToolDescriptions = boostedToolResults
			.map(
				(t) =>
					`- **${t.toolName}** (${t.serverName}): ${t.description.slice(0, 100)}${t.description.length > 100 ? "..." : ""} [confidence: ${(t.confidence * 100).toFixed(0)}%]`,
			)
			.join("\n");
	}

	// ==========================================================================
	// TOKEN-EFFICIENT AGENT DISCOVERY
	// Use agent search instead of loading all agent details
	// ==========================================================================

	// Search for relevant agents based on the task
	const agentSearchResult = await searchAvailableAgents({
		query: input.message,
		limit: 5,
		minConfidence: 0.2,
		userId: input.userId,
		organizationId: input.organizationId,
		enabledAgentIds: input.enabledAgentIds,
	});

	// ==========================================================================
	// APPLY AGENT PRIORITIZATION BOOSTS
	// ==========================================================================
	let boostedAgentResults = agentSearchResult.results;

	if (input.prioritizedAgentIds?.length) {
		boostedAgentResults = agentSearchResult.results.map((a) => {
			if (input.prioritizedAgentIds?.includes(a.agentId)) {
				return {
					...a,
					confidence: Math.min(a.confidence + 0.3, 1.0), // 30% boost
					matchReason: `${a.matchReason || ""} [PRIORITIZED +30%]`,
				};
			}
			return a;
		});

		// Re-sort by confidence after boosting
		boostedAgentResults.sort((a, b) => b.confidence - a.confidence);

		console.log("[Orchestrator] Applied agent prioritization boosts:", {
			prioritizedAgents: input.prioritizedAgentIds,
		});
	}

	console.log("[Orchestrator] Agent search results:", {
		matchedAgentCount: boostedAgentResults.length,
		matchedAgents: boostedAgentResults.map((a) => ({
			id: a.agentId,
			confidence: a.confidence.toFixed(2),
		})),
		totalAgentsSearched: agentSearchResult.totalAgentsSearched,
		durationMs: agentSearchResult.durationMs,
	});

	// Build agent descriptions for routing prompt
	let agentDescriptions = "";
	if (boostedAgentResults.length > 0) {
		agentDescriptions = boostedAgentResults
			.map((a) => {
				const limitationsNote = a.limitations?.length
					? `\n  Limitations: ${a.limitations.join(", ")}`
					: "";
				const skillsNote = a.skills.length
					? `\n  Skills: ${a.skills.join(", ")}`
					: "";
				return `- **${a.displayName}** (${a.agentId}): ${a.description.slice(0, 150)}${skillsNote}${limitationsNote} [confidence: ${(a.confidence * 100).toFixed(0)}%]`;
			})
			.join("\n\n");
	} else {
		agentDescriptions =
			"No high-confidence agent matches found. Prefer direct MCP or workflow execution unless the user explicitly requested an agent.";
	}

	// ==========================================================================
	// TOKEN-EFFICIENT WORKFLOW DISCOVERY
	// Search for workflows that match the task (if user mentioned workflows)
	// ==========================================================================
	let workflowSearchResult: Awaited<
		ReturnType<typeof searchAvailableWorkflows>
	> | null = null;
	let workflowDescriptions = "";

	// Only search workflows if user mentioned workflow or we detect workflow-like patterns
	if (userIntent.requestedWorkflow || userIntent.requestedWorkflowName) {
		workflowSearchResult = await searchAvailableWorkflows({
			query: input.message,
			limit: 5,
			minConfidence: 0.2,
			userId: input.userId,
			organizationId: input.organizationId,
			requestedWorkflowName: userIntent.requestedWorkflowName,
		});

		console.log("[Orchestrator] Workflow search results:", {
			matchedWorkflowCount: workflowSearchResult.results.length,
			matchedWorkflows: workflowSearchResult.results.map((w) => ({
				name: w.name,
				confidence: w.confidence.toFixed(2),
			})),
			totalWorkflowsSearched: workflowSearchResult.totalWorkflowsSearched,
			durationMs: workflowSearchResult.durationMs,
		});

		if (workflowSearchResult.results.length > 0) {
			workflowDescriptions = workflowSearchResult.results
				.map(
					(w) =>
						`- **${w.name}** (${w.workflowId}): ${w.description.slice(0, 100)}${w.description.length > 100 ? "..." : ""} [confidence: ${(w.confidence * 100).toFixed(0)}%, trigger: ${w.triggerType}]`,
				)
				.join("\n");
		}
	}

	// ==========================================================================
	// TOKEN-EFFICIENT INTEGRATION DISCOVERY (ALWAYS SEMANTIC)
	// Search for workflow integrations (Slack, GitHub, Linear, etc.)
	// These are connected services that can be used as alternatives to MCP servers
	// IMPORTANT: Always use semantic search - no keyword gates. Let Qdrant determine relevance.
	// ==========================================================================
	let integrationSearchResult: Awaited<
		ReturnType<typeof searchAvailableIntegrations>
	> | null = null;
	let integrationDescriptions = "";

	if (integrationSearchTriggered) {
		integrationSearchResult = await searchAvailableIntegrations({
			query: input.message,
			limit: 5,
			minConfidence: 0.3,
			userId: input.userId,
			organizationId: input.organizationId,
			enabledIntegrationIds: input.enabledIntegrationIds,
		});

		console.log("[Orchestrator] Integration search results:", {
			matchedIntegrationCount: integrationSearchResult.results.length,
			matchedIntegrations: integrationSearchResult.results.map((i) => ({
				name: i.name,
				provider: i.provider,
				confidence: i.confidence.toFixed(2),
			})),
			totalIntegrationsSearched:
				integrationSearchResult.totalIntegrationsSearched,
			durationMs: integrationSearchResult.durationMs,
		});

		if (integrationSearchResult.results.length > 0) {
			integrationDescriptions = integrationSearchResult.results
				.map(
					(i) =>
						`- **${i.name}** (${i.provider}): ${i.description.slice(0, 100)}${i.description.length > 100 ? "..." : ""} [confidence: ${(i.confidence * 100).toFixed(0)}%, capabilities: ${i.capabilities.slice(0, 3).join(", ")}]`,
				)
				.join("\n");
		}
	} else {
		console.log(
			"[Orchestrator] Skipping integration search - tool routing already decisive",
			{
				topTool: boostedToolResults[0]?.toolName,
				topConfidence: boostedToolResults[0]?.confidence?.toFixed(2),
			},
		);
	}

	// ==========================================================================
	// MISSING INTEGRATION DETECTION
	// Check if matched integrations are actually configured with credentials
	// ==========================================================================
	const missingIntegrationsResult = await detectMissingIntegrations({
		userId: input.userId,
		organizationId: input.organizationId,
		matchedIntegrations: integrationSearchResult?.results.map((i) => ({
			integrationId: i.integrationId,
			name: i.name,
			provider: i.provider,
			confidence: i.confidence,
			capabilities: i.capabilities,
		})),
	});

	if (missingIntegrationsResult.hasMissingIntegrations) {
		console.log("[Orchestrator] Detected missing integrations:", {
			count: missingIntegrationsResult.missingIntegrations.length,
			integrations: missingIntegrationsResult.missingIntegrations.map(
				(i) => ({
					name: i.name,
					provider: i.provider,
					authType: i.authType,
				}),
			),
		});
	}

	// ==========================================================================
	// EXPLICIT AGENT MATCHING
	// If user explicitly requested an agent by name, find it directly
	// ==========================================================================
	let explicitAgentMatch: (typeof agentSearchResult.results)[0] | null = null;

	if (userIntent.requestedAgentName) {
		const requestedName = userIntent.requestedAgentName.toLowerCase();

		// First check in semantic search results
		explicitAgentMatch =
			agentSearchResult.results.find(
				(a) =>
					a.agentId.toLowerCase() === requestedName ||
					a.agentId.toLowerCase().includes(requestedName) ||
					a.displayName.toLowerCase().includes(requestedName) ||
					a.name.toLowerCase().includes(requestedName),
			) || null;

		// If not found in semantic results, query database directly
		if (!explicitAgentMatch) {
			const dbAgent = await db.registeredAgent.findFirst({
				where: {
					status: "ACTIVE",
					AND: [
						{
							OR: [
								{ scope: "SYSTEM" },
								...(input.organizationId
									? [
											{
												scope: "ORGANIZATION",
												organizationId:
													input.organizationId,
											},
										]
									: [
											{
												scope: "USER",
												userId: input.userId,
												organizationId: null,
											},
										]),
							],
						},
						{
							OR: [
								{
									agentId: {
										contains: requestedName,
										mode: "insensitive" as const,
									},
								},
								{
									displayName: {
										contains: requestedName,
										mode: "insensitive" as const,
									},
								},
								{
									name: {
										contains: requestedName,
										mode: "insensitive" as const,
									},
								},
							],
						},
					],
				},
			});

			if (dbAgent) {
				const metadata = dbAgent.metadata as Record<
					string,
					unknown
				> | null;
				const skills =
					(metadata?.skills as Array<{ name: string }>) || [];
				explicitAgentMatch = {
					agentId: dbAgent.agentId,
					name: dbAgent.name,
					displayName: dbAgent.displayName,
					description: dbAgent.description || "",
					confidence: 0.95, // High confidence for explicit match
					matchReason: `Explicitly requested by user: "${userIntent.requestedAgentName}"`,
					skills: skills.map((s) => s.name),
					limitations: undefined,
				};
				console.log(
					`[Orchestrator] Found explicit agent match from database: ${dbAgent.agentId}`,
				);
			}
		} else {
			// Boost confidence for explicit match
			explicitAgentMatch = {
				...explicitAgentMatch,
				confidence: Math.max(explicitAgentMatch.confidence, 0.9),
				matchReason: `Explicitly requested by user: "${userIntent.requestedAgentName}". ${explicitAgentMatch.matchReason}`,
			};
			console.log(
				`[Orchestrator] Found explicit agent match from search: ${explicitAgentMatch.agentId}`,
			);
		}
	}

	// ==========================================================================
	// BUILD INTELLIGENT ROUTING PROMPT
	// ==========================================================================
	const mcpDirectHint = mcpCanHandle
		? `\n\n**RECOMMENDED ROUTING**: This task can be handled DIRECTLY using MCP tools (confidence: ${mcpConfidence}%).
Matched tools: ${highConfidenceTools.map((t) => t.toolName).join(", ")}
Use primaryAgent: "mcp_direct" to execute MCP tools directly without agent delegation.`
		: "";

	// Add workflow hint if workflows matched
	const workflowHint = workflowSearchResult?.results.length
		? `\n\n**AVAILABLE WORKFLOWS**: User requested workflow execution. Matched workflows:\n${workflowDescriptions}`
		: "";

	// Add integration hint if integrations matched
	const integrationHint = integrationSearchResult?.results.length
		? `\n\n**AVAILABLE INTEGRATIONS**: Connected service integrations that can be used instead of MCP servers:\n${integrationDescriptions}\n\nPrefer using integrations over MCP servers when the integration provides the needed capability - they are already configured and authenticated.`
		: "";

	// Add explicit agent hint if user requested specific agent
	const explicitAgentHint = explicitAgentMatch
		? `\n\n**USER REQUESTED AGENT**: User explicitly requested "${userIntent.requestedAgentName}". Matched agent: ${explicitAgentMatch.displayName} (${explicitAgentMatch.agentId})`
		: "";

	// ==========================================================================
	// BUILD PRIORITIZATION HINT
	// ==========================================================================
	// When user has prioritized specific tools, agents, or MCP servers,
	// add explicit instructions to the prompt to prefer these
	let prioritizationHint = "";
	const prioritizationParts: string[] = [];

	// Track prioritized names for passing to planner
	const prioritizedCapabilities: {
		mcpServers?: string[];
		tools?: string[];
		agents?: string[];
	} = {};

	// Get names of prioritized MCP servers (tenant-scoped)
	if (input.prioritizedMcpConfigIds?.length) {
		const prioritizedServerConfigs = await db.mCPConfig.findMany({
			where: {
				id: { in: input.prioritizedMcpConfigIds },
				...(input.organizationId
					? { organizationId: input.organizationId }
					: { userId: input.userId, organizationId: null }),
			},
			include: { mcpServer: true },
		});
		const serverNames = prioritizedServerConfigs.map(
			(c) => c.displayName || c.mcpServer?.name || c.id,
		);
		if (serverNames.length > 0) {
			prioritizationParts.push(`MCP servers: ${serverNames.join(", ")}`);
			prioritizedCapabilities.mcpServers = serverNames;
		}
	}

	// Get names of prioritized tools
	if (input.prioritizedToolIds?.length) {
		// Find display names from tool results
		const prioritizedToolNames = input.prioritizedToolIds.map((id) => {
			const tool = boostedToolResults.find((t) => t.toolName === id);
			return tool?.toolName || id;
		});
		prioritizationParts.push(`Tools: ${prioritizedToolNames.join(", ")}`);
		prioritizedCapabilities.tools = prioritizedToolNames;
	}

	// Get names of prioritized agents
	if (input.prioritizedAgentIds?.length) {
		const prioritizedAgentNames = input.prioritizedAgentIds.map((id) => {
			const agent = boostedAgentResults.find((a) => a.agentId === id);
			return agent?.displayName || id;
		});
		prioritizationParts.push(`Agents: ${prioritizedAgentNames.join(", ")}`);
		prioritizedCapabilities.agents = prioritizedAgentNames;
	}

	// Flag to indicate if any prioritization is active
	const hasPrioritization = prioritizationParts.length > 0;

	if (hasPrioritization) {
		prioritizationHint = `\n\n**USER PREFERENCES**: The user has indicated a preference for the following capabilities. STRONGLY prefer using these when applicable:\n- ${prioritizationParts.join("\n- ")}\n\nUse these preferred tools/servers/agents unless they are clearly not suitable for the task.`;
		console.log(
			"[Orchestrator] Added prioritization hint to prompt:",
			prioritizationParts,
		);
	}

	// Load and render the routing system prompt from template
	// Combine all hints for the routing prompt
	const combinedHints = `${mcpDirectHint}${workflowHint}${integrationHint}${explicitAgentHint}${prioritizationHint}`;

	const systemPrompt = getRoutingSystemPrompt({
		mcpToolDescriptions:
			mcpToolDescriptions || "No matching MCP tools found.",
		agentDescriptions,
		mcpDirectHint: combinedHints,
		conversationHistory: input.history,
		// Include memory context with learned patterns for routing decisions
		memoryContext: input.memoryContext,
	});

	// Build user prompt with prioritized tools as preferences (not mandates)
	// Prioritization is a hint, not a requirement - workspace context should still be used
	let userPrompt = input.message;
	if (hasPrioritization && prioritizedCapabilities) {
		const priorityInstructions: string[] = [];

		if (prioritizedCapabilities.mcpServers?.length) {
			priorityInstructions.push(
				`PREFER MCP servers: ${prioritizedCapabilities.mcpServers.join(", ")}`,
			);
		}
		if (prioritizedCapabilities.tools?.length) {
			priorityInstructions.push(
				`PREFER tools: ${prioritizedCapabilities.tools.join(", ")}`,
			);
		}
		if (prioritizedCapabilities.agents?.length) {
			priorityInstructions.push(
				`PREFER agents: ${prioritizedCapabilities.agents.join(", ")}`,
			);
		}

		if (priorityInstructions.length > 0) {
			// Prepend priority instructions as preferences, not mandates
			// Workspace context should still be used for answering knowledge questions
			userPrompt = `[USER PREFERENCES - ${priorityInstructions.join("; ")}. NOTE: Still use workspace document context for knowledge questions.]\n\n${input.message}`;
			console.log(
				"[Orchestrator] Enhanced user prompt with starred preferences:",
				priorityInstructions,
			);
		}
	}

	// Append image context if images are attached
	if (input.attachedImageUrls?.length) {
		userPrompt += `\n\n[ATTACHED IMAGES: ${input.attachedImageUrls.length} image(s) attached. Storage paths: ${input.attachedImageUrls.join(", ")}. Route to fabric_generate_image for image editing/modification tasks.]`;
	}

	const response = await generateText({
		model,
		system: systemPrompt,
		prompt: `Task: ${userPrompt}`,
	});

	const content = response.text || "{}";

	// Use safe JSON parsing to handle model output with text before/after JSON
	interface RoutingResponse {
		primaryAgent?: string;
		useMcpDirect?: boolean;
		matchedMcpTools?: string[];
		secondaryAgents?: string[];
		confidence?: number;
		reasoning?: string;
		riskLevel?: "low" | "medium" | "high" | "critical";
		riskFactors?: string[];
		suggestedStrategy?:
			| "api"
			| "browser"
			| "hybrid"
			| "agent"
			| "workflow"
			| "research"
			| "generate"
			| "verify";
	}
	const parsed: RoutingResponse =
		safeParseJson<RoutingResponse>(content, "object") || {};

	console.log("[Orchestrator] Routing response parsed:", {
		rawLength: content.length,
		parsedKeys: Object.keys(parsed),
		primaryAgent: parsed.primaryAgent,
	});

	// ==========================================================================
	// MCP DIRECT ROUTING CHECK
	// ==========================================================================
	const browserCodeKeywords = [
		"browser",
		"click",
		"navigate",
		"automate",
		"code",
		"execute",
		"script",
		"run python",
		"run javascript",
	];
	const requiresBrowserOrCode = browserCodeKeywords.some((kw) =>
		input.message.toLowerCase().includes(kw),
	);

	// Agents that should NOT be overridden to mcp_direct
	// These agents have specialized capabilities beyond raw MCP tool execution
	const specializedAgents = [
		"data_analyst", // Has chart/visualization capabilities
		"cuga_generalist", // Has browser/code execution
		"document_generator", // Has document generation
		"project_document_generator", // Has document generation with RAG
	];

	const llmSelectedSpecializedAgent =
		parsed.primaryAgent && specializedAgents.includes(parsed.primaryAgent);

	// Check if we have integrations but NO MCP tools - in this case, don't use mcp_direct
	const hasIntegrationsOnly =
		(integrationSearchResult?.results?.length ?? 0) > 0 &&
		highConfidenceTools.length === 0;

	const useMcpDirect =
		!llmSelectedSpecializedAgent &&
		!hasIntegrationsOnly && // Don't use mcp_direct if only integrations matched
		(parsed.useMcpDirect === true ||
			parsed.primaryAgent === "mcp_direct" ||
			(mcpCanHandle && !requiresBrowserOrCode));

	let primaryAgent = parsed.primaryAgent || "mcp_tool_executor";

	// Override to mcp_direct if conditions are met
	// BUT respect the LLM's choice if it selected a specialized agent
	if (useMcpDirect && primaryAgent !== "mcp_direct") {
		console.log(
			"[Orchestrator] Overriding routing to mcp_direct based on tool search results",
			{
				mcpCanHandle,
				confidence: mcpConfidence,
				matchedToolCount: highConfidenceTools.length,
				aiSelectedAgent: parsed.primaryAgent,
			},
		);
		primaryAgent = "mcp_direct";
	} else if (hasIntegrationsOnly) {
		console.log(
			"[Orchestrator] Routing to integration handler - only integrations matched, no MCP tools",
			{
				integrationCount: integrationSearchResult?.results.length,
				integrations: integrationSearchResult?.results.map(
					(i) => `${i.name} (${i.provider})`,
				),
				llmSuggestedAgent: parsed.primaryAgent,
			},
		);
		// Override mcp_direct to use integration-compatible handler
		// The LLM may have incorrectly suggested mcp_direct - override it
		if (primaryAgent === "mcp_direct") {
			primaryAgent = "mcp_tool_executor"; // This will let the step assigner route to integration
			console.log(
				"[Orchestrator] Overriding mcp_direct to mcp_tool_executor for integration routing",
			);
		}
	} else if (llmSelectedSpecializedAgent) {
		console.log(
			`[Orchestrator] Respecting LLM's choice of specialized agent: ${parsed.primaryAgent}`,
			{
				mcpCanHandle,
				agentCapabilities: "specialized",
			},
		);
	}

	// If mcp_direct selected, skip agent capability check
	if (primaryAgent === "mcp_direct") {
		const riskLevel = isReadOnly ? "low" : parsed.riskLevel || "medium";

		// Use ALL matched tools, not just high-confidence ones
		// This allows the LLM planner to decide which tools to use
		// High confidence threshold is for auto-routing, not for tool availability
		const toolsForPlan =
			boostedToolResults.length > 0
				? boostedToolResults
				: highConfidenceTools;

		const effectiveConfidence =
			toolsForPlan.length > 0
				? Math.round(toolsForPlan[0].confidence * 100)
				: mcpConfidence;

		console.log("[Orchestrator] Using MCP direct execution", {
			matchedTools: toolsForPlan.map((t) => t.toolName),
			confidence: effectiveConfidence,
			isReadOnly,
			riskLevel,
			highConfidenceCount: highConfidenceTools.length,
			totalMatchedCount: toolsForPlan.length,
		});

		return {
			primaryAgent: "mcp_direct",
			secondaryAgents: [],
			confidence: effectiveConfidence,
			reasoning: `MCP tools can handle this task directly. Matched: ${toolsForPlan.map((t) => t.toolName).join(", ")}`,
			riskLevel,
			riskFactors: isReadOnly ? [] : parsed.riskFactors || [],
			suggestedStrategy: "api",
			isGeneralistAgent: false,
			delegationMode: "single-step",
			agentCapabilities: undefined,
			matchedMcpTools: toolsForPlan.map((t) => ({
				toolName: t.toolName,
				configId: t.configId,
				description: t.description,
				confidence: t.confidence,
				reason: `Matched via semantic search with ${Math.round(t.confidence * 100)}% confidence`,
				// Include inputSchema for planner to know required parameters
				inputSchema: t.inputSchema,
			})),
			matchedAgents: boostedAgentResults.map((a) => ({
				agentId: a.agentId,
				displayName: a.displayName,
				description: a.description,
				skills: a.skills,
				limitations: a.limitations,
				confidence: a.confidence,
				reason: `Matched via semantic search with ${Math.round(a.confidence * 100)}% confidence`,
			})),
			// Include matched integrations (Slack, GitHub, etc.)
			matchedIntegrations: integrationSearchResult?.results.map((i) => ({
				integrationId: i.integrationId,
				name: i.name,
				provider: i.provider,
				description: i.description,
				confidence: i.confidence,
				reason: i.matchReason,
				capabilities: i.capabilities,
			})),
			useMcpDirect: true,
			isReadOnly,
			userIntent:
				Object.keys(userIntent).length > 0 ? userIntent : undefined,
			prioritizedCapabilities: hasPrioritization
				? prioritizedCapabilities
				: undefined,
			// Include required connections if any MCP servers need to be connected
			requiredConnections: connectionDetection.hasRequiredConnections
				? connectionDetection.requiredConnections
				: undefined,
			// Include missing integrations
			missingIntegrations:
				missingIntegrationsResult.hasMissingIntegrations
					? missingIntegrationsResult.missingIntegrations
					: undefined,
			blockedOnConnections: false, // MCP direct mode has tools, so not blocked
			selectorTelemetry: {
				toolSearch: {
					strategy: toolSearchResult.telemetry?.strategy,
					durationMs: toolSearchResult.durationMs,
					totalToolsSearched: toolSearchResult.totalToolsSearched,
					semanticSearchUsed: toolSearchResult.semanticSearchUsed,
					explicitServerUsed:
						toolSearchResult.telemetry?.explicitServerUsed,
					keywordShortcutUsed:
						toolSearchResult.telemetry?.keywordShortcutUsed,
					matchedServers: toolSearchResult.telemetry?.matchedServers,
					topResults: boostedToolResults.slice(0, 5).map((t) => ({
						toolName: t.toolName,
						serverName: t.serverName,
						confidence: t.confidence,
					})),
				},
				agentSearch: {
					durationMs: agentSearchResult.durationMs,
					totalAgentsSearched: agentSearchResult.totalAgentsSearched,
					topResults: boostedAgentResults.slice(0, 5).map((a) => ({
						agentId: a.agentId,
						confidence: a.confidence,
					})),
				},
				integrationSearch: {
					searched: integrationSearchTriggered,
					reason: integrationSearchReason,
					durationMs: integrationSearchResult?.durationMs ?? 0,
					totalIntegrationsSearched:
						integrationSearchResult?.totalIntegrationsSearched,
					topResults:
						integrationSearchResult?.results
							.slice(0, 5)
							.map((i) => ({
								name: i.name,
								provider: i.provider,
								confidence: i.confidence,
							})) ?? [],
				},
				finalSelection: {
					primaryAgent: "mcp_direct",
					useMcpDirect: true,
					highConfidenceToolCount: highConfidenceTools.length,
					matchedToolCount: toolsForPlan.length,
					matchedIntegrationCount:
						integrationSearchResult?.results.length ?? 0,
				},
			},
		};
	}

	// ==========================================================================
	// GENERALIST AGENT DETECTION
	// ==========================================================================
	let isGeneralistAgent = false;
	let delegationMode: "complete-task" | "single-step" = "single-step";
	let agentCapabilities:
		| {
				autonomousExecution?: boolean;
				taskDecomposition?: boolean;
				contextPreservation?: boolean;
				codeExecution?: boolean;
				browserAutomation?: boolean;
				memoryEnabled?: boolean;
				multiTenancyAware?: boolean;
				maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
				hasMcpAccess?: boolean;
				mcpToolAccess?: string[];
				limitations?: string[];
		  }
		| undefined;

	try {
		const agentCardCapabilities = await getAgentCapabilities(
			primaryAgent,
			input.userId,
			input.organizationId,
		);

		if (agentCardCapabilities) {
			agentCapabilities = agentCardCapabilities;

			isGeneralistAgent =
				!!agentCardCapabilities.autonomousExecution &&
				!!agentCardCapabilities.taskDecomposition;

			if (
				isGeneralistAgent &&
				(agentCardCapabilities.maxAutonomyLevel === "task" ||
					agentCardCapabilities.maxAutonomyLevel === "session")
			) {
				delegationMode = "complete-task";
				console.log(
					`[Orchestrator] Detected generalist agent: ${primaryAgent} (maxAutonomy=${agentCardCapabilities.maxAutonomyLevel})`,
				);
				console.log(
					"[Orchestrator] Will use complete-task delegation - agent will handle decomposition internally",
				);
			}

			// Log limitations for visibility
			if (agentCardCapabilities.limitations?.length) {
				console.log(
					`[Orchestrator] Agent ${primaryAgent} has limitations:`,
					agentCardCapabilities.limitations,
				);
			}
		}
	} catch (error) {
		console.warn(
			`[Orchestrator] Failed to fetch agent capabilities for ${primaryAgent}:`,
			error,
		);
	}

	// Override primaryAgent if user explicitly requested a specific agent
	// This uses the new explicit agent match from detectUserIntent
	if (explicitAgentMatch && !useMcpDirect) {
		primaryAgent = explicitAgentMatch.agentId;
		console.log(
			`[Orchestrator] Routing to explicitly requested agent: ${primaryAgent}`,
			{
				displayName: explicitAgentMatch.displayName,
				confidence: explicitAgentMatch.confidence,
				requestedName: userIntent.requestedAgentName,
			},
		);
	} else if (userIntent.requestedAgent && !useMcpDirect) {
		// Fallback to old behavior for backward compatibility
		const requestedAgentId = userIntent.requestedAgent;
		const agentMatch = agentSearchResult.results.find(
			(a) => a.agentId === requestedAgentId,
		);
		if (agentMatch || requestedAgentId === "cuga_generalist") {
			primaryAgent = requestedAgentId;
			console.log(
				`[Orchestrator] Routing to user-requested agent (legacy): ${primaryAgent}`,
			);
		}
	}

	// Override to workflow execution if user explicitly requested a workflow
	// and we found a matching workflow
	if (userIntent.requestedWorkflow && workflowSearchResult?.results.length) {
		const topWorkflow = workflowSearchResult.results[0];
		console.log(
			`[Orchestrator] User requested workflow execution: ${topWorkflow.name}`,
			{
				workflowId: topWorkflow.workflowId,
				confidence: topWorkflow.confidence,
				requestedName: userIntent.requestedWorkflowName,
			},
		);
		// The LLM will handle setting suggestedStrategy to "workflow"
		// based on the workflow hint in the prompt
	}

	const routingDurationMs = Date.now() - routingStartTime;
	console.log(`[Orchestrator] Routing completed in ${routingDurationMs}ms`, {
		primaryAgent,
		toolSearchMs: toolSearchResult.durationMs,
		agentSearchMs: agentSearchResult.durationMs,
	});

	// IMPORTANT: Only include MCP tools with meaningful confidence (>= 0.5)
	// Lower confidence matches often indicate false positives from semantic search
	// (e.g., "fitness" matching "fizzy", "plan" matching project planning tools)
	// This prevents irrelevant tools from being passed to the planner
	const relevantMcpTools = boostedToolResults.filter(
		(t) => t.confidence >= 0.5,
	);
	if (relevantMcpTools.length < boostedToolResults.length) {
		console.log(
			`[Orchestrator] Filtered out ${boostedToolResults.length - relevantMcpTools.length} low-confidence MCP tools (< 50%)`,
		);
	}

	return {
		primaryAgent,
		secondaryAgents: parsed.secondaryAgents || [],
		confidence: parsed.confidence || 70,
		reasoning: parsed.reasoning || "Default routing",
		riskLevel: parsed.riskLevel || "low",
		riskFactors: parsed.riskFactors || [],
		suggestedStrategy: parsed.suggestedStrategy || "api",
		isGeneralistAgent,
		delegationMode,
		agentCapabilities,
		useMcpDirect: false,
		// Include only relevant MCP tools (confidence >= 0.5) from semantic search
		matchedMcpTools: relevantMcpTools.map((t) => ({
			toolName: t.toolName,
			configId: t.configId,
			description: t.description,
			confidence: t.confidence,
			reason: t.matchReason,
			// Include inputSchema for planner to know required parameters
			inputSchema: t.inputSchema,
		})),
		matchedAgents: boostedAgentResults.map((a) => ({
			agentId: a.agentId,
			displayName: a.displayName,
			description: a.description,
			skills: a.skills,
			limitations: a.limitations,
			confidence: a.confidence,
			reason: `Matched via semantic search with ${Math.round(a.confidence * 100)}% confidence`,
		})),
		// Include matched workflows if workflow search was performed
		matchedWorkflows: workflowSearchResult?.results.map((w) => ({
			workflowId: w.workflowId,
			name: w.name,
			description: w.description,
			confidence: w.confidence,
			reason: w.matchReason,
			triggerType: w.triggerType,
		})),
		// Include matched integrations (Slack, GitHub, etc.)
		matchedIntegrations: integrationSearchResult?.results.map((i) => ({
			integrationId: i.integrationId,
			name: i.name,
			provider: i.provider,
			description: i.description,
			confidence: i.confidence,
			reason: i.matchReason,
			capabilities: i.capabilities,
		})),
		userIntent: Object.keys(userIntent).length > 0 ? userIntent : undefined,
		prioritizedCapabilities: hasPrioritization
			? prioritizedCapabilities
			: undefined,
		// Include required connections if any MCP servers need to be connected
		// This enables the frontend to prompt the user to connect before proceeding
		requiredConnections: connectionDetection.hasRequiredConnections
			? connectionDetection.requiredConnections
			: undefined,
		// Include missing integrations (workflow integrations that need configuration)
		missingIntegrations: missingIntegrationsResult.hasMissingIntegrations
			? missingIntegrationsResult.missingIntegrations
			: undefined,
		// Block on connections if:
		// 1. MCP connections needed and no tools found, OR
		// 2. Integrations matched but not configured
		blockedOnConnections:
			(connectionDetection.hasRequiredConnections &&
				relevantMcpTools.length === 0 &&
				!agentCapabilities?.hasMcpAccess) ||
			missingIntegrationsResult.hasMissingIntegrations,
		selectorTelemetry: {
			toolSearch: {
				strategy: toolSearchResult.telemetry?.strategy,
				durationMs: toolSearchResult.durationMs,
				totalToolsSearched: toolSearchResult.totalToolsSearched,
				semanticSearchUsed: toolSearchResult.semanticSearchUsed,
				explicitServerUsed:
					toolSearchResult.telemetry?.explicitServerUsed,
				keywordShortcutUsed:
					toolSearchResult.telemetry?.keywordShortcutUsed,
				matchedServers: toolSearchResult.telemetry?.matchedServers,
				topResults: boostedToolResults.slice(0, 5).map((t) => ({
					toolName: t.toolName,
					serverName: t.serverName,
					confidence: t.confidence,
				})),
			},
			agentSearch: {
				durationMs: agentSearchResult.durationMs,
				totalAgentsSearched: agentSearchResult.totalAgentsSearched,
				topResults: boostedAgentResults.slice(0, 5).map((a) => ({
					agentId: a.agentId,
					confidence: a.confidence,
				})),
			},
			integrationSearch: {
				searched: integrationSearchTriggered,
				reason: integrationSearchReason,
				durationMs: integrationSearchResult?.durationMs ?? 0,
				totalIntegrationsSearched:
					integrationSearchResult?.totalIntegrationsSearched,
				topResults:
					integrationSearchResult?.results.slice(0, 5).map((i) => ({
						name: i.name,
						provider: i.provider,
						confidence: i.confidence,
					})) ?? [],
			},
			finalSelection: {
				primaryAgent,
				useMcpDirect: false,
				highConfidenceToolCount: highConfidenceTools.length,
				matchedToolCount: relevantMcpTools.length,
				matchedIntegrationCount:
					integrationSearchResult?.results.length ?? 0,
			},
		},
	};
}
