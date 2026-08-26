/**
 * Goal-Oriented Agent Workflow
 *
 * A durable workflow that executes agent templates with goal-oriented iteration.
 * Unlike single-turn deployment execution, this workflow:
 *
 * 1. Plans: Decomposes the goal into subtasks
 * 2. Executes: Runs each subtask with tool calling
 * 3. Verifies: Checks if the goal is achieved
 * 4. Iterates: If goal not achieved, re-plans and continues
 *
 * This combines:
 * - Agent template context building (from deployment-execution)
 * - Orchestrator planning/execution phases
 * - Goal verification loop
 *
 * Use this workflow when:
 * - Task requires multiple steps to complete
 * - Success needs to be verified before returning
 * - Adaptive planning based on intermediate results is needed
 */

import {
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as deploymentActivities from "../../activities/deployment-execution";
import type * as goalOrientedActivities from "../../activities/goal-oriented-agent";
import type * as orchestratorActivities from "../../activities/orchestrator";

import {
	createInitialGoalOrientedState,
	DEFAULT_GOAL_ORIENTED_CONFIG,
	type ExecutedStep,
	type GoalOrientedAgentInput,
	type GoalOrientedAgentOutput,
	type GoalOrientedProgressUpdate,
	type GoalOrientedWorkflowState,
} from "./types";

// Re-export types
export * from "./types";

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSignal = defineSignal("cancel");
export const progressQuery =
	defineQuery<GoalOrientedProgressUpdate>("progress");
export const statusQuery =
	defineQuery<GoalOrientedWorkflowState["status"]>("status");

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
// Activity Proxies
// =============================================================================

// Goal-oriented specific activities
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

// Deployment activities (for loading agent config)
const deploymentActs = proxyActivities<typeof deploymentActivities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Knowledge fetching (longer timeout)
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

// Orchestrator activities for planning
const _planningActivities = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// =============================================================================
// Main Workflow
// =============================================================================

export async function goalOrientedAgentWorkflow(
	input: GoalOrientedAgentInput,
): Promise<GoalOrientedAgentOutput> {
	const state = createInitialGoalOrientedState(input);
	const config = DEFAULT_GOAL_ORIENTED_CONFIG;

	// ==========================================================================
	// Signal & Query Handlers
	// ==========================================================================

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
		if (eventLog.length > MAX_EVENT_LOG_SIZE) {
			eventLog.splice(0, eventLog.length - MAX_EVENT_LOG_SIZE);
		}
	};

	setHandler(cancelSignal, () => {
		log.info("Received cancel signal", { executionId: state.executionId });
		state.cancelled = true;
		emitEvent("execution.cancelled", { reason: "Execution cancelled" });
	});

	setHandler(progressQuery, () => state.currentProgress);
	setHandler(statusQuery, () => state.status);

	// Handle execution events query (cursor-based: returns events since index)
	setHandler(executionEventsQuery, (cursor: number) => {
		return eventLog.slice(cursor);
	});

	// ==========================================================================
	// Helper Functions
	// ==========================================================================

	function updateProgress(
		phase: GoalOrientedProgressUpdate["phase"],
		message: string,
		goalAchieved = false,
	) {
		state.currentProgress = {
			executionId: state.executionId,
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
	// Main Execution Loop
	// ==========================================================================

	try {
		log.info("Starting goal-oriented agent workflow", {
			executionId: state.executionId,
			goal: input.goal,
			maxIterations: state.maxIterations,
		});

		// Check for cancellation
		if (isCancelled()) {
			state.status = "cancelled";
			return buildOutput(
				state,
				"CANCELLED",
				false,
				"Execution cancelled by user",
			);
		}

		// ======================================================================
		// Phase 1: Load Agent Configuration
		// ======================================================================
		updateProgress("initializing", "Loading agent configuration...");
		emitEvent("execution.started", { executionId: state.executionId });
		emitEvent("execution.phase_changed", {
			phase: "initializing",
			message: "Loading agent configuration...",
		});

		const deploymentConfig =
			await deploymentActs.loadDeploymentConfiguration({
				deploymentId: input.deploymentId,
				userId: input.userId,
				organizationId: input.organizationId,
			});

		if (!deploymentConfig) {
			throw new Error(`Deployment ${input.deploymentId} not found`);
		}

		// Build execution context from deployment
		const executionContext = await deploymentActs.buildExecutionContext({
			config: deploymentConfig,
			input: input.input,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		state.agentContext = {
			systemPrompt: executionContext.systemPrompt,
			model: executionContext.model,
			mcpConfigIds: executionContext.mcpConfigIds,
			workspaceIds: executionContext.workspaceIds,
		};

		log.info("Agent configuration loaded", {
			model: state.agentContext.model,
			toolCount: state.agentContext.mcpConfigIds.length,
		});

		// ======================================================================
		// Phase 2: Fetch Knowledge (RAG)
		// ======================================================================
		if (
			executionContext.workspaceIds.length > 0 ||
			executionContext.knowledgeSources.length > 0
		) {
			updateProgress("initializing", "Fetching knowledge context...");
			emitEvent("execution.phase_changed", {
				phase: "fetching_knowledge",
				message: "Fetching knowledge context...",
			});

			const userMessage = extractUserMessage(input.input);
			const knowledgeResult = await knowledgeActivities.fetchKnowledge({
				executionId: input.executionId,
				context: executionContext,
				query: `${input.goal}\n\n${userMessage}`,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			if (knowledgeResult.totalChunks > 0) {
				state.knowledgeContext = buildKnowledgePrompt(
					knowledgeResult.chunks,
				);
				emitEvent("execution.knowledge_completed", {
					totalChunks: knowledgeResult.totalChunks,
					sourcesFetched: knowledgeResult.sourcesFetched.length,
				});
				log.info("Knowledge context loaded", {
					chunks: knowledgeResult.totalChunks,
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
			emitEvent("execution.iteration", {
				iteration: state.currentIteration,
				maxIterations: state.maxIterations,
			});

			log.info("Starting iteration", {
				iteration: state.currentIteration,
				maxIterations: state.maxIterations,
			});

			// ------------------------------------------------------------------
			// Step 3a: Plan (or re-plan if previous attempt failed)
			// ------------------------------------------------------------------
			updateProgress(
				"planning",
				`Iteration ${state.currentIteration}: Planning approach...`,
			);
			emitEvent("execution.phase_changed", {
				phase: "planning",
				message: `Iteration ${state.currentIteration}: Planning approach...`,
			});

			const planResult = await goalActivities.createGoalOrientedPlan({
				goal: input.goal,
				userMessage: extractUserMessage(input.input),
				systemPrompt: state.agentContext.systemPrompt,
				knowledgeContext: state.knowledgeContext,
				previousAttempts: state.verificationHistory,
				variables: state.variables,
				userId: input.userId,
				organizationId: input.organizationId,
				mcpConfigIds: state.agentContext.mcpConfigIds,
			});

			state.taskPlan = planResult.plan;
			state.routingDecision = planResult.routingDecision;
			emitEvent("execution.plan_created", {
				stepCount: state.taskPlan.steps.length,
				strategy: state.taskPlan.strategy,
			});

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
			emitEvent("execution.phase_changed", {
				phase: "executing",
				message: `Executing ${state.taskPlan.steps.length} steps...`,
			});

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

				emitEvent("execution.step_started", {
					stepId: step.id,
					stepIndex: stepIndex + 1,
					totalSteps: state.taskPlan.steps.length,
					description: step.description,
				});

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
							systemPrompt: state.agentContext.systemPrompt,
							knowledgeContext: state.knowledgeContext,
							variables: state.variables,
							previousStepResults: state.executedSteps,
							userId: input.userId,
							organizationId: input.organizationId,
							mcpConfigIds: state.agentContext.mcpConfigIds,
							model: state.agentContext.model,
							executionId: input.executionId,
							// Pass images only on first iteration's first step
							imageRefs:
								state.currentIteration === 1 && stepIndex === 0
									? input.imageRefs
									: undefined,
						});

					executedStep.completedAt = new Date().toISOString();
					executedStep.durationMs = Date.now() - stepStartTime;
					executedStep.toolCalls = stepResult.toolCalls;
					executedStep.artifacts = stepResult.artifacts;

					// Update variables with step outputs
					if (stepResult.variables) {
						state.variables = {
							...state.variables,
							...stepResult.variables,
						};
					}

					// Accumulate response
					if (stepResult.response) {
						state.accumulatedResponse += `${stepResult.response}\n\n`;
					}

					// Track tokens
					if (stepResult.tokenUsage) {
						state.totalInputTokens +=
							stepResult.tokenUsage.inputTokens || 0;
						state.totalOutputTokens +=
							stepResult.tokenUsage.outputTokens || 0;
					}

					// Add to trajectory
					state.trajectorySteps.push({
						stepId: step.id,
						agentId: step.executor || "goal-oriented-agent",
						toolName: stepResult.toolCalls?.[0]?.name,
						input: step.inputs,
						output: stepResult.outputs,
						durationMs: executedStep.durationMs,
						success: true,
						timestamp: executedStep.completedAt,
					});

					emitEvent("execution.step_completed", {
						stepId: step.id,
						durationMs: executedStep.durationMs || 0,
						toolCalls: stepResult.toolCalls?.length || 0,
						success: true,
					});

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
			if (!isCancelled()) {
				updateProgress(
					"verifying",
					`Iteration ${state.currentIteration}: Verifying goal achievement...`,
				);
				emitEvent("execution.phase_changed", {
					phase: "verifying",
					message: "Verifying goal achievement...",
				});

				const verificationResult =
					await goalActivities.verifyGoalAchievement({
						goal: input.goal,
						successCriteria: state.successCriteria,
						executedSteps: state.executedSteps,
						accumulatedResponse: state.accumulatedResponse,
						variables: state.variables,
						userId: input.userId,
						organizationId: input.organizationId,
					});

				state.verificationHistory.push(verificationResult);
				goalAchieved = verificationResult.achieved;
				emitEvent("execution.verification", {
					achieved: verificationResult.achieved,
					confidence: verificationResult.confidence,
					iteration: state.currentIteration,
				});

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
						"recovering",
						`Goal not achieved (${Math.round(verificationResult.confidence * 100)}% confidence). Re-planning...`,
					);

					// Add suggestions to variables for next iteration
					if (verificationResult.suggestions?.length) {
						state.variables["sys.lastSuggestions"] = {
							name: "sys.lastSuggestions",
							value: verificationResult.suggestions,
							setBy: "verifier",
							setAt: new Date().toISOString(),
							scope: "workflow",
						};
					}
				}
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
				goalAchieved,
				"Execution cancelled",
			);
		}

		if (goalAchieved) {
			// Complete the execution
			await goalActivities.completeGoalExecution({
				executionId: input.executionId,
				status: "COMPLETED",
				goalAchieved: true,
				output: {
					response: state.accumulatedResponse.trim(),
					stepsExecuted: state.executedSteps,
				},
				tokenUsage: {
					inputTokens: state.totalInputTokens,
					outputTokens: state.totalOutputTokens,
				},
				durationMs: Date.now() - state.startTime,
			});

			updateProgress("completed", "Goal achieved successfully!", true);
			emitEvent("execution.completed", {
				goalAchieved: true,
				iterationsUsed: state.currentIteration,
				durationMs: Date.now() - state.startTime,
			});
			state.status = "completed";

			return buildOutput(state, "COMPLETED", true);
		}

		// Max iterations reached without achieving goal
		await goalActivities.completeGoalExecution({
			executionId: input.executionId,
			status: "COMPLETED",
			goalAchieved: false,
			output: {
				response: state.accumulatedResponse.trim(),
				stepsExecuted: state.executedSteps,
			},
			tokenUsage: {
				inputTokens: state.totalInputTokens,
				outputTokens: state.totalOutputTokens,
			},
			durationMs: Date.now() - state.startTime,
		});

		updateProgress(
			"completed",
			`Max iterations (${state.maxIterations}) reached`,
			false,
		);
		emitEvent("execution.completed", {
			goalAchieved: false,
			iterationsUsed: state.currentIteration,
			durationMs: Date.now() - state.startTime,
			reason: "max_iterations_reached",
		});
		state.status = "completed";

		return buildOutput(
			state,
			"MAX_ITERATIONS_REACHED",
			false,
			`Goal not achieved after ${state.maxIterations} iterations`,
		);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		log.error("Goal-oriented workflow failed", { error: errorMessage });

		state.status = "failed";
		updateProgress("failed", `Workflow failed: ${errorMessage}`);
		emitEvent("execution.failed", {
			error: errorMessage,
			durationMs: Date.now() - state.startTime,
		});

		await goalActivities.completeGoalExecution({
			executionId: input.executionId,
			status: "FAILED",
			goalAchieved: false,
			error: errorMessage,
			durationMs: Date.now() - state.startTime,
		});

		return buildOutput(state, "FAILED", false, errorMessage);
	}

	// Recovery helper (inline for workflow determinism)
	async function attemptRecovery(
		step: { id: string; description: string },
		error: string,
		maxAttempts: number,
	): Promise<boolean> {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const recoveryResult = await goalActivities.attemptStepRecovery(
					{
						step,
						error,
						attempt,
						userId: input.userId,
						organizationId: input.organizationId,
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

function extractUserMessage(input: Record<string, unknown>): string {
	return (
		(input.message as string) ||
		(input.prompt as string) ||
		(input.query as string) ||
		JSON.stringify(input)
	);
}

function buildKnowledgePrompt(
	chunks: Array<{ content: string; metadata?: Record<string, unknown> }>,
): string {
	if (chunks.length === 0) {
		return "";
	}

	const contextParts = chunks.map((chunk, i) => {
		const source = chunk.metadata?.source || `Document ${i + 1}`;
		return `### Source: ${source}\n${chunk.content}`;
	});

	return `## Relevant Knowledge\n\n${contextParts.join("\n\n")}`;
}

function buildOutput(
	state: GoalOrientedWorkflowState,
	status: GoalOrientedAgentOutput["status"],
	goalAchieved: boolean,
	error?: string,
): GoalOrientedAgentOutput {
	const lastVerification =
		state.verificationHistory.length > 0
			? state.verificationHistory[state.verificationHistory.length - 1]
			: undefined;

	return {
		executionId: state.executionId,
		status,
		goalAchieved,
		response: state.accumulatedResponse.trim() || "No response generated",
		output: {
			variables: state.variables,
			trajectorySteps: state.trajectorySteps,
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
