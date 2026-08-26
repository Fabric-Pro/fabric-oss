/**
 * Deployment Execution Activities
 *
 * Activities for executing deployed agent instances.
 * Uses the shared agent-execution module for:
 * - Knowledge fetching (RAG)
 * - AI execution with tool loops
 *
 * This replaces the previous A2A-based approach with a fully Temporal-native
 * execution model that is observable, durable, and reuses existing infrastructure.
 */

import {
	appendTemplateMessage,
	getAgentDeploymentById,
	getBuiltInToolConfig,
	getTemplateConversationMessages,
	type Prisma,
	type TemplateConversationMessage,
	updateExecutionStatus,
} from "@repo/database";
import { logger } from "@repo/logs";
import { Client, Connection } from "@temporalio/client";

// Import shared agent execution utilities
import {
	buildAgentExecutionContext,
	buildKnowledgeContextPrompt,
	buildUserInputContext,
	executeAgentTurn,
	extractBuiltInToolNames,
	extractMcpConfigIds,
	type FetchKnowledgeResult,
	fetchKnowledgeSources,
	type ToolCallRecord,
} from "./agent-execution-core";

// =============================================================================
// TYPES
// =============================================================================

export interface DeploymentConfig {
	deploymentId: string;
	template: {
		id: string;
		name: string;
		slug: string;
		displayName: string;
		description: string;
		instructions: string | null;
		knowledgeSources: string[];
		tools: string[];
		suggestedModel: string | null;
	};
	instance: {
		id: string;
		name: string;
		description: string | null;
		customInstructions: Record<string, unknown> | null;
		modelOverride: string | null;
		modelConfig: Record<string, unknown> | null;
	};
	integrationConfigurations: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: unknown;
	}>;
	mcpConfigIds: string[];
	toolConnections: Record<string, Record<string, unknown>>;
	workspaceIds: string[];
}

export interface ExecutionContext {
	agentInstanceId: string;
	systemPrompt: string;
	model: string;
	tools: Array<{
		name: string;
		type: string;
		configId?: string;
		config: Record<string, unknown>;
	}>;
	knowledgeSources: Array<{
		type: string;
		integrationId: string;
	}>;
	integrationConfigurations: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: unknown;
	}>;
	workspaceIds: string[];
	mcpConfigIds: string[];
	builtInToolNames: string[];
	/**
	 * The agent's bound project, from toolConnections["project-context"] —
	 * same binding the trigger-system conversational path resolves. Threaded
	 * into executeAgentTurn so its tool wrappers can enforce the project's
	 * Read-only mode on scheduled/webhook deployment runs; the
	 * gates silently no-op without it (post-ship review finding).
	 */
	projectId?: string;
}

export interface InvokeAgentResult {
	output: Record<string, unknown>;
	toolCalls: ToolCallRecord[];
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
	artifacts?: Array<{
		id: string;
		name: string;
		mimeType: string;
		storagePath: string;
	}>;
}

// =============================================================================
// ACTIVITIES
// =============================================================================

/**
 * Load deployment configuration including template, instance, and connections
 *
 * TENANT ISOLATION: Uses getAgentDeploymentById which enforces strict isolation:
 * - Personal context (no orgId): Only loads deployments where organizationId IS NULL
 * - Org context (with orgId): Only loads deployments for that specific org
 */
export async function loadDeploymentConfiguration(params: {
	deploymentId: string;
	userId: string;
	organizationId?: string;
}): Promise<DeploymentConfig | null> {
	const { deploymentId, userId, organizationId } = params;

	const tenantContext = organizationId ? `org:${organizationId}` : "personal";
	logger.info("[DeploymentExecution] Loading configuration", {
		deploymentId,
		userId,
		tenantContext,
	});

	// getAgentDeploymentById enforces strict tenant isolation
	const deployment = await getAgentDeploymentById(deploymentId, {
		userId,
		organizationId,
	});

	if (!deployment) {
		logger.error(
			"[DeploymentExecution] Deployment not found or access denied",
			{
				deploymentId,
				tenantContext,
			},
		);
		return null;
	}

	const instance = deployment.instance;
	const template = instance.template;

	return {
		deploymentId: deployment.id,
		template: {
			id: template.id,
			name: template.name,
			slug: template.slug,
			displayName: template.displayName,
			description: template.description,
			instructions: template.instructions,
			knowledgeSources: [],
			tools: [],
			suggestedModel: template.suggestedModel,
		},
		instance: {
			id: instance.id,
			name: instance.name,
			description: instance.description,
			customInstructions: instance.customInstructions as Record<
				string,
				unknown
			> | null,
			modelOverride: instance.modelOverride,
			modelConfig: instance.modelConfig as Record<string, unknown> | null,
		},
		integrationConfigurations: (
			instance.integrationConfigurations || []
		).map(
			(ic: {
				integrationId: string;
				integrationType: string;
				allowedResources?: unknown;
			}) => ({
				integrationId: ic.integrationId,
				integrationType: ic.integrationType,
				allowedResources: ic.allowedResources ?? undefined,
			}),
		),
		mcpConfigIds: (instance.mcpServerConfigurations || []).map(
			(mc: { mcpConfigId: string }) => mc.mcpConfigId,
		),
		toolConnections:
			(instance.toolConnections as Record<
				string,
				Record<string, unknown>
			>) || {},
		workspaceIds: instance.workspaceIds || [],
	};
}

