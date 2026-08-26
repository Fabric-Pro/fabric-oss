/**
 * Dynamic Agents Queries
 *
 * Database operations for the dynamic agent builder.
 * Supports user-created agents with visual configuration.
 */

import { encryptApiKey } from "@repo/utils";
import { db } from "../client";
import type {
	AgentScope,
	DynamicAgentConfig,
	DynamicAgentExecution,
	DynamicAgentExecutionStatus,
	DynamicAgentFavorite,
	DynamicAgentStatus,
	DynamicAgentTrigger,
	DynamicAgentTriggerType,
	OffloadedToolOutput,
	Prisma,
} from "../generated/client";

// ============================================================================
// Types (prefixed to avoid conflicts with agent-deployments exports)
// ============================================================================

export interface CreateDynamicAgentInput {
	name: string;
	displayName: string;
	description?: string;
	avatarUrl?: string;
	userId?: string;
	organizationId?: string;
	scope?: AgentScope;
	systemPrompt: string;
	instructionSections?: Prisma.InputJsonValue;
	enabledToolIds?: string[];
	workspaceIds?: string[];
	connectorIds?: string[];
	canDelegateToAgents?: boolean;
	delegatableAgentIds?: string[];
	maxRecursionDepth?: number;
	aiModel?: string;
	aiProvider?: string;
	temperature?: number;
	maxIterations?: number;
	maxTokensPerTurn?: number;
	timeoutMs?: number;
}

export interface UpdateDynamicAgentInput {
	name?: string;
	displayName?: string;
	description?: string;
	avatarUrl?: string;
	systemPrompt?: string;
	instructionSections?: Prisma.InputJsonValue;
	enabledToolIds?: string[];
	workspaceIds?: string[];
	connectorIds?: string[];
	canDelegateToAgents?: boolean;
	delegatableAgentIds?: string[];
	maxRecursionDepth?: number;
	aiModel?: string;
	aiProvider?: string;
	temperature?: number;
	maxIterations?: number;
	maxTokensPerTurn?: number;
	timeoutMs?: number;
	status?: DynamicAgentStatus;
	versionNotes?: string;
}

export interface CreateDynamicAgentTriggerInput {
	agentConfigId: string;
	type: DynamicAgentTriggerType;
	name: string;
	description?: string;
	isEnabled?: boolean;
	schedule?: string;
	timezone?: string;
	webhookSecret?: string;
	eventType?: string;
	eventFilter?: Prisma.InputJsonValue;
	inputTemplate?: Prisma.InputJsonValue;
}

export interface CreateDynamicAgentExecutionInput {
	agentConfigId: string;
	triggerId?: string;
	temporalWorkflowId?: string;
	temporalRunId?: string;
	userId?: string;
	organizationId?: string;
	status?: DynamicAgentExecutionStatus;
	input?: Prisma.InputJsonValue;
	metadata?: Prisma.InputJsonValue;
}

export interface OffloadToolOutputInput {
	executionId: string;
	toolName: string;
	summary: string;
	fullOutput: string;
	outputSizeBytes: number;
	contentHash: string;
	expiresAt?: Date;
	userId?: string;
	organizationId?: string;
}

// ============================================================================
// Dynamic Agent Config Queries
// ============================================================================

/**
 * Create a new dynamic agent configuration
 */
export async function createDynamicAgentConfig(
	input: CreateDynamicAgentInput,
): Promise<DynamicAgentConfig> {
	return db.dynamicAgentConfig.create({
		data: {
			name: input.name,
			displayName: input.displayName,
			description: input.description,
			avatarUrl: input.avatarUrl,
			userId: input.userId,
			organizationId: input.organizationId,
			scope: input.scope ?? "USER",
			systemPrompt: input.systemPrompt,
			instructionSections: input.instructionSections ?? [],
			enabledToolIds: input.enabledToolIds ?? [],
			workspaceIds: input.workspaceIds ?? [],
			connectorIds: input.connectorIds ?? [],
			canDelegateToAgents: input.canDelegateToAgents ?? false,
			delegatableAgentIds: input.delegatableAgentIds ?? [],
			maxRecursionDepth: input.maxRecursionDepth ?? 4,
			aiModel: input.aiModel,
			aiProvider: input.aiProvider,
			temperature: input.temperature,
			maxIterations: input.maxIterations ?? 50,
			maxTokensPerTurn: input.maxTokensPerTurn ?? 8000,
			timeoutMs: input.timeoutMs ?? 1800000,
			status: "DRAFT",
		},
	});
}

