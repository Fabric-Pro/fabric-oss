/**
 * Planning Phase
 *
 * Handles task planning including:
 * - Trajectory replay check
 * - Analyze and route
 * - Create task plan
 * - Plan validation
 * - Trust-based approval analysis
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as orchestratorActivities from "../../../activities/orchestrator";
import type * as weaveActivities from "../../../activities/weave";
import { TRAJECTORY } from "../orchestrator-config";
import type {
	ApprovalSignalData,
	ExecutionModeConfig,
	OrchestratorWorkflowInput,
	PhaseResult,
	RoutingDecision,
	TaskPlan,
	Trajectory,
	WorkflowState,
} from "../types";

const {
	analyzeAndRoute,
	createTaskPlan,
	findSimilarTrajectory,
	validatePlan,
	inferAndValidateContractsActivity,
	analyzePlanApprovalActivity,
	createOrchestratorApprovalRequest,
	recordApprovalOutcomeActivity,
	updateApprovalTaskStatus,
} = proxyActivities<typeof orchestratorActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

const { convertWeavePlanToOrchestratorSteps } = proxyActivities<
	typeof weaveActivities
>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * Execute planning phase
 *
 * This phase:
 * 1. Checks for reusable trajectories
 * 2. Analyzes and routes the task
 * 3. Creates the task plan
 * 4. Validates the plan
 * 5. Handles plan-level approval
 */
export async function executePlanningPhase(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	modeConfig: ExecutionModeConfig,
	updateProgress: (phase: string, message: string) => void,
	waitForApproval: () => Promise<ApprovalSignalData | null>,
): Promise<
	PhaseResult<{
		taskPlan: TaskPlan;
		routingDecision: RoutingDecision;
		replayTrajectory?: Trajectory;
	}>