/**
 * Build execution context from deployment configuration
 * Uses the shared context builder from agent-execution module
 *
 * Also loads agent memory (AGENTS.md, skills, knowledge) if available
 */
export async function buildExecutionContext(params: {
	config: DeploymentConfig;
	input: Record<string, unknown>;
	userId: string;
	organizationId?: string;
}): Promise<ExecutionContext> {
	const { config, userId, organizationId } = params;

	logger.info("[DeploymentExecution] Building execution context");

	// Dust-style templates do not prescribe tools. Execution uses the
	// instance's selected tool connections only.
	const effectiveTools = Object.keys(config.toolConnections);

	// Use shared context builder with effective tools
	const agentContext = buildAgentExecutionContext(
		{ ...config.template, tools: effectiveTools },
		config.instance,
		{
			integrationConfigurations: config.integrationConfigurations,
			toolConnections: config.toolConnections,
			workspaceIds: config.workspaceIds,
		},
		userId,
		organizationId,
	);

	// Extract MCP config IDs for tool loading
	// Prefer explicit bindings from mcpServerConfigurations, fall back to legacy toolConnections
	const mcpConfigIds =
		config.mcpConfigIds.length > 0
			? config.mcpConfigIds
			: extractMcpConfigIds(agentContext.tools);

	// Load agent memory if available (AGENTS.md, skills, knowledge)
	let memorySystemPromptAddition = "";
	try {
		const { loadAgentMemoryContext } = await import("@repo/database");
		const memoryContext = await loadAgentMemoryContext({
			agentInstanceId: config.instance.id,
			userId,
			organizationId,
		});

		// Build system prompt addition from memory
		if (memoryContext.agentsMd) {
			memorySystemPromptAddition = `\n\n## Agent Memory (Learned Instructions)\n\n${memoryContext.agentsMd}`;
		}

		// Add loaded skills
		if (memoryContext.skills.length > 0) {
			memorySystemPromptAddition +=
				"\n\n## Loaded Skills\nYou have the following skills loaded. When the user's request matches a skill's purpose, you MUST follow that skill's instructions exactly, including its output format (e.g., generating HTML pages, diagrams, etc.).\n";
			for (const skill of memoryContext.skills) {
				const skillName = skill.path
					.replace("skills/", "")
					.replace("/SKILL.md", "");
				memorySystemPromptAddition += `\n### Skill: ${skillName}\n${skill.content}\n`;
			}
		}

		// Add knowledge context
		if (memoryContext.knowledge.length > 0) {
			memorySystemPromptAddition += "\n\n## Knowledge Context\n";
			for (const knowledge of memoryContext.knowledge) {
				const knowledgeName = knowledge.path.replace("knowledge/", "");
				memorySystemPromptAddition += `\n### ${knowledgeName}\n${knowledge.content}\n`;
			}
		}

		if (memorySystemPromptAddition) {
			logger.info("[DeploymentExecution] Agent memory loaded", {
				instanceId: config.instance.id,
				hasAgentsMd: !!memoryContext.agentsMd,
				skillsCount: memoryContext.skills.length,
				knowledgeCount: memoryContext.knowledge.length,
			});
		}
	} catch (error) {
		// Memory loading is optional - continue without it
		logger.debug("[DeploymentExecution] Agent memory not available", {
			instanceId: config.instance.id,
			error: error instanceof Error ? error.message : "Unknown",
		});
	}

	// Load episodic memory (relevant past conversations)
	try {
		const { loadRelevantEpisodesActivity } = await import(
			"./agent-memory/episodic-memory"
		);
		const userInput =
			typeof params.input === "object" && params.input !== null
				? (params.input as Record<string, unknown>).message ||
					(params.input as Record<string, unknown>).query ||
					""
				: "";

		if (typeof userInput === "string" && userInput.length > 0) {
			const episodicResult = await loadRelevantEpisodesActivity({
				agentInstanceId: config.instance.id,
				currentQuery: userInput,
				userId,
				organizationId,
				maxEpisodes: 3,
			});

			if (episodicResult.contextPrompt) {
				memorySystemPromptAddition += `\n\n${episodicResult.contextPrompt}`;
				logger.info("[DeploymentExecution] Episodic memory loaded", {
					instanceId: config.instance.id,
					relevantEpisodes: episodicResult.episodes.length,
				});
			}
		}
	} catch (error) {
		// Episodic memory is optional - continue without it
		logger.debug("[DeploymentExecution] Episodic memory not available", {
			instanceId: config.instance.id,
			error: error instanceof Error ? error.message : "Unknown",
		});
	}

	// Extract built-in tool names for native Fabric AI tool loading
	const builtInToolNames = extractBuiltInToolNames(agentContext.tools);

	// Project binding lives on the agent (toolConnections["project-context"]),
	// not the deployment — same resolution as the trigger-system path.
	const projectContextConfig = getBuiltInToolConfig(
		config.toolConnections,
		"project-context",
	);
	const boundProjectIdRaw = projectContextConfig?.projectId;
	const projectId =
		typeof boundProjectIdRaw === "string" && boundProjectIdRaw.length > 0
			? boundProjectIdRaw
			: undefined;

	return {
		agentInstanceId: config.instance.id,
		systemPrompt: agentContext.systemPrompt + memorySystemPromptAddition,
		model: agentContext.model,
		tools: agentContext.tools.map((t) => ({
			name: t.name,
			type: t.type,
			configId: t.configId,
			config: t.config || {},
		})),
		knowledgeSources: agentContext.knowledgeSources.map((ks) => ({
			type: ks.type,
			integrationId: ks.integrationId || "",
		})),
		integrationConfigurations: config.integrationConfigurations,
		workspaceIds: agentContext.workspaceIds,
		mcpConfigIds,
		builtInToolNames,
		projectId,
	};
}

