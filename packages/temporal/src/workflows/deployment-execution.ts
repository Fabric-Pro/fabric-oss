import type { NativeTestAuthority } from "../activities/shared/native-agent-test-authority";
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
	getExternalWorkflowHandle,
	log,
	patched,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as deploymentActivities from "../activities/deployment-execution";
import {
	hasUnconfirmedAgentEffect,
	type NativeAgentAdmission,
} from "../lib/agent-execution-native-protocol";
import {
	persistNativeAgentCompletion,
	registerNativeAgentReceipt,
} from "./lib/register-native-agent-receipt";
import {
	executeDurableSavedAgentTurn,
	SAVED_AGENT_DURABLE_STEPS_PATCH,
} from "./saved-agent-durable-turn";

// =============================================================================
// TYPES
// =============================================================================

export interface DeploymentExecutionInput {
	/** Only server-admitted native executions use the durable receipt protocol. */
	nativeAdmission?: NativeAgentAdmission;
	testAuthority?: NativeTestAuthority;
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
const finalizationActivities = proxyActivities<typeof deploymentActivities>({
	startToCloseTimeout: "1 minute",
	heartbeatTimeout: "15 seconds",
	retry: { initialInterval: "1s", maximumInterval: "30s" },
});

// =============================================================================
// WORKFLOW IMPLEMENTATION
// =============================================================================

/** Distinct type keeps pre-native workers from accepting a new protocol run. */
export async function nativeDeploymentExecutionWorkflow(
	input: DeploymentExecutionInput,
): Promise<DeploymentExecutionOutput> {
	if (!input.nativeAdmission) {
		throw ApplicationFailure.nonRetryable(
			"Native execution requires a server admission descriptor",
			"NATIVE_AGENT_ADMISSION_REQUIRED",
		);
	}
	return deploymentExecutionWorkflow(input);
}

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

	// Identity persistence has its own durable retry lifecycle. A storage failure
	// must not enter the legacy catch and claim agent work failed before it began.
	await registerNativeAgentReceipt(input);
	const nativeSteps = patched(SAVED_AGENT_DURABLE_STEPS_PATCH);
	let nativeFinalizing = false;
	async function completeExecution(
		params: Parameters<typeof activities.completeExecution>[0],
	) {
		if (nativeSteps) {
			nativeFinalizing = true;
			if (input.nativeAdmission) {
				await persistNativeAgentCompletion(input, {
					status: params.status,
					output: params.output ?? {},
					error: params.error,
					durationMs: params.durationMs,
					tokenUsage: params.tokenUsage,
				});
			} else {
				await finalizationActivities.completeDurableDeploymentProjection(
					params,
				);
			}
			nativeFinalizing = false;
		} else {
			await activities.completeExecution(params);
		}
	}

	async function notifySupervisor(success: boolean) {
		if (!input.supervisorWorkflowId) return;
		if (nativeSteps && patched("saved-agent-native-supervisor-signal-v1")) {
			try {
				await getExternalWorkflowHandle(
					input.supervisorWorkflowId,
				).signal("executionCompleted", {
					executionId: input.executionId,
					success,
				});
			} catch {
				// A missing/closed parent cannot invalidate the durably stored outcome.
				log.warn(
					"Supervisor completion notification was not delivered",
				);
			}
			return;
		}
		await activities.signalSupervisorCompletion({
			supervisorWorkflowId: input.supervisorWorkflowId,
			executionId: input.executionId,
			success,
		});
	}

