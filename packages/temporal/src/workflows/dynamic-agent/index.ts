/**
 * Dynamic Agent Workflow
 *
 * A durable workflow that executes agents created via the Visual Agent Builder.
 * Combines configuration loading, RAG knowledge retrieval, goal-oriented
 * execution, and context pruning for long-running conversations.
 *
 * Key Features:
 * - Loads agent config from database (Visual Builder output)
 * - Fetches knowledge from connected workspaces (RAG)
 * - Executes with goal-oriented iteration loop
 * - Supports sub-agent delegation via run_agent
 * - Prunes context for long conversations
 * - Handles multiple trigger types (webhook, schedule, slack, email)
 */

import {
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as agenticLoopActivities from "../../activities/agentic-loop";
import type * as goalOrientedActivities from "../../activities/goal-oriented-agent";

import {
	createInitialDynamicAgentState,
	DEFAULT_DYNAMIC_AGENT_CONFIG,
	type DynamicAgentInput,
	type DynamicAgentOutput,
	type DynamicAgentProgress,
	type DynamicAgentWorkflowState,
	type ExecutedStep,
} from "./types";

// Re-export types
export * from "./types";

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSignal = defineSignal("cancel");
export const progressQuery = defineQuery<DynamicAgentProgress>("progress");
export const statusQuery =
	defineQuery<DynamicAgentWorkflowState["status"]>("status");

// =============================================================================
// Activity Proxies
// =============================================================================

// Dynamic agent specific activities
const dynamicActivities = proxyActivities<typeof agenticLoopActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Goal-oriented activities
const goalActivities = proxyActivities<typeof goalOrientedActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Long-running execution activities
const executionActivities = proxyActivities<typeof goalOrientedActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "30s",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Main Workflow
// =============================================================================

export async function dynamicAgentWorkflow(
	input: DynamicAgentInput,
): Promise<DynamicAgentOutput> {
	const state = createInitialDynamicAgentState(input);
	const config = DEFAULT_DYNAMIC_AGENT_CONFIG;

	// ==========================================================================
	// Signal & Query Handlers
	// ==========================================================================

	setHandler(cancelSignal, () => {
		log.info("Received cancel signal", { executionId: state.executionId });
		state.cancelled = true;
	});

	setHandler(progressQuery, () => state.currentProgress);
	setHandler(statusQuery, () => state.status);

	// ==========================================================================
	// Helper Functions
	// ==========================================================================

	function updateProgress(
		phase: DynamicAgentProgress["phase"],
		message: string,
		goalAchieved = false,
	) {
		state.currentProgress = {
			executionId: state.executionId,
			agentId: state.agentConfig?.id,
			agentName: state.agentConfig?.displayName,
			phase,
			message,
			currentIteration: state.currentIteration,
			maxIterations: state.maxIterations,
			goalAchieved,
			stepsCompleted: state.executedSteps.filter(
				(s) => s.status === "completed",
			).length,
			totalSteps: state.taskPlan?.steps.length || 0,
			timestamp: new Date().toISOString(),
		};
	}

	function isCancelled(): boolean {
		return state.cancelled;
	}

	// ==========================================================================
	// Main Execution
	// ==========================================================================

	try {
		log.info("Starting dynamic agent workflow", {
			executionId: state.executionId,
			agentConfigId: input.agentConfigId,
			trigger: input.trigger.type,
		});

		// Check for cancellation
		if (isCancelled()) {
			state.status = "cancelled";
			return buildOutput(
				state,
				"CANCELLED",
				false,
				"Execution cancelled",
			);
		}

		// ======================================================================
		// Phase 1: Load Agent Configuration
		// ======================================================================
		updateProgress("loading_config", "Loading agent configuration...");
		state.status = "running";

		if (!state.agentConfig && input.agentConfigId) {
			// Load from database
			// TODO: Create activity to load DynamicAgentConfig from DB
			log.info("Loading agent config from database", {
				configId: input.agentConfigId,
			});

			// For now, throw if no config provided
			throw new Error(
				`Agent config ${input.agentConfigId} not found. Inline config required.`,
			);
		}

		if (!state.agentConfig) {
			throw new Error("No agent configuration provided");
		}

		log.info("Agent configuration loaded", {
			agentId: state.agentConfig.id,
			agentName: state.agentConfig.displayName,
			workspaces: state.agentConfig.workspaceIds.length,
			tools: state.agentConfig.mcpConfigIds.length,
		});

		// ======================================================================
		// Phase 2: Fetch Knowledge Context (RAG)
		// ======================================================================
		if (config.enableRag && state.agentConfig.workspaceIds.length > 0) {
			updateProgress(
				"fetching_knowledge",
				"Fetching relevant knowledge...",
			);

			try {
				// Use semantic search to fetch relevant knowledge
				const searchResults = await dynamicActivities.searchDataSources(
					{
						query: `${state.goal}\n\n${input.input.message}`,
						workspaceIds: state.agentConfig.workspaceIds,
						limit: 10,
						userId: input.userId,
						organizationId: input.organizationId,
					},
				);

				if (searchResults.results.length > 0) {
					state.knowledgeContext = buildKnowledgePrompt(
						searchResults.results,
					);
					log.info("Knowledge context loaded", {
						chunks: searchResults.results.length,
					});
				}
			} catch (error) {
				log.warn("Failed to fetch knowledge, continuing without RAG", {
					error: error instanceof Error ? error.message : "Unknown",
				});
			}
		}

		// ======================================================================
		// Phase 3: Goal-Oriented Execution Loop
		// ======================================================================

		let goalAchieved = false;

		while (
			!goalAchieved &&
			state.currentIteration < state.maxIterations &&
			!isCancelled()
		) {
			state.currentIteration++;

			log.info("Starting iteration", {
				iteration: state.currentIteration,
				maxIterations: state.maxIterations,
			});

			// ------------------------------------------------------------------
			// Context Pruning (if needed)
			// ------------------------------------------------------------------
			if (config.enableContextPruning) {
				const contextSize = estimateContextSize(
					state.conversationHistory,
					state.agentConfig.instructions,
					state.knowledgeContext,
				);

				if (contextSize > config.contextPruningThreshold) {
					log.info("Pruning conversation context");
					updateProgress(
						"executing",
						`Iteration ${state.currentIteration}: Optimizing context...`,
					);

					const pruneResult =
						await dynamicActivities.pruneConversationContext({
							context: {
								messages: state.conversationHistory.map(
									(m) => ({
										role: m.role,
										content: m.content,
										timestamp: m.timestamp,
									}),
								),
								systemPrompt: state.agentConfig.instructions,
								knowledgeContext: state.knowledgeContext,
							},
							maxTokens: config.contextPruningThreshold,
							preserveLastN: 10,
							strategy: "token_budget",
							userId: input.userId,
							organizationId: input.organizationId,
						});

					if (pruneResult.wasPruned) {
						// Update conversation history with pruned version
						state.conversationHistory =
							pruneResult.context.messages.map((m) => ({
								role: m.role as "user" | "assistant" | "system",
								content: m.content,
								timestamp:
									m.timestamp || new Date().toISOString(),
							}));

						log.info("Context pruned", {
							originalTokens: pruneResult.originalTokens,
							prunedTokens: pruneResult.prunedTokens,
							messagesRemoved: pruneResult.messagesRemoved,
						});
					}
				}
			}

			// ------------------------------------------------------------------
			// Step 3a: Plan
			// ------------------------------------------------------------------
			updateProgress(
				"planning",
				`Iteration ${state.currentIteration}: Planning approach...`,
			);

			const planResult = await goalActivities.createGoalOrientedPlan({
				goal: state.goal,
				userMessage: input.input.message,
				systemPrompt: state.agentConfig.instructions,
				knowledgeContext: state.knowledgeContext,
				previousAttempts: state.verificationHistory,
				variables: state.variables as unknown as Record<
					string,
					{
						name: string;
						value: unknown;
						setBy: string;
						setAt: string;
						scope: "workflow" | "step";
					}
				>,
				userId: input.userId,
				organizationId: input.organizationId,
				mcpConfigIds: state.agentConfig.mcpConfigIds,
			});

			state.taskPlan = planResult.plan;

			log.info("Plan created", {
				stepCount: state.taskPlan.steps.length,
				strategy: state.taskPlan.strategy,
			});

			// ------------------------------------------------------------------
			// Step 3b: Execute Plan Steps
			// ------------------------------------------------------------------
			updateProgress(
				"executing",
				`Iteration ${state.currentIteration}: Executing ${state.taskPlan.steps.length} steps...`,
			);

			for (
				let stepIndex = 0;
				stepIndex < state.taskPlan.steps.length;
				stepIndex++
			) {
				if (isCancelled()) {
					break;
				}

				const step = state.taskPlan.steps[stepIndex];
				const stepStartTime = Date.now();

				updateProgress(
					"executing",
					`Step ${stepIndex + 1}/${state.taskPlan.steps.length}: ${step.description}`,
				);

				const executedStep: ExecutedStep = {
					id: step.id,
					type: "execution",
					description: step.description,
					status: "completed",
					startedAt: new Date().toISOString(),
				};

				try {
					const stepResult =
						await executionActivities.executeGoalStep({
							step,
							systemPrompt: state.agentConfig.instructions,
							knowledgeContext: state.knowledgeContext,
							variables: state.variables as unknown as Record<
								string,
								{
									name: string;
									value: unknown;
									setBy: string;
									setAt: string;
									scope: "workflow" | "step";
								}
							>,
							previousStepResults: state.executedSteps,
							userId: input.userId,
							organizationId: input.organizationId,
							mcpConfigIds: state.agentConfig.mcpConfigIds,
							model: state.agentConfig.model,
						});

					executedStep.completedAt = new Date().toISOString();
					executedStep.durationMs = Date.now() - stepStartTime;
					executedStep.toolCalls = stepResult.toolCalls;
					executedStep.artifacts = stepResult.artifacts;

					// Update variables
					if (stepResult.variables) {
						state.variables = {
							...state.variables,
							...stepResult.variables,
						};
					}

					// Accumulate response
					if (stepResult.response) {
						state.accumulatedResponse += `${stepResult.response}\n\n`;

						// Add to conversation history
						state.conversationHistory.push({
							role: "assistant",
							content: stepResult.response,
							timestamp: new Date().toISOString(),
						});
					}

					// Track tokens
					if (stepResult.tokenUsage) {
						state.totalInputTokens +=
							stepResult.tokenUsage.inputTokens || 0;
						state.totalOutputTokens +=
							stepResult.tokenUsage.outputTokens || 0;
					}

					// Track artifacts
					if (stepResult.artifacts) {
						state.artifacts.push(
							...stepResult.artifacts.map((a) => ({
								id: a.id,
								type: a.type,
								name: a.name,
							})),
						);
					}

					log.info("Step completed", {
						stepId: step.id,
						durationMs: executedStep.durationMs,
						toolCalls: stepResult.toolCalls?.length || 0,
					});
				} catch (error) {
					const errorMessage =
						error instanceof Error
							? error.message
							: "Unknown error";

					executedStep.status = "failed";
					executedStep.error = errorMessage;
					executedStep.completedAt = new Date().toISOString();
					executedStep.durationMs = Date.now() - stepStartTime;

					// Attempt recovery if enabled
					if (config.autoRecovery) {
						const recovered = await attemptRecovery(
							step,
							errorMessage,
							config.maxRecoveryAttempts,
							input.userId,
							input.organizationId,
						);

						if (recovered) {
							executedStep.status = "completed";
							executedStep.error = undefined;
						}
					}

					log.warn("Step failed", {
						stepId: step.id,
						error: errorMessage,
						recovered: executedStep.status === "completed",
					});
				}

				state.executedSteps.push(executedStep);
			}

			// ------------------------------------------------------------------
			// Step 3c: Verify Goal Achievement
			// ------------------------------------------------------------------
			if (!isCancelled() && config.enableGoalVerification) {
				updateProgress(
					"verifying",
					`Iteration ${state.currentIteration}: Verifying goal achievement...`,
				);

				const verificationResult =
					await goalActivities.verifyGoalAchievement({
						goal: state.goal,
						successCriteria: state.successCriteria,
						executedSteps: state.executedSteps,
						accumulatedResponse: state.accumulatedResponse,
						variables: state.variables as unknown as Record<
							string,
							{
								name: string;
								value: unknown;
								setBy: string;
								setAt: string;
								scope: "workflow" | "step";
							}
						>,
						userId: input.userId,
						organizationId: input.organizationId,
					});

				state.verificationHistory.push(verificationResult);
				goalAchieved = verificationResult.achieved;

				log.info("Goal verification completed", {
					achieved: goalAchieved,
					confidence: verificationResult.confidence,
					iteration: state.currentIteration,
				});

				if (
					!goalAchieved &&
					state.currentIteration < state.maxIterations
				) {
					updateProgress(
						"planning",
						`Goal not achieved (${Math.round(verificationResult.confidence * 100)}% confidence). Re-planning...`,
					);
				}
			} else if (!config.enableGoalVerification) {
				// If verification is disabled, consider goal achieved after first iteration
				goalAchieved = true;
			}
		}

		// ======================================================================
		// Phase 4: Build Final Output
		// ======================================================================

		if (isCancelled()) {
			state.status = "cancelled";
			return buildOutput(
				state,
				"CANCELLED",
				false,
				"Execution cancelled",
			);
		}

		if (goalAchieved) {
			updateProgress("completed", "Goal achieved successfully!", true);
			state.status = "completed";
			return buildOutput(state, "COMPLETED", true);
		}

		// Max iterations reached
		updateProgress(
			"completed",
			`Max iterations (${state.maxIterations}) reached`,
			false,
		);
		state.status = "completed";

		return buildOutput(
			state,
			"COMPLETED",
			false,
			`Goal not achieved after ${state.maxIterations} iterations`,
		);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		log.error("Dynamic agent workflow failed", { error: errorMessage });

		state.status = "failed";
		updateProgress("failed", `Workflow failed: ${errorMessage}`);

		return buildOutput(state, "FAILED", false, errorMessage);
	}

	// Recovery helper
	async function attemptRecovery(
		step: { id: string; description: string },
		error: string,
		maxAttempts: number,
		userId: string,
		organizationId?: string,
	): Promise<boolean> {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const recoveryResult = await goalActivities.attemptStepRecovery(
					{
						step,
						error,
						attempt,
						userId,
						organizationId,
					},
				);

				if (recoveryResult.recovered) {
					return true;
				}
			} catch {
				// Continue to next attempt
			}
		}
		return false;
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

function buildKnowledgePrompt(
	results: Array<{ content: string; source?: string; score?: number }>,
): string {
	if (results.length === 0) {
		return "";
	}

	const contextParts = results.map((result, i) => {
		const source = result.source || `Document ${i + 1}`;
		return `### Source: ${source}\n${result.content}`;
	});

	return `## Relevant Knowledge\n\n${contextParts.join("\n\n")}`;
}

function estimateContextSize(
	messages: Array<{ content: string }>,
	systemPrompt: string,
	knowledgeContext?: string,
): number {
	// Rough token estimation: ~4 chars per token
	let totalChars = systemPrompt.length;
	for (const msg of messages) {
		totalChars += msg.content.length;
	}
	if (knowledgeContext) {
		totalChars += knowledgeContext.length;
	}
	return Math.ceil(totalChars / 4);
}

function buildOutput(
	state: DynamicAgentWorkflowState,
	status: DynamicAgentOutput["status"],
	goalAchieved: boolean,
	error?: string,
): DynamicAgentOutput {
	const lastVerification =
		state.verificationHistory.length > 0
			? state.verificationHistory[state.verificationHistory.length - 1]
			: undefined;

	return {
		executionId: state.executionId,
		agentId: state.agentConfig?.id || "unknown",
		agentName: state.agentConfig?.displayName || "Unknown Agent",

		status,
		goalAchieved,

		response: state.accumulatedResponse.trim() || "No response generated",

		output: {
			variables: state.variables,
			artifacts: state.artifacts,
		},

		stepsExecuted: state.executedSteps,
		iterationsUsed: state.currentIteration,

		tokenUsage:
			state.totalInputTokens > 0 || state.totalOutputTokens > 0
				? {
						inputTokens: state.totalInputTokens,
						outputTokens: state.totalOutputTokens,
					}
				: undefined,

		durationMs: Date.now() - state.startTime,

		error,
		verificationResult: lastVerification,
	};
}