/**
 * Fetch knowledge from configured sources for RAG context
 *
 * TENANT ISOLATION:
 * - Workspaces: searchMultipleWorkspaces uses physical collection isolation (org vs personal)
 * - Integrations: fetchCredentialsById enforces strict tenant filtering
 * - All workspace IDs and integration IDs come from the deployment config which is already tenant-isolated
 */
export async function fetchKnowledge(params: {
	executionId: string;
	context: ExecutionContext;
	query: string;
	userId: string;
	organizationId?: string;
}): Promise<FetchKnowledgeResult> {
	const { executionId, context, query, userId, organizationId } = params;

	const tenantContext = organizationId ? `org:${organizationId}` : "personal";
	logger.info("[DeploymentExecution] Fetching knowledge", {
		executionId,
		tenantContext,
		workspaceCount: context.workspaceIds.length,
		knowledgeSourceCount: context.knowledgeSources.length,
	});

	// Use shared knowledge fetcher
	const result = await fetchKnowledgeSources({
		knowledgeSources: context.knowledgeSources.map((ks) => ({
			type: ks.type,
			integrationId: ks.integrationId,
		})),
		workspaceIds: context.workspaceIds,
		query,
		userId,
		organizationId,
		executionId,
		enableRag: true,
		maxResultsPerSource: 10,
	});

	logger.info("[DeploymentExecution] Knowledge fetched", {
		executionId,
		totalChunks: result.totalChunks,
		sourcesFetched: result.sourcesFetched,
	});

	return result;
}

/**
 * Execute the agent with the given context and input
 * This is the main execution activity that runs the AI with tools
 *
 * TENANT ISOLATION:
 * - MCP tools: loadMcpToolsForAgent filters by userId + organizationId (strict XOR)
 * - AI model: getConfiguredAIModel uses tenant-isolated API key resolution
 * - All config IDs come from deployment config which is already tenant-isolated
 */