	try {
		// Check for early cancellation
		if (cancelled) {
			if (nativeSteps) {
				await completeExecution({
					executionId: input.executionId,
					status: "CANCELLED",
					output: {},
					error: "Execution cancelled before start",
					durationMs: Date.now() - startTime,
				});
			}
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
			...(input.testAuthority
				? {
						nativeTestBoundary: {
							executionId: input.executionId,
							authority: input.testAuthority,
						},
					}
				: {}),
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
			if (nativeSteps) {
				await completeExecution({
					executionId: input.executionId,
					status: "CANCELLED",
					output: {},
					error: "Execution cancelled during configuration",
					durationMs: Date.now() - startTime,
				});
			}
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
			if (nativeSteps) {
				await completeExecution({
					executionId: input.executionId,
					status: "CANCELLED",
					output: {},
					error: "Execution cancelled after context build",
					durationMs: Date.now() - startTime,
				});
			}
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
			if (nativeSteps) {
				await completeExecution({
					executionId: input.executionId,
					status: "CANCELLED",
					output: {},
					error: "Execution cancelled after knowledge fetch",
					durationMs: Date.now() - startTime,
				});
			}
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
			message: `Executing agent with ${context.model ?? "the default model"}...`,
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

		const invocation = {
			executionId: input.executionId,
			context,
			input: input.input,
			knowledgeResult,
			userId: input.userId,
			organizationId: input.organizationId,
			timeoutMs: input.timeoutMs,
			conversationHistory,
			imageRefs: input.imageRefs,
		};
		let result: deploymentActivities.InvokeAgentResult;
		if (nativeSteps) {
			const prepared =
				await activities.prepareDeploymentAgentTurn(invocation);
			const turn = await executeDurableSavedAgentTurn(prepared, {
				isCancelled: () => cancelled,
			});
			if (turn.cancelled) {
				const error = turn.error ?? "Execution cancelled";
				const output = {
					response: turn.response,
					toolCalls: turn.toolCalls,
					inspectionRequired: hasUnconfirmedAgentEffect(
						turn.toolCalls,
					),
					cancelled: true,
				};
				await completeExecution({
					executionId: input.executionId,
					status: "CANCELLED",
					output,
					error,
					tokenUsage: turn.tokenUsage,
					durationMs: Date.now() - startTime,
				});
				await notifySupervisor(false);
				updateProgress({ phase: "cancelled", message: error });
				emitEvent("execution.cancelled", { output, reason: error });
				return {
					executionId: input.executionId,
					status: "CANCELLED",
					output,
					error,
					tokenUsage: turn.tokenUsage,
					durationMs: Date.now() - startTime,
				};
			}
			if (!turn.success) {
				const error =
					turn.error || "Native agent step requires inspection";
				const inspectionRequired = hasUnconfirmedAgentEffect(
					turn.toolCalls,
				);
				const output = {
					response: turn.response,
					toolCalls: turn.toolCalls,
					inspectionRequired,
					error,
				};
				await completeExecution({
					executionId: input.executionId,
					status: "FAILED",
					output,
					error,
					tokenUsage: turn.tokenUsage,
					durationMs: Date.now() - startTime,
				});
				await notifySupervisor(false);
				updateProgress({ phase: "failed", message: error });
				emitEvent("execution.failed", {
					error,
					inspectionRequired,
				});
				return {
					executionId: input.executionId,
					status: "FAILED",
					output,
					error,
					tokenUsage: turn.tokenUsage,
					durationMs: Date.now() - startTime,
				};
			}
			result = await activities.finishDeploymentAgentTurn({
				executionId: input.executionId,
				result: turn,
			});
		} else {
			result = await agentActivities.invokeDeploymentAgent(invocation);
		}

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

		await completeExecution({
			executionId: input.executionId,
			status: "COMPLETED",
			output: result.output,
			tokenUsage: result.tokenUsage,
			durationMs: Date.now() - startTime,
		});

		// Signal supervisor that execution is complete
		await notifySupervisor(true);

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
		if (nativeFinalizing) {
			throw error;
		}
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
		await completeExecution({
			executionId: input.executionId,
			status: "FAILED",
			error: errorMessage,
			durationMs: Date.now() - startTime,
		});

		// Signal supervisor that execution failed
		await notifySupervisor(false);

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DEPLOYMENT_EXECUTION_FAILED",
		);
	}
}