> {
	const { executionId, enrichedMessage } = state;

	log.info("Starting planning phase", { executionId });

	try {
		// ======================================================================
		// Step 1: Check for Trajectory Replay
		// ======================================================================
		if (input.executionMode === "save_reuse" && !input.replayTrajectoryId) {
			updateProgress("routing", "Searching for similar trajectories...");

			const similarTrajectory = await findSimilarTrajectory({
				taskDescription: input.message,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			if (
				similarTrajectory &&
				similarTrajectory.reuseSuccessRate >
					TRAJECTORY.reuseMinSuccessRate
			) {
				log.info("Found reusable trajectory", {
					trajectoryId: similarTrajectory.id,
				});

				state.planningAudit.contextSources.push({
					type: "trajectory_reuse",
					description:
						"Found matching trajectory from past execution",
					confidence: similarTrajectory.reuseSuccessRate,
					used: true,
					usageReason: `Reusing trajectory with ${Math.round(similarTrajectory.reuseSuccessRate * 100)}% success rate`,
				});

				state.planningAudit.decisions.push({
					category: "trajectory_reuse",
					decision:
						"Replay saved trajectory instead of creating new plan",
					reasoning: `Found trajectory with ${Math.round(similarTrajectory.reuseSuccessRate * 100)}% success rate`,
					confidence: similarTrajectory.reuseSuccessRate,
				});

				state.planningAudit.planningCompletedAt = new Date();

				return {
					success: true,
					data: {
						taskPlan: null as any, // Will use trajectory instead
						routingDecision: null as any,
						replayTrajectory: similarTrajectory,
					},
					shouldContinue: false, // Signal to use trajectory replay
				};
			}
			if (similarTrajectory) {
				state.planningAudit.contextSources.push({
					type: "trajectory_reuse",
					description:
						"Found similar trajectory but success rate too low",
					confidence: similarTrajectory.reuseSuccessRate,
					used: false,
					usageReason: `Success rate ${Math.round(similarTrajectory.reuseSuccessRate * 100)}% below ${Math.round(TRAJECTORY.reuseMinSuccessRate * 100)}% threshold`,
				});
			}
		}

		// ======================================================================
		// Weave Mode: Load pre-built plan from WeavePlan checkboxes
		// ======================================================================
		if (input.executionMode === "weave" && input.weavePlanId) {
			updateProgress("planning", "Loading weave plan...");

			const taskPlan = await convertWeavePlanToOrchestratorSteps({
				planId: input.weavePlanId,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			if (input.weaveImplementationProvider) {
				taskPlan.steps = taskPlan.steps.map((step) =>
					step.app === "weave_shuttle"
						? {
								...step,
								inputs: {
									...(step.inputs ?? {}),
									weaveImplementationProvider:
										input.weaveImplementationProvider,
								},
							}
						: step,
				);
			}

			log.info("Weave plan loaded", {
				planId: input.weavePlanId,
				steps: taskPlan.steps.length,
			});

			// Create a synthetic routing decision for weave mode
			const routingDecision: RoutingDecision = {
				primaryAgent: "weave_shuttle",
				secondaryAgents: ["weave_thread", "weave_weft", "weave_warp"],
				suggestedStrategy: "agent",
				riskLevel: taskPlan.riskLevel,
				riskFactors: [],
				confidence: 1.0,
				reasoning: "Weave mode: executing pre-approved plan",
				useMcpDirect: false,
				matchedMcpTools: [],
			};

			state.routingDecision = routingDecision;
			state.taskPlan = taskPlan;
			state.planningAudit.planningCompletedAt = new Date();
			state.planningAudit.decisions.push({
				category: "weave_mode",
				decision: `Loaded weave plan with ${taskPlan.steps.length} steps`,
				reasoning: `Pre-built plan from WeavePlan ${input.weavePlanId}`,
				confidence: 1.0,
			});

			// Store sandbox session ID as workflow variable (created in init phase)
			state.variables["weave.planId"] = {
				name: "weave.planId",
				value: input.weavePlanId,
				setBy: "orchestrator",
				setAt: new Date().toISOString(),
				scope: "workflow",
				readonly: true,
			};

			// Skip plan approval — weave plans are already user-approved
			return {
				success: true,
				data: {
					taskPlan,
					routingDecision,
				},
				shouldContinue: true,
			};
		}

		// ======================================================================
		// Step 2: Analyze and Route
		// ======================================================================
		updateProgress(
			"routing",
			"Analyzing request and determining routing...",
		);

		// SECURITY: Credentials are fetched internally by the activity
		// API keys are NOT passed in workflow inputs to avoid storing them in Temporal history
		const routingDecision = await analyzeAndRoute({
			message: enrichedMessage,
			history: input.history,
			userId: input.userId,
			organizationId: input.organizationId,
			enabledMcpConfigIds: input.enabledMcpConfigIds,
			enabledAgentIds: input.enabledAgentIds,
			enabledFabricToolIds: input.enabledFabricToolIds,
			enabledIntegrationIds: input.enabledIntegrationIds,
			prioritizedToolIds: input.prioritizedToolIds,
			prioritizedAgentIds: input.prioritizedAgentIds,
			prioritizedMcpConfigIds: input.prioritizedMcpConfigIds,
			prioritizedIntegrationIds: input.prioritizedIntegrationIds,
			// Pass memory context with learned patterns for routing decisions
			memoryContext: state.enrichedSystemPrompt || undefined,
			// Pass attached images for image editing routing
			attachedImageUrls: input.attachedImageUrls,
		});

		log.info("Routing decision made", {
			primaryAgent: routingDecision.primaryAgent,
			riskLevel: routingDecision.riskLevel,
		});

		// Update state
		state.routingDecision = routingDecision;

		// Track routing decision in planning audit
		state.planningAudit.contextSources.push({
			type: "agent_capabilities",
			description: `Selected ${routingDecision.primaryAgent} as primary agent`,
			confidence: routingDecision.confidence,
			used: true,
			usageReason: routingDecision.reasoning,
		});

		// Track MCP tool discovery
		if (
			routingDecision.matchedMcpTools &&
			routingDecision.matchedMcpTools.length > 0
		) {
			state.planningAudit.contextSources.push({
				type: "mcp_tool_discovery",
				description: `Discovered ${routingDecision.matchedMcpTools.length} relevant MCP tool(s)`,
				used: routingDecision.useMcpDirect || false,
				usageReason: routingDecision.useMcpDirect
					? `Using: ${routingDecision.matchedMcpTools.map((t) => t.toolName).join(", ")}`
					: "Tools available but agent delegation preferred",
			});
		}

		// Record routing decision
		state.planningAudit.decisions.push({
			category: "executor_selection",
			decision: `Route to ${routingDecision.primaryAgent}`,
			reasoning: routingDecision.reasoning,
			confidence: routingDecision.confidence,
		});

		// Store routing in variables
		state.variables["routing.primaryAgent"] = {
			name: "routing.primaryAgent",
			value: routingDecision.primaryAgent,
			setBy: "orchestrator",
			setAt: new Date().toISOString(),
			scope: "workflow",
		};
		state.variables["routing.riskLevel"] = {
			name: "routing.riskLevel",
			value: routingDecision.riskLevel,
			setBy: "orchestrator",
			setAt: new Date().toISOString(),
			scope: "workflow",
		};

		// ======================================================================
		// Step 3: Create Task Plan
		// ======================================================================
		let taskPlan: TaskPlan;

		if (modeConfig.taskDecomposition) {
			updateProgress("planning", "Creating task plan...");

			taskPlan = await createTaskPlan({
				message: enrichedMessage,
				routingDecision,
				userId: input.userId,
				organizationId: input.organizationId,
				enabledMcpConfigIds: input.enabledMcpConfigIds,
				enabledAgentIds: input.enabledAgentIds,
				executionMode: input.executionMode,
				prioritizedToolIds: input.prioritizedToolIds,
				prioritizedMcpConfigIds: input.prioritizedMcpConfigIds,
				history: input.history,
				// Pass attached images for image editing planning
				attachedImageUrls: input.attachedImageUrls,
			});

			log.info("Task plan created", { steps: taskPlan.steps.length });
			updateProgress(
				"planning",
				`Created plan with ${taskPlan.steps.length} steps`,
			);

			state.planningAudit.decisions.push({
				category: "task_decomposition",
				decision: `Decomposed into ${taskPlan.steps.length} step(s)`,
				reasoning: `Task complexity requires ${taskPlan.steps.length} sequential steps`,
				confidence: 0.8,
			});
		} else {
			// Simple single-step plan
			taskPlan = {
				id: `plan-${executionId}`,
				description: enrichedMessage,
				steps: [
					{
						id: "step-1",
						description: "Execute task",
						type: routingDecision.suggestedStrategy,
						status: "pending",
						order: 1,
						executor: routingDecision.primaryAgent,
						riskLevel: routingDecision.riskLevel,
						requiresApproval:
							routingDecision.riskLevel === "high" ||
							routingDecision.riskLevel === "critical",
					},
				],
				riskLevel: routingDecision.riskLevel,
				strategy: routingDecision.suggestedStrategy,
				createdAt: new Date().toISOString(),
			};
		}

		// Update state
		state.taskPlan = taskPlan;
		state.planningAudit.planningCompletedAt = new Date();

		// ======================================================================
		// Step 4: Plan Validation
		// ======================================================================
		await validateTaskPlan(state, input, routingDecision, taskPlan);

		// ======================================================================
		// Step 5: Plan-Level Approval
		// ======================================================================
		const approvalResult = await handlePlanApproval(
			state,
			input,
			taskPlan,
			routingDecision,
			modeConfig,
			updateProgress,
			waitForApproval,
		);

		if (!approvalResult.success) {
			return {
				success: false,
				error: approvalResult.error,
				shouldContinue: false,
			};
		}

		return {
			success: true,
			data: {
				taskPlan,
				routingDecision,
			},
			shouldContinue: true,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		log.error("Planning phase failed", { error: errorMessage });
		return {
			success: false,
			error: errorMessage,
			shouldContinue: false,
		};
	}
}

/**
 * Validate task plan
 */
async function validateTaskPlan(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	routingDecision: RoutingDecision,
	taskPlan: TaskPlan,
): Promise<void> {
	try {
		const planValidation = await validatePlan({
			plan: taskPlan,
			routingDecision,
			userId: input.userId,
			organizationId: input.organizationId,
			enabledMcpConfigIds: input.enabledMcpConfigIds || [],
			enabledAgentIds: input.enabledAgentIds || [],
		});

		if (!planValidation.isValid) {
			log.warn("Plan validation found issues", {
				errorCount: planValidation.issues.filter(
					(i) => i.severity === "error",
				).length,
				warningCount: planValidation.issues.filter(
					(i) => i.severity === "warning",
				).length,
			});

			state.planningAudit.decisions.push({
				category: "plan_validation",
				decision: `Plan has ${planValidation.issues.length} issue(s)`,
				reasoning: planValidation.issues
					.slice(0, 3)
					.map((i) => i.message)
					.join("; "),
				confidence: 0.9,
			});
		} else {
			state.planningAudit.decisions.push({
				category: "plan_validation",
				decision: "Plan validated successfully",
				reasoning: `All ${taskPlan.steps.length} steps have valid executors and dependencies`,
				confidence: 1.0,
			});
		}

		// Infer I/O contracts for better context flow
		const contractResult = await inferAndValidateContractsActivity(
			taskPlan.steps,
			state.variables,
		);
		if (contractResult.validation.errors.length > 0) {
			log.debug("I/O contract validation found issues", {
				errorCount: contractResult.validation.errors.length,
				warningCount: contractResult.validation.warnings.length,
			});
		}
	} catch (error) {
		log.warn("Plan validation/contract inference failed, continuing", {
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}
}

/**
 * Handle plan-level approval
 */
async function handlePlanApproval(
	state: WorkflowState,
	input: OrchestratorWorkflowInput,
	taskPlan: TaskPlan,
	routingDecision: RoutingDecision,
	_modeConfig: ExecutionModeConfig,
	updateProgress: (phase: string, message: string) => void,
	waitForApproval: () => Promise<ApprovalSignalData | null>,
): Promise<{ success: boolean; error?: string }> {
	const planApprovalAnalysis = await analyzePlanApprovalActivity({
		plan: taskPlan,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	// Mark auto-approved steps
	const autoApprovedStepIds = new Set(
		planApprovalAnalysis.autoApprovedStepIds,
	);
	for (const step of taskPlan.steps) {
		if (autoApprovedStepIds.has(step.id)) {
			step.requiresApproval = false;
			step.approvalId = "auto-approved";
		}
	}

	log.info("Plan approval analysis", {
		requiresApproval: planApprovalAnalysis.requiresApproval,
		autoApprovedCount: planApprovalAnalysis.autoApprovedStepIds.length,
		pendingApprovalCount:
			planApprovalAnalysis.pendingApprovalStepIds.length,
	});

	if (!planApprovalAnalysis.requiresApproval) {
		return { success: true };
	}

	const { summary } = planApprovalAnalysis;

	// Build approval request
	const highRiskStepsDescription = summary.highRiskSteps
		.map(
			(
				s: { risk: string; description: string; impact: string },
				i: number,
			) =>
				`${i + 1}. [${s.risk.toUpperCase()}] ${s.description}\n   Impact: ${s.impact}`,
		)
		.join("\n");

	const plannedActionsDescription = summary.plannedActions
		.filter((a: { reversible: boolean }) => !a.reversible)
		.map(
			(a: { action: string; target: string }) =>
				`- ${a.action}: ${a.target}`,
		)
		.join("\n");

	updateProgress(
		"awaiting_approval",
		`${summary.overallRisk.toUpperCase()} risk plan requires approval`,
	);
	state.status = "awaiting_approval";

	const approvalRequest = await createOrchestratorApprovalRequest({
		executionId: state.executionId,
		stepId: "plan-approval",
		stepDescription: `Plan: ${input.message}`,
		stepType: routingDecision.suggestedStrategy,
		userId: input.userId,
		organizationId: input.organizationId,
		riskScore:
			summary.overallRisk === "critical"
				? 95
				: summary.overallRisk === "high"
					? 80
					: 60,
		riskLevel: summary.overallRisk,
		riskFactors: [
			...(routingDecision.riskFactors || []),
			`${summary.highRiskSteps.length} high-risk step(s)`,
			`${summary.plannedActions.filter((a: { reversible: boolean }) => !a.reversible).length} irreversible action(s)`,
		],
	});

	const stepsSummary =
		summary.highRiskSteps.length > 0
			? `\n\n**Steps requiring approval:**\n${highRiskStepsDescription}`
			: "";

	const irreversibleWarning = plannedActionsDescription
		? `\n\n**Irreversible actions:**\n${plannedActionsDescription}`
		: "";

	state.pendingApproval = {
		approvalId: approvalRequest.approvalId,
		stepId: "plan-approval",
		reason: `${summary.overallRisk.toUpperCase()} RISK PLAN: ${input.message}${stepsSummary}${irreversibleWarning}\n\nApproving this will execute all ${taskPlan.steps.length} steps.`,
	};

	// Track in history
	const planApprovalEntry = {
		approvalId: approvalRequest.approvalId,
		stepId: "plan-approval",
		stepDescription: `Plan: ${input.message}`,
		riskLevel: summary.overallRisk,
		requestedAt: new Date().toISOString(),
		decidedAt: undefined as string | undefined,
		approved: false,
		feedback: undefined as string | undefined,
	};
	state.approvalHistory.push(planApprovalEntry);

	// Wait for approval
	const decision = await waitForApproval();

	// Update history
	planApprovalEntry.decidedAt = new Date().toISOString();
	planApprovalEntry.approved = decision?.approved || false;
	planApprovalEntry.feedback = decision?.feedback;

	// Update the AgentTask status for this approval
	try {
		await updateApprovalTaskStatus({
			approvalId: approvalRequest.approvalId,
			approved: decision?.approved || false,
			feedback: decision?.feedback,
		});
	} catch (error) {
		log.warn("Failed to update plan approval task status", {
			approvalId: approvalRequest.approvalId,
			error: error instanceof Error ? error.message : "Unknown error",
		});
	}

	if (!decision?.approved) {
		await recordApprovalOutcomeActivity({
			userId: input.userId,
			organizationId: input.organizationId,
			stepId: "plan-approval",
			stepDescription: `Plan: ${input.message}`,
			stepType: routingDecision.suggestedStrategy,
			approved: false,
			feedback: decision?.feedback,
		});

		return {
			success: false,
			error: decision?.feedback || "Plan not approved",
		};
	}

	// Record approval
	await recordApprovalOutcomeActivity({
		userId: input.userId,
		organizationId: input.organizationId,
		stepId: "plan-approval",
		stepDescription: `Plan: ${input.message}`,
		stepType: routingDecision.suggestedStrategy,
		approved: true,
	});

	// Reset approval state
	state.approvalDecision = null;
	state.pendingApproval = null;
	state.status = "running";

	updateProgress("executing", "Plan approved - starting execution...");

	return { success: true };
}