export async function invokeDeploymentAgent(params: {
	executionId: string;
	context: ExecutionContext;
	input: Record<string, unknown>;
	knowledgeResult?: FetchKnowledgeResult;
	userId: string;
	organizationId?: string;
	timeoutMs: number;
	/** Optional conversation history for multi-turn executions */
	conversationHistory?: Array<{
		role: "user" | "assistant";
		content: string;
	}>;
	/** Optional image references for multimodal input */
	imageRefs?: Array<{
		storagePath: string;
		mimeType: string;
		name: string;
	}>;
}): Promise<InvokeAgentResult> {
	const {
		executionId,
		context,
		input,
		knowledgeResult,
		userId,
		organizationId,
		conversationHistory,
		imageRefs,
	} = params;

	const tenantContext = organizationId ? `org:${organizationId}` : "personal";
	logger.info("[DeploymentExecution] Invoking agent", {
		executionId,
		tenantContext,
		model: context.model,
		toolCount: context.tools.length,
		mcpConfigCount: context.mcpConfigIds.length,
		integrationConfigCount: context.integrationConfigurations.length,
		hasKnowledge: !!knowledgeResult?.totalChunks,
		hasConversationHistory: !!conversationHistory?.length,
		historyMessageCount: conversationHistory?.length ?? 0,
	});

	// Build knowledge context prompt if we have retrieved chunks
	let knowledgeContext: string | undefined;
	if (knowledgeResult && knowledgeResult.chunks.length > 0) {
		knowledgeContext = buildKnowledgeContextPrompt(knowledgeResult.chunks);
	}

	// Extract user message from input
	const userMessage = buildUserInputContext(input);

	// Execute agent turn using shared executor
	const result = await executeAgentTurn({
		systemPrompt: context.systemPrompt,
		userMessage,
		knowledgeContext,
		mcpConfigIds: context.mcpConfigIds,
		integrationConfigurations: context.integrationConfigurations,
		model: context.model,
		userId,
		organizationId,
		// Bound project (toolConnections["project-context"]) — activates the
		// Read-only mode gates inside the tool wrappers for scheduled/webhook
		// deployment runs.
		projectId: context.projectId,
		maxIterations: 10,
		conversationHistory,
		executionId,
		imageRefs,
		builtInToolNames: context.builtInToolNames,
		agentInstanceId: context.agentInstanceId,
		callingAgentId: context.agentInstanceId,
		currentDepth: 0,
	});

	if (!result.success) {
		throw new Error(result.error || "Agent execution failed");
	}

	// Scan tool call results for image artifacts (e.g., from fabric_generate_image)
	const artifacts = extractArtifactsFromToolCalls(result.toolCalls);

	logger.info("[DeploymentExecution] Agent execution completed", {
		executionId,
		responseLength: result.response.length,
		toolCallCount: result.toolCalls.length,
		artifactCount: artifacts.length,
	});

	return {
		output: {
			response: result.response,
			toolCalls: result.toolCalls,
			...(artifacts.length > 0 ? { artifacts } : {}),
		},
		toolCalls: result.toolCalls,
		tokenUsage: result.tokenUsage,
		artifacts: artifacts.length > 0 ? artifacts : undefined,
	};
}

/**
 * Complete execution and update database
 */
export async function completeExecution(params: {
	executionId: string;
	status: "COMPLETED" | "FAILED" | "CANCELLED";
	output?: Record<string, unknown>;
	error?: string;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
	durationMs: number;
}): Promise<void> {
	const { executionId, status, output, error, tokenUsage, durationMs } =
		params;

	logger.info("[DeploymentExecution] Completing execution", {
		executionId,
		status,
		durationMs,
	});

	try {
		await updateExecutionStatus(executionId, status, {
			output: output as Prisma.InputJsonValue,
			error,
			completedAt: new Date(),
			duration: durationMs,
			inputTokens: tokenUsage?.inputTokens,
			outputTokens: tokenUsage?.outputTokens,
			totalCost: tokenUsage?.totalCost,
		});
	} catch (err) {
		logger.error(
			"[DeploymentExecution] Failed to update execution status",
			{
				error: err instanceof Error ? err.message : String(err),
			},
		);
		throw err;
	}
}

/**
 * Signal the supervisor workflow that execution is complete
 */
export async function signalSupervisorCompletion(params: {
	supervisorWorkflowId: string;
	executionId: string;
	success: boolean;
}): Promise<void> {
	const { supervisorWorkflowId, executionId, success } = params;

	logger.info("[DeploymentExecution] Signaling supervisor completion", {
		supervisorWorkflowId,
		executionId,
		success,
	});

	try {
		// Connect to Temporal and signal the supervisor
		const connection = await Connection.connect({
			address: process.env.TEMPORAL_ADDRESS || "localhost:7233",
		});

		const client = new Client({ connection });

		const handle = client.workflow.getHandle(supervisorWorkflowId);
		await handle.signal("executionCompleted", { executionId, success });

		logger.info("[DeploymentExecution] Supervisor signaled successfully");
	} catch (err) {
		logger.error("[DeploymentExecution] Failed to signal supervisor", {
			error: err instanceof Error ? err.message : String(err),
		});
		// Don't throw - supervisor will eventually detect completion via timeout
	}
}