/**
 * Get a dynamic agent by ID with tenant isolation
 */
export async function getDynamicAgentById(
	id: string,
	params: { userId: string; organizationId?: string },
): Promise<DynamicAgentConfig | null> {
	const tenantFilter = params.organizationId
		? {
				OR: [
					// User's own agent in org context
					{
						userId: params.userId,
						organizationId: params.organizationId,
					},
					// Organization-scope agents
					{
						organizationId: params.organizationId,
						scope: "ORGANIZATION" as AgentScope,
					},
					// System-scope agents
					{ scope: "SYSTEM" as AgentScope },
				],
			}
		: {
				OR: [
					// User's own personal agent
					{ userId: params.userId, organizationId: null },
					// System-scope agents
					{ scope: "SYSTEM" as AgentScope },
				],
			};

	return db.dynamicAgentConfig.findFirst({
		where: {
			id,
			...tenantFilter,
		},
		include: {
			triggers: true,
		},
	});
}

/**
 * List dynamic agents with tenant isolation and scope filtering
 */
export async function listDynamicAgents(params: {
	userId: string;
	organizationId?: string;
	status?: DynamicAgentStatus;
	scope?: AgentScope;
	includeSystem?: boolean;
	limit?: number;
	offset?: number;
}): Promise<DynamicAgentConfig[]> {
	const {
		userId,
		organizationId,
		status,
		scope,
		includeSystem = true,
	} = params;

	// Build the OR conditions for scope-based access
	const orConditions: Prisma.DynamicAgentConfigWhereInput[] = [];

	if (organizationId) {
		// In org context: see own agents, org-scope agents, and optionally system
		orConditions.push(
			{ userId, organizationId },
			{ organizationId, scope: "ORGANIZATION" },
		);
	} else {
		// In personal context: see own agents only
		orConditions.push({ userId, organizationId: null });
	}

	if (includeSystem) {
		orConditions.push({ scope: "SYSTEM" });
	}

	const where: Prisma.DynamicAgentConfigWhereInput = {
		OR: orConditions,
		...(status && { status }),
		...(scope && { scope }),
	};

	return db.dynamicAgentConfig.findMany({
		where,
		take: params.limit ?? 50,
		skip: params.offset ?? 0,
		orderBy: { updatedAt: "desc" },
		include: {
			triggers: {
				where: { isEnabled: true },
			},
			_count: {
				select: {
					executions: true,
					favorites: true,
				},
			},
		},
	});
}

/**
 * Update a dynamic agent configuration
 */
