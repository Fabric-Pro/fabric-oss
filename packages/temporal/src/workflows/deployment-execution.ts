/**
 * Deployment Execution Workflow
 *
 * Child workflow started by the Agent Supervisor to execute a single agent invocation.
 * This workflow runs entirely within Temporal for full observability and durability:
 *
 * 1. Loads deployment configuration (template + instance)
 * 2. Builds execution context (system prompt, tools, knowledge connections)
 * 3. Fetches knowledge from configured sources (RAG)
 * 4. Executes the AI agent with tool calling loop
 * 5. Updates execution status and signals supervisor on completion
 *
 * This approach replaces the previous A2A-based design which required an external
 * runtime service. All execution now happens within Temporal activities.
 */

import {
	ApplicationFailure,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as deploymentActivities from "../activities/deployment-execution";

// =============================================================================
// TYPES
// =============================================================================

export interface DeploymentExecutionInput {
	executionId: string;
	deploymentId: string;
	instanceId: string;
	userId: string;
	organizationId?: string;
	input: Record<string, unknown>;
	triggerType: string;
	triggerId?: string;
	timeoutMs: number;
	supervisorWorkflowId?: string;
	/**
	 * Optional conversation ID for multi-turn executions.
	 * If provided, previous messages will be loaded and the response will be appended.
	 * If not provided, this is a single-turn execution.
	 */
	conversationId?: string;
	/**
	 * Optional image references for multimodal input.
	 * Each ref points to an S3 object — images are downloaded at execution time.
	 */
	imageRefs?: Array<{
		storagePath: string;
		mimeType: string;
		name: string;
	}>;
}

export interface DeploymentExecutionOutput {
	executionId: string;
	status: "COMPLETED" | "FAILED" | "CANCELLED";
	output?: Record<string, unknown>;
	error?: string;
	durationMs: number;
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
}

/**
 * Execution progress state for UI polling
 * UI can query this to show real-time progress without token streaming
 */
export interface ExecutionProgress {
	phase:
		| "initializing"
		| "loading_config"
		| "building_context"
		| "fetching_knowledge"
		| "executing_agent"
		| "completing"
		| "completed"
		| "failed"
		| "cancelled";
	message: string;
	/** Current tool call in progress, if any */
	currentToolCall?: {
		name: string;
		startedAt: number;
	};
	/** Completed tool calls so far */
	completedToolCalls: Array<{
		name: string;
		durationMs: number;
	}>;
	/** Knowledge fetch progress */
	knowledgeProgress?: {
		totalSources: number;
		fetchedSources: number;
		totalChunks: number;
	};
	/** Timestamp of last update */
	updatedAt: number;
}

// =============================================================================
// SIGNALS & QUERIES
// =============================================================================

export const cancelExecutionSignal = defineSignal("cancelExecution");

/**
 * Signal name constant for use by callers triggering cancellation.
 */
export const CANCEL_EXECUTION_SIGNAL = "cancelExecution";

/**
 * Query handler for execution progress
 * UI can poll this to show real-time progress without token streaming
 */
export const progressQuery = defineQuery<ExecutionProgress>("progress");

/**
 * Execution event for real-time streaming via external API
 */
export interface ExecutionEvent {
	event: string;
	data: Record<string, unknown>;
	timestamp: string;
}

/**
 * Query handler for execution events (cursor-based: returns events since index)
 */
export const executionEventsQuery = defineQuery<ExecutionEvent[], [number]>(
	"executionEvents",
);

// =============================================================================
// ACTIVITIES
// =============================================================================

const activities = proxyActivities<typeof deploymentActivities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

const knowledgeActivities = proxyActivities<typeof deploymentActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2,
	},
});