// =============================================================================
// ARTIFACT EXTRACTION
// =============================================================================

/**
 * Scan tool call results for image/file artifacts.
 * Tools like fabric_generate_image return storagePath in their results.
 */
function extractArtifactsFromToolCalls(
	toolCalls: ToolCallRecord[],
): Array<{ id: string; name: string; mimeType: string; storagePath: string }> {
	const artifacts: Array<{
		id: string;
		name: string;
		mimeType: string;
		storagePath: string;
	}> = [];

	for (const tc of toolCalls) {
		if (tc.status !== "success" || !tc.result) {
			continue;
		}

		const result =
			typeof tc.result === "object"
				? (tc.result as Record<string, unknown>)
				: null;
		if (!result) {
			continue;
		}

		// Check for storagePath in result (common pattern for file-producing tools)
		const storagePath = result.storagePath as string | undefined;
		if (storagePath && typeof storagePath === "string") {
			const mimeType =
				(result.mimeType as string) ||
				(result.contentType as string) ||
				inferMimeType(storagePath);

			if (mimeType?.startsWith("image/")) {
				artifacts.push({
					id: tc.id,
					name:
						(result.name as string) ||
						storagePath.split("/").pop() ||
						"image",
					mimeType,
					storagePath,
				});
			}
		}

		// Check for url patterns that point to storage
		const url = result.url as string | undefined;
		if (url && typeof url === "string" && url.includes("/api-images/")) {
			const mimeType =
				(result.mimeType as string) ||
				(result.contentType as string) ||
				inferMimeType(url);

			if (mimeType?.startsWith("image/")) {
				artifacts.push({
					id: tc.id,
					name:
						(result.name as string) ||
						url.split("/").pop() ||
						"image",
					mimeType,
					storagePath: url,
				});
			}
		}
	}

	return artifacts;
}

/**
 * Infer MIME type from file extension.
 */
function inferMimeType(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "";
	}
}

// =============================================================================
// CONVERSATION ACTIVITIES
// =============================================================================

/**
 * Load conversation history for multi-turn executions
 *
 * TENANT ISOLATION: getConversationMessages enforces strict tenant filtering
 */
export async function loadConversationHistory(params: {
	conversationId: string;
	userId: string;
	organizationId?: string;
}): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
	const { conversationId, userId, organizationId } = params;

	const tenantContext = organizationId ? `org:${organizationId}` : "personal";
	logger.info("[DeploymentExecution] Loading conversation history", {
		conversationId,
		tenantContext,
	});

	try {
		const messages = await getTemplateConversationMessages(conversationId, {
			userId,
			organizationId,
		});

		// Filter to only user/assistant messages for the AI context
		const history = messages
			.filter(
				(m: TemplateConversationMessage) =>
					m.role === "user" || m.role === "assistant",
			)
			.map((m: TemplateConversationMessage) => ({
				role: m.role as "user" | "assistant",
				content: m.content,
			}));

		logger.info("[DeploymentExecution] Conversation history loaded", {
			conversationId,
			messageCount: history.length,
		});

		return history;
	} catch (err) {
		logger.error("[DeploymentExecution] Failed to load conversation", {
			conversationId,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}

/**
 * Save messages to conversation after execution
 *
 * TENANT ISOLATION: appendMessageToConversation enforces strict tenant filtering
 */
export async function saveConversationMessages(params: {
	conversationId: string;
	userId: string;
	organizationId?: string;
	userMessage: string;
	assistantResponse: string;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
}): Promise<void> {
	const {
		conversationId,
		userId,
		organizationId,
		userMessage,
		assistantResponse,
		tokenUsage,
	} = params;

	const tenantContext = organizationId ? `org:${organizationId}` : "personal";
	logger.info("[DeploymentExecution] Saving conversation messages", {
		conversationId,
		tenantContext,
	});

	try {
		// Append user message
		await appendTemplateMessage({
			conversationId,
			userId,
			organizationId,
			message: {
				role: "user",
				content: userMessage,
				timestamp: new Date().toISOString(),
			},
		});

		// Append assistant response
		await appendTemplateMessage({
			conversationId,
			userId,
			organizationId,
			message: {
				role: "assistant",
				content: assistantResponse,
				timestamp: new Date().toISOString(),
			},
			tokenUsage,
		});

		logger.info("[DeploymentExecution] Conversation messages saved", {
			conversationId,
		});
	} catch (err) {
		logger.error("[DeploymentExecution] Failed to save conversation", {
			conversationId,
			error: err instanceof Error ? err.message : String(err),
		});
		// Don't throw - this is a non-critical operation
	}
}