export async function updateDynamicAgentConfig(
	id: string,
	input: UpdateDynamicAgentInput,
	params: { userId: string; organizationId?: string },
): Promise<DynamicAgentConfig | null> {
	// First verify the user has edit access
	const existing = await db.dynamicAgentConfig.findFirst({
		where: {
			id,
			// Only owner can edit
			userId: params.userId,
			...(params.organizationId
				? { organizationId: params.organizationId }
				: { organizationId: null }),
		},
	});

	if (!existing) {
		return null;
	}

	const updateData: Prisma.DynamicAgentConfigUpdateInput = {};

	if (input.name !== undefined) {
		updateData.name = input.name;
	}
	if (input.displayName !== undefined) {
		updateData.displayName = input.displayName;
	}
	if (input.description !== undefined) {
		updateData.description = input.description;
	}
	if (input.avatarUrl !== undefined) {
		updateData.avatarUrl = input.avatarUrl;
	}
	if (input.systemPrompt !== undefined) {
		updateData.systemPrompt = input.systemPrompt;
	}
	if (input.instructionSections !== undefined) {
		updateData.instructionSections = input.instructionSections;
	}
	if (input.enabledToolIds !== undefined) {
		updateData.enabledToolIds = input.enabledToolIds;
	}
	if (input.workspaceIds !== undefined) {
		updateData.workspaceIds = input.workspaceIds;
	}
	if (input.connectorIds !== undefined) {
		updateData.connectorIds = input.connectorIds;
	}
	if (input.canDelegateToAgents !== undefined) {
		updateData.canDelegateToAgents = input.canDelegateToAgents;
	}
	if (input.delegatableAgentIds !== undefined) {
		updateData.delegatableAgentIds = input.delegatableAgentIds;
	}
	if (input.maxRecursionDepth !== undefined) {
		updateData.maxRecursionDepth = input.maxRecursionDepth;
	}
	if (input.aiModel !== undefined) {
		updateData.aiModel = input.aiModel;
	}
	if (input.aiProvider !== undefined) {
		updateData.aiProvider = input.aiProvider;
	}
	if (input.temperature !== undefined) {
		updateData.temperature = input.temperature;
	}
	if (input.maxIterations !== undefined) {
		updateData.maxIterations = input.maxIterations;
	}
	if (input.maxTokensPerTurn !== undefined) {
		updateData.maxTokensPerTurn = input.maxTokensPerTurn;
	}
	if (input.timeoutMs !== undefined) {
		updateData.timeoutMs = input.timeoutMs;
	}
	if (input.versionNotes !== undefined) {
		updateData.versionNotes = input.versionNotes;
	}

	// Handle status changes
	if (input.status !== undefined) {
		updateData.status = input.status;
		if (input.status === "PUBLISHED" && !existing.publishedAt) {
			updateData.publishedAt = new Date();
		}
	}

	return db.dynamicAgentConfig.update({
		where: { id },
		data: updateData,
	});
}

/**
 * Publish a dynamic agent (increment version)
 */
export async function publishDynamicAgent(
	id: string,
	params: { userId: string; organizationId?: string; versionNotes?: string },
): Promise<DynamicAgentConfig | null> {
	const existing = await db.dynamicAgentConfig.findFirst({
		where: {
			id,
			userId: params.userId,
			...(params.organizationId
				? { organizationId: params.organizationId }
				: { organizationId: null }),
		},
	});

	if (!existing) {
		return null;
	}

	return db.dynamicAgentConfig.update({
		where: { id },
		data: {
			status: "PUBLISHED",
			version: existing.version + 1,
			versionNotes: params.versionNotes,
			previousVersionId: id, // Self-reference for version history
			publishedAt: new Date(),
		},
	});
}

/**
 * Delete a dynamic agent configuration
 */
export async function deleteDynamicAgentConfig(
	id: string,
	params: { userId: string; organizationId?: string },
): Promise<boolean> {
	const result = await db.dynamicAgentConfig.deleteMany({
		where: {
			id,
			userId: params.userId,
			...(params.organizationId
				? { organizationId: params.organizationId }
				: { organizationId: null }),
		},
	});

	return result.count > 0;
}

// ============================================================================
// Trigger Queries
// ============================================================================

/**
 * Create a trigger for a dynamic agent
 */
export async function createDynamicAgentTrigger(
	input: CreateDynamicAgentTriggerInput,
): Promise<DynamicAgentTrigger> {
	return db.dynamicAgentTrigger.create({
		data: {
			agentConfigId: input.agentConfigId,
			type: input.type,
			name: input.name,
			description: input.description,
			isEnabled: input.isEnabled ?? true,
			schedule: input.schedule,
			timezone: input.timezone ?? "UTC",
			// Encrypted at rest (SOC 2 CC6.1). No live HMAC consumer reads this
			// yet; a future dynamic-agent webhook validator must decrypt-with-
			// passthrough (see the webhook route pattern).
			webhookSecret: input.webhookSecret
				? encryptApiKey(input.webhookSecret)
				: input.webhookSecret,
			eventType: input.eventType,
			eventFilter: input.eventFilter,
			inputTemplate: input.inputTemplate,
		},
	});
}

/**
 * Get triggers for an agent
 */