const agentActivities = proxyActivities<typeof deploymentActivities>({
	startToCloseTimeout: "30 minutes",
	heartbeatTimeout: "5 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// WORKFLOW IMPLEMENTATION
// =============================================================================

export async function deploymentExecutionWorkflow(
	input: DeploymentExecutionInput,
): Promise<DeploymentExecutionOutput> {
	const startTime = Date.now();
	let cancelled = false;

	// Progress state for UI polling
	let progress: ExecutionProgress = {
		phase: "initializing",
		message: "Initializing execution...",
		completedToolCalls: [],
		updatedAt: Date.now(),
	};

	// Helper to update progress
	const updateProgress = (
		update: Partial<Omit<ExecutionProgress, "updatedAt">>,
	) => {
		progress = { ...progress, ...update, updatedAt: Date.now() };
	};

	// Handle cancellation signal
	setHandler(cancelExecutionSignal, () => {
		log.info("Received cancellation signal", {
			executionId: input.executionId,
		});
		cancelled = true;
		updateProgress({ phase: "cancelled", message: "Execution cancelled" });
		emitEvent("execution.cancelled", { reason: "Execution cancelled" });
	});

	// Handle progress query
	setHandler(progressQuery, () => progress);

	// Event log for external API streaming
	const eventLog: ExecutionEvent[] = [];
	const MAX_EVENT_LOG_SIZE = 200;

	const emitEvent = (event: string, data: Record<string, unknown>) => {
		const entry: ExecutionEvent = {
			event,
			data,
			timestamp: new Date().toISOString(),
		};
		eventLog.push(entry);
		// Auto-prune to prevent memory growth
		if (eventLog.length > MAX_EVENT_LOG_SIZE) {
			eventLog.splice(0, eventLog.length - MAX_EVENT_LOG_SIZE);
		}
	};

	// Handle execution events query (cursor-based: returns events since index)
	setHandler(executionEventsQuery, (cursor: number) => {
		return eventLog.slice(cursor);
	});

	log.info("Starting deployment execution", {
		executionId: input.executionId,
		deploymentId: input.deploymentId,
		triggerType: input.triggerType,
	});

	try {
		// Check for early cancellation
		if (cancelled) {
			return {
				executionId: input.executionId,
				status: "CANCELLED",
				error: "Execution cancelled before start",
				durationMs: Date.now() - startTime,
			};
		}

		// Step 1: Load deployment configuration (template + instance + integrations)
		updateProgress({
			phase: "loading_config",
			message: "Loading deployment configuration...",
		});
		emitEvent("execution.started", { executionId: input.executionId });
		emitEvent("execution.phase_changed", {
			phase: "loading_config",
			message: "Loading deployment configuration...",
		});

		const config = await activities.loadDeploymentConfiguration({
			deploymentId: input.deploymentId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (!config) {
			throw new Error(`Deployment ${input.deploymentId} not found`);
		}

		log.info("Loaded deployment configuration", {
			templateName: config.template.name,
			instanceName: config.instance.name,
			hasIntegrationConfigurations:
				config.integrationConfigurations.length > 0,
			hasToolConnections: Object.keys(config.toolConnections).length > 0,
			workspaceCount: config.workspaceIds.length,
		});

		// Check for cancellation
		if (cancelled) {
			return {
				executionId: input.executionId,
				status: "CANCELLED",
				error: "Execution cancelled during configuration",
				durationMs: Date.now() - startTime,
			};
		}

		// Step 2: Build execution context
		updateProgress({
			phase: "building_context",
			message: `Building context for ${config.template.displayName}...`,
		});
		emitEvent("execution.phase_changed", {
			phase: "building_context",
			message: "Building context...",
		});

		const context = await activities.buildExecutionContext({
			config,
			input: input.input,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		log.info("Built execution context", {
			systemPromptLength: context.systemPrompt.length,
			toolCount: context.tools.length,
			knowledgeSourceCount: context.knowledgeSources.length,
			mcpConfigCount: context.mcpConfigIds.length,
		});

		// Check for cancellation
		if (cancelled) {
			return {
				executionId: input.executionId,
				status: "CANCELLED",
				error: "Execution cancelled after context build",
				durationMs: Date.now() - startTime,
			};
		}

		// Step 3: Fetch knowledge from configured sources (RAG)
		const userMessage =
			(input.input.message as string) ||
			(input.input.prompt as string) ||
			(input.input.query as string) ||
			JSON.stringify(input.input);

		let knowledgeResult:
			| Awaited<ReturnType<typeof deploymentActivities.fetchKnowledge>>
			| undefined;
		const totalKnowledgeSources =
			context.workspaceIds.length + context.knowledgeSources.length;

		if (totalKnowledgeSources > 0) {
			updateProgress({
				phase: "fetching_knowledge",
				message: `Fetching knowledge from ${totalKnowledgeSources} source(s)...`,
				knowledgeProgress: {
					totalSources: totalKnowledgeSources,
					fetchedSources: 0,
					totalChunks: 0,
				},
			});
			emitEvent("execution.phase_changed", {
				phase: "fetching_knowledge",
				message: "Fetching knowledge...",
			});

			log.info("Fetching knowledge sources", {
				workspaceCount: context.workspaceIds.length,
				knowledgeSourceCount: context.knowledgeSources.length,
			});

			knowledgeResult = await knowledgeActivities.fetchKnowledge({
				executionId: input.executionId,
				context,
				query: userMessage,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			updateProgress({
				knowledgeProgress: {
					totalSources: totalKnowledgeSources,
					fetchedSources: knowledgeResult.sourcesFetched.length,
					totalChunks: knowledgeResult.totalChunks,
				},
			});

			emitEvent("execution.knowledge_completed", {
				totalChunks: knowledgeResult.totalChunks,
				sourcesFetched: knowledgeResult.sourcesFetched.length,
			});

			log.info("Knowledge fetch completed", {
				totalChunks: knowledgeResult.totalChunks,
				sourcesFetched: knowledgeResult.sourcesFetched,
			});
		}

		// Check for cancellation
		if (cancelled) {
			return {
				executionId: input.executionId,
				status: "CANCELLED",
				error: "Execution cancelled after knowledge fetch",
				durationMs: Date.now() - startTime,
			};
		}

		// Step 3.5: Load conversation history if multi-turn
		let conversationHistory:
			| Array<{ role: "user" | "assistant"; content: string }>
			| undefined;

		if (input.conversationId) {
			updateProgress({
				phase: "executing_agent",
				message: "Loading conversation history...",
			});

			conversationHistory = await activities.loadConversationHistory({
				conversationId: input.conversationId,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			log.info("Loaded conversation history", {
				conversationId: input.conversationId,
				messageCount: conversationHistory.length,
			});
		}

		// Step 4: Execute the agent with tool loop
		updateProgress({
			phase: "executing_agent",
			message: `Executing agent with ${context.model}...`,
		});
		emitEvent("execution.phase_changed", {
			phase: "executing_agent",
			message: "Executing agent...",
		});

		log.info("Invoking agent", {
			model: context.model,
			hasKnowledge: knowledgeResult
				? knowledgeResult.totalChunks > 0
				: false,
			hasConversationHistory: !!conversationHistory?.length,
		});

		const result = await agentActivities.invokeDeploymentAgent({
			executionId: input.executionId,
			context,
			input: input.input,
			knowledgeResult,
			userId: input.userId,
			organizationId: input.organizationId,
			timeoutMs: input.timeoutMs,
			conversationHistory,
			imageRefs: input.imageRefs,
		});

		// Update progress with completed tool calls
		if (result.toolCalls && result.toolCalls.length > 0) {
			updateProgress({
				completedToolCalls: result.toolCalls.map((tc) => ({
					name: tc.name,
					durationMs: tc.durationMs || 0,
				})),
			});
		}

		// Emit tool calls summary if any
		if (result.toolCalls && result.toolCalls.length > 0) {
			emitEvent("execution.tool_calls_summary", {
				toolCalls: result.toolCalls.map((tc) => ({
					name: tc.name,
					status: tc.status || "success",
					durationMs: tc.durationMs || 0,
				})),
			});
		}

		// Emit artifact events if any
		if (result.artifacts && result.artifacts.length > 0) {
			for (const artifact of result.artifacts) {
				emitEvent("execution.artifact_created", {
					artifactId: artifact.id,
					name: artifact.name,
					mimeType: artifact.mimeType,
				});
			}
		}

		log.info("Agent execution completed", {
			executionId: input.executionId,
			hasOutput: !!result.output,
			toolCallCount: result.toolCalls?.length ?? 0,
		});

		// Step 5: Save conversation messages if multi-turn
		if (input.conversationId) {
			await activities.saveConversationMessages({
				conversationId: input.conversationId,
				userId: input.userId,
				organizationId: input.organizationId,
				userMessage,
				assistantResponse:
					(result.output?.response as string) ||
					"No response generated",
				tokenUsage: result.tokenUsage,
			});
		}

		// Step 6: Update execution record
		updateProgress({
			phase: "completing",
			message: "Finalizing execution...",
		});

		await activities.completeExecution({
			executionId: input.executionId,
			status: "COMPLETED",
			output: result.output,
			tokenUsage: result.tokenUsage,
			durationMs: Date.now() - startTime,
		});

		// Signal supervisor that execution is complete
		if (input.supervisorWorkflowId) {
			await activities.signalSupervisorCompletion({
				supervisorWorkflowId: input.supervisorWorkflowId,
				executionId: input.executionId,
				success: true,
			});
		}

		updateProgress({
			phase: "completed",
			message: "Execution completed successfully",
		});
		emitEvent("execution.completed", {
			output: result.output || {},
			tokenUsage: result.tokenUsage || {},
			durationMs: Date.now() - startTime,
		});

		return {
			executionId: input.executionId,
			status: "COMPLETED",
			output: result.output,
			durationMs: Date.now() - startTime,
			tokenUsage: result.tokenUsage,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Deployment execution failed", {
			executionId: input.executionId,
			error: errorMessage,
		});

		updateProgress({
			phase: "failed",
			message: `Execution failed: ${errorMessage}`,
		});
		emitEvent("execution.failed", {
			error: errorMessage,
			durationMs: Date.now() - startTime,
		});

		// Update execution record as failed
		await activities.completeExecution({
			executionId: input.executionId,
			status: "FAILED",
			error: errorMessage,
			durationMs: Date.now() - startTime,
		});

		// Signal supervisor that execution failed
		if (input.supervisorWorkflowId) {
			await activities.signalSupervisorCompletion({
				supervisorWorkflowId: input.supervisorWorkflowId,
				executionId: input.executionId,
				success: false,
			});
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DEPLOYMENT_EXECUTION_FAILED",
		);
	}
}