export async function getDynamicAgentTriggers(
	agentConfigId: string,
): Promise<DynamicAgentTrigger[]> {
	return db.dynamicAgentTrigger.findMany({
		where: { agentConfigId },
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get scheduled triggers due for execution
 */
export async function getDueScheduledTriggers(
	before: Date,
): Promise<DynamicAgentTrigger[]> {
	return db.dynamicAgentTrigger.findMany({
		where: {
			type: "SCHEDULED",
			isEnabled: true,
			nextScheduledAt: { lte: before },
		},
		include: {
			agentConfig: true,
		},
	});
}

/**
 * Update trigger after execution
 */
export async function updateTriggerAfterExecution(
	triggerId: string,
	nextScheduledAt?: Date,
): Promise<DynamicAgentTrigger> {
	return db.dynamicAgentTrigger.update({
		where: { id: triggerId },
		data: {
			lastTriggeredAt: new Date(),
			triggerCount: { increment: 1 },
			...(nextScheduledAt && { nextScheduledAt }),
		},
	});
}

// ============================================================================
// Execution Queries
// ============================================================================

/**
 * Create an execution record
 */
export async function createDynamicAgentExecution(
	input: CreateDynamicAgentExecutionInput,
): Promise<DynamicAgentExecution> {
	return db.dynamicAgentExecution.create({
		data: {
			agentConfigId: input.agentConfigId,
			triggerId: input.triggerId,
			temporalWorkflowId: input.temporalWorkflowId,
			temporalRunId: input.temporalRunId,
			userId: input.userId,
			organizationId: input.organizationId,
			status: input.status ?? "PENDING",
			input: input.input,
			metadata: input.metadata,
		},
	});
}

/**
 * Get execution by ID
 */
export async function getDynamicAgentExecution(
	id: string,
	params: { userId: string; organizationId?: string },
): Promise<DynamicAgentExecution | null> {
	const tenantFilter = params.organizationId
		? { organizationId: params.organizationId }
		: { userId: params.userId, organizationId: null };

	return db.dynamicAgentExecution.findFirst({
		where: {
			id,
			...tenantFilter,
		},
		include: {
			agentConfig: true,
			trigger: true,
		},
	});
}

/**
 * Get execution by Temporal workflow ID
 */
export async function getExecutionByWorkflowId(
	temporalWorkflowId: string,
): Promise<DynamicAgentExecution | null> {
	return db.dynamicAgentExecution.findFirst({
		where: { temporalWorkflowId },
		include: {
			agentConfig: true,
		},
	});
}

/**
 * List executions for an agent
 */
export async function listDynamicAgentExecutions(params: {
	agentConfigId?: string;
	userId: string;
	organizationId?: string;
	status?: DynamicAgentExecutionStatus;
	limit?: number;
	offset?: number;
}): Promise<DynamicAgentExecution[]> {
	const tenantFilter = params.organizationId
		? { organizationId: params.organizationId }
		: { userId: params.userId, organizationId: null };

	return db.dynamicAgentExecution.findMany({
		where: {
			...tenantFilter,
			...(params.agentConfigId && {
				agentConfigId: params.agentConfigId,
			}),
			...(params.status && { status: params.status }),
		},
		take: params.limit ?? 50,
		skip: params.offset ?? 0,
		orderBy: { createdAt: "desc" },
		include: {
			agentConfig: {
				select: {
					id: true,
					name: true,
					displayName: true,
					avatarUrl: true,
				},
			},
		},
	});
}

/**
 * Update execution status and metrics
 */
export async function updateDynamicAgentExecutionStatus(
	id: string,
	update: {
		status?: DynamicAgentExecutionStatus;
		output?: Prisma.InputJsonValue;
		error?: string;
		iterationCount?: number;
		totalTokensUsed?: number;
		totalToolCalls?: number;
		totalDelegations?: number;
		durationMs?: number;
		conversationHistory?: Prisma.InputJsonValue;
		toolOutputRefs?: string[];
		completedAt?: Date;
	},
): Promise<DynamicAgentExecution> {
	const data: Prisma.DynamicAgentExecutionUpdateInput = {};

	if (update.status !== undefined) {
		data.status = update.status;
	}
	if (update.output !== undefined) {
		data.output = update.output;
	}
	if (update.error !== undefined) {
		data.error = update.error;
	}
	if (update.iterationCount !== undefined) {
		data.iterationCount = update.iterationCount;
	}
	if (update.totalTokensUsed !== undefined) {
		data.totalTokensUsed = update.totalTokensUsed;
	}
	if (update.totalToolCalls !== undefined) {
		data.totalToolCalls = update.totalToolCalls;
	}
	if (update.totalDelegations !== undefined) {
		data.totalDelegations = update.totalDelegations;
	}
	if (update.durationMs !== undefined) {
		data.durationMs = update.durationMs;
	}
	if (update.conversationHistory !== undefined) {
		data.conversationHistory = update.conversationHistory;
	}
	if (update.toolOutputRefs !== undefined) {
		data.toolOutputRefs = update.toolOutputRefs;
	}
	if (update.completedAt !== undefined) {
		data.completedAt = update.completedAt;
	}

	// Auto-set startedAt if transitioning to RUNNING
	if (update.status === "RUNNING") {
		data.startedAt = new Date();
	}

	return db.dynamicAgentExecution.update({
		where: { id },
		data,
	});
}

// ============================================================================
// Offloaded Tool Output Queries
// ============================================================================

/**
 * Offload a large tool output
 */
export async function offloadToolOutput(
	input: OffloadToolOutputInput,
): Promise<OffloadedToolOutput> {
	return db.offloadedToolOutput.create({
		data: {
			executionId: input.executionId,
			toolName: input.toolName,
			summary: input.summary,
			fullOutput: input.fullOutput,
			outputSizeBytes: input.outputSizeBytes,
			contentHash: input.contentHash,
			expiresAt: input.expiresAt,
			userId: input.userId,
			organizationId: input.organizationId,
		},
	});
}

/**
 * Get offloaded tool output by ID
 */
export async function getOffloadedToolOutput(
	id: string,
): Promise<OffloadedToolOutput | null> {
	return db.offloadedToolOutput.findUnique({
		where: { id },
	});
}

/**
 * Get offloaded outputs for an execution
 */
export async function getExecutionToolOutputs(
	executionId: string,
): Promise<OffloadedToolOutput[]> {
	return db.offloadedToolOutput.findMany({
		where: { executionId },
		orderBy: { createdAt: "asc" },
	});
}

/**
 * Check if output with hash exists (deduplication)
 */
export async function findOffloadedOutputByHash(
	contentHash: string,
	executionId: string,
): Promise<OffloadedToolOutput | null> {
	return db.offloadedToolOutput.findFirst({
		where: {
			contentHash,
			executionId,
		},
	});
}

/**
 * Cleanup expired offloaded outputs
 */
export async function cleanupExpiredToolOutputs(): Promise<number> {
	const result = await db.offloadedToolOutput.deleteMany({
		where: {
			expiresAt: { lte: new Date() },
		},
	});
	return result.count;
}

// ============================================================================
// Favorites Queries
// ============================================================================

/**
 * Add an agent to favorites
 */
export async function addAgentToFavorites(
	userId: string,
	agentConfigId: string,
): Promise<DynamicAgentFavorite> {
	return db.dynamicAgentFavorite.upsert({
		where: {
			userId_agentConfigId: { userId, agentConfigId },
		},
		create: {
			userId,
			agentConfigId,
		},
		update: {}, // No-op if already exists
	});
}

/**
 * Remove an agent from favorites
 */
export async function removeAgentFromFavorites(
	userId: string,
	agentConfigId: string,
): Promise<boolean> {
	const result = await db.dynamicAgentFavorite.deleteMany({
		where: { userId, agentConfigId },
	});
	return result.count > 0;
}

/**
 * Get user's favorite agents
 */
export async function getUserFavoriteAgents(
	userId: string,
): Promise<DynamicAgentConfig[]> {
	const favorites = await db.dynamicAgentFavorite.findMany({
		where: { userId },
		include: {
			agentConfig: true,
		},
		orderBy: { createdAt: "desc" },
	});

	return favorites.map((f) => f.agentConfig);
}

/**
 * Check if an agent is favorited by user
 */
export async function isAgentFavorited(
	userId: string,
	agentConfigId: string,
): Promise<boolean> {
	const favorite = await db.dynamicAgentFavorite.findUnique({
		where: {
			userId_agentConfigId: { userId, agentConfigId },
		},
	});
	return favorite !== null;
}

// ============================================================================
// Export Types
// ============================================================================

export type {
	DynamicAgentConfig,
	DynamicAgentExecution,
	DynamicAgentFavorite,
	DynamicAgentTrigger,
	OffloadedToolOutput,
};
