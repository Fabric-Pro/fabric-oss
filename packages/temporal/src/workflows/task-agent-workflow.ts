/**
 * Task Agent Workflow
 *
 * Weft-style agent execution workflow for story tasks.
 * Runs an LLM agent loop that executes tools dynamically,
 * pausing for approval at checkpoints.
 *
 * Key features:
 * - Dynamic step creation as agent reasons through task
 * - Tool execution with MCP integration
 * - Agent-initiated approvals via request_approval tool
 * - Real-time progress updates via signals
 * - Checkpoint/resume for human-in-the-loop
 */

import {
	ActivityFailure,
	ApplicationFailure,
	condition,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
	sleep,
} from "@temporalio/workflow";
import type * as activities from "../activities/task-agent";
import type { ValidateApprovalFieldsInput } from "../activities/task-agent";

// Proxy activities with appropriate timeouts
const {
	initializeWorkflowPlan,
	updateWorkflowPlan,
	addWorkflowLog,
	executeAgentTurn,
	executeTaskAgentTool,
	loadMcpConfiguration,
	broadcastProgress,
	retrieveProjectContexts,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Long-running tool calls (e.g., Sandbox commands)
const { executeTaskAgentTool: executeTaskAgentToolLong } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "15 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Signals and Queries
// =============================================================================

export interface CheckpointResolution {
	action: "approve" | "request_changes" | "cancel";
	feedback?: string;
	userData?: Record<string, unknown>;
}

export const resolveCheckpointSignal =
	defineSignal<[CheckpointResolution]>("resolveCheckpoint");

export const cancelWorkflowSignal = defineSignal("cancelWorkflow");

export interface WorkflowStatus {
	planId: string;
	status: string;
	currentStepIndex: number;
	totalSteps: number;
	isAtCheckpoint: boolean;
	checkpointData?: CheckpointData;
}

export const statusQuery = defineQuery<WorkflowStatus>("status");

// =============================================================================
// Types
// =============================================================================

export interface TaskAgentWorkflowInput {
	planId: string;
	taskId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	taskTitle: string;
	taskDescription: string;
	projectContext?: {
		projectName: string;
		projectDescription?: string;
	};
	storyContext?: {
		storyTitle: string;
		storyDescription?: string;
		acceptanceCriteria?: string;
	};
	repositoryContext?: {
		repositoryUrl: string;
		repositoryOwner?: string;
		repositoryName?: string;
		targetBranch: string;
	};
}

export interface TaskAgentWorkflowOutput {
	planId: string;
	status: "completed" | "failed" | "cancelled";
	totalTurns: number;
	artifacts?: WorkflowArtifact[];
	error?: string;
}

export interface AgentStep {
	id: string;
	name: string;
	type: "agent" | "tool" | "approval";
	status:
		| "pending"
		| "running"
		| "completed"
		| "failed"
		| "awaiting_approval";
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	result?: unknown;
	error?: string;
	thinking?: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	approvalData?: unknown;
}

export interface WorkflowArtifact {
	type:
		| "github_pr"
		| "github_issue"
		| "google_doc"
		| "google_sheet"
		| "gmail_message"
		| "file"
		| "other";
	url?: string;
	title?: string;
	description?: string;
}

export interface CheckpointData {
	stepId: string;
	tool: string;
	action: string;
	data: Record<string, unknown>;
}

// =============================================================================
// Workflow Implementation
// =============================================================================

const MAX_TURNS = 50;
const MAX_CONSECUTIVE_FAILURES = 5; // Stop after N consecutive tool failures
const LONG_RUNNING_TOOLS = [
	"Sandbox__runCommand",
	"Sandbox__runClaude",
	"GitHub__create_pr",
];

export async function taskAgentWorkflow(
	input: TaskAgentWorkflowInput,
): Promise<TaskAgentWorkflowOutput> {
	const {
		planId,
		taskId,
		projectId,
		userId,
		organizationId,
		taskTitle,
		taskDescription,
		projectContext,
		storyContext,
		repositoryContext,
	} = input;

	let status = "running";
	let cancelled = false;
	let checkpointResolution: CheckpointResolution | undefined;
	let currentCheckpoint: CheckpointData | undefined;
	const steps: AgentStep[] = [];
	const artifacts: WorkflowArtifact[] = [];
	let turnIndex = 0;
	let consecutiveFailures = 0; // Track consecutive tool failures to detect stuck loops

	// Store diff results to avoid LLM output truncation
	// When getDiff is called, store the result here. When request_approval is called
	// for a PR, auto-inject the stored diff instead of relying on LLM to pass it through.
	let cachedDiff:
		| {
				diff: string;
				stats: { files: number; additions: number; deletions: number };
		  }
		| undefined;

	log.info("Starting task agent workflow", { planId, taskId });

	// Set up signal handlers
	setHandler(resolveCheckpointSignal, (resolution) => {
		log.info("Received checkpoint resolution", {
			planId,
			action: resolution.action,
		});
		checkpointResolution = resolution;
	});

	setHandler(cancelWorkflowSignal, () => {
		log.info("Received cancel signal", { planId });
		cancelled = true;
	});

	// Set up query handler
	setHandler(statusQuery, () => ({
		planId,
		status,
		currentStepIndex: steps.length,
		totalSteps: steps.length,
		isAtCheckpoint: status === "checkpoint",
		checkpointData: currentCheckpoint,
	}));

	try {
		// Initialize the workflow plan
		await initializeWorkflowPlan({
			planId,
			taskId,
			projectId,
			userId,
			organizationId,
			status: "running",
		});

		// Broadcast agent started
		await broadcastProgress({
			planId,
			projectId,
			type: "agent_started",
			data: { taskId, taskTitle },
		});

		await addWorkflowLog({
			planId,
			level: "info",
			message: `Agent started working on: ${taskTitle}`,
		});

		// Load MCP configuration
		const mcpConfig = await loadMcpConfiguration({
			userId,
			organizationId,
		});

		// Retrieve project contexts from RAG (optional - won't fail workflow if unavailable)
		let ragContexts: string[] = [];
		try {
			ragContexts = await retrieveProjectContexts({
				projectId,
				userId,
				organizationId,
				taskTitle,
				taskDescription,
				limit: 5,
			});

			if (ragContexts.length > 0) {
				await addWorkflowLog({
					planId,
					level: "info",
					message: `Retrieved ${ragContexts.length} relevant project contexts from RAG`,
				});
			}
		} catch (error) {
			log.warn("RAG retrieval failed, continuing without context", {
				error,
			});
		}

		// Build task prompt with project context, RAG contexts, and repository info
		const taskPrompt = buildTaskPrompt(
			taskTitle,
			taskDescription,
			projectContext,
			storyContext,
			ragContexts,
			repositoryContext,
		);

		// Conversation history for the agent using AgentMessage union type
		// Note: We use type assertion to match the complex union type from activities
		type WorkflowMessage =
			| { role: "user"; content: string }
			| {
					role: "assistant";
					content:
						| string
						| Array<{ type: string; [key: string]: unknown }>;
			  }
			| { role: "tool"; content: string; tool_call_id: string };

		const messages: WorkflowMessage[] = [
			{ role: "user", content: taskPrompt },
		];

		// Agent loop
		while (!cancelled && turnIndex < MAX_TURNS) {
			// Check for cancellation
			if (cancelled) {
				status = "cancelled";
				break;
			}

			// Execute agent turn
			const turnResult = await executeAgentTurn({
				planId,
				turnIndex,
				messages,
				mcpConfig,
				userId,
				organizationId,
				projectId,
			});

			// Create agent step
			const agentStep: AgentStep = {
				id: `turn-${turnIndex}`,
				name: turnResult.summary || "Thinking...",
				type: "agent",
				status: "completed",
				completedAt: new Date().toISOString(),
				thinking: turnResult.response,
			};
			steps.push(agentStep);

			// Update plan with new step
			await updateWorkflowPlan({
				planId,
				steps: [...steps],
			});

			// Broadcast progress
			await broadcastProgress({
				planId,
				projectId,
				type: "step_completed",
				data: { step: agentStep },
			});

			// Add assistant message with tool calls to history
			if (turnResult.toolCalls && turnResult.toolCalls.length > 0) {
				// Add assistant message with tool_use parts (AI SDK v6 format)
				messages.push({
					role: "assistant",
					content: [
						...(turnResult.response
							? [{ type: "text", text: turnResult.response }]
							: []),
						...turnResult.toolCalls.map((tc) => ({
							type: "tool-call",
							toolCallId: tc.id,
							toolName: tc.name,
							// AI SDK v6 expects 'input' instead of 'args'
							input: tc.args,
						})),
					],
				});
			} else {
				// Plain text response
				messages.push({
					role: "assistant",
					content: turnResult.response,
				});
			}

			// Process tool calls
			if (turnResult.toolCalls && turnResult.toolCalls.length > 0) {
				const toolResultMessages: Array<{
					role: "tool";
					content: string;
					tool_call_id: string;
				}> = [];

				for (const toolCall of turnResult.toolCalls) {
					const toolStepId = `tool-${turnIndex}-${toolCall.id}`;

					// Check if this is a request_approval tool
					if (toolCall.name === "request_approval") {
						const approvalData = toolCall.args as {
							tool: string;
							action: string;
							data: Record<string, unknown>;
						};

						// AUTO-INJECT CACHED DIFF for PR approvals
						// This fixes the truncation issue where large diffs get cut off
						// when flowing through the LLM's output token limit
						const isPrApproval =
							approvalData.tool
								.toLowerCase()
								.includes("github") &&
							(approvalData.tool.toLowerCase().includes("pr") ||
								approvalData.tool
									.toLowerCase()
									.includes("pull_request") ||
								approvalData.action
									.toLowerCase()
									.includes("pull request"));

						if (isPrApproval && cachedDiff) {
							// Inject the cached diff if missing or truncated
							const existingDiff = approvalData.data.diff as
								| string
								| undefined;
							const existingStats = approvalData.data.stats as
								| { files?: number }
								| undefined;

							// Check if diff is missing or appears truncated
							const isDiffMissing = !existingDiff;
							const isDiffTruncated =
								existingStats?.files &&
								cachedDiff.stats.files >
									(existingStats.files || 0);

							if (isDiffMissing || isDiffTruncated) {
								log.info(
									"Injecting cached diff into PR approval",
									{
										planId,
										wasMissing: isDiffMissing,
										wasTruncated: isDiffTruncated,
										cachedFiles: cachedDiff.stats.files,
										existingFiles: existingStats?.files,
									},
								);

								approvalData.data.diff = cachedDiff.diff;
								approvalData.data.stats = cachedDiff.stats;
							}
						}

						// Validate required fields for the tool being approved
						const validation = validateApprovalFields({
							toolName: approvalData.tool,
							data: approvalData.data,
							mcpConfig,
						});

						if (!validation.valid) {
							// Return error to agent asking for required fields
							log.info("Approval validation failed", {
								tool: approvalData.tool,
								missingFields: validation.missingFields,
							});

							toolResultMessages.push({
								role: "tool",
								content: validation.error,
								tool_call_id: toolCall.id,
							});
							continue;
						}

						// Create approval step
						const approvalStep: AgentStep = {
							id: toolStepId,
							name: approvalData.action || "Waiting for approval",
							type: "approval",
							status: "awaiting_approval",
							startedAt: new Date().toISOString(),
							toolName: approvalData.tool,
							approvalData: approvalData.data,
						};
						steps.push(approvalStep);

						// Set checkpoint
						currentCheckpoint = {
							stepId: toolStepId,
							tool: approvalData.tool,
							action: approvalData.action,
							data: approvalData.data,
						};
						status = "checkpoint";

						await updateWorkflowPlan({
							planId,
							status: "checkpoint",
							steps: [...steps],
							checkpointData: currentCheckpoint,
						});

						await addWorkflowLog({
							planId,
							level: "info",
							message: `Requesting approval: ${approvalData.action}`,
							stepId: toolStepId,
						});

						// Broadcast checkpoint
						await broadcastProgress({
							planId,
							projectId,
							type: "checkpoint",
							data: { checkpoint: currentCheckpoint },
						});

						// Wait for approval (up to 7 days)
						const timeoutMs = 7 * 24 * 60 * 60 * 1000;
						const received = await condition(
							() =>
								checkpointResolution !== undefined || cancelled,
							timeoutMs,
						);

						if (cancelled) {
							status = "cancelled";
							break;
						}

						if (!received || !checkpointResolution) {
							// Timeout
							status = "failed";
							await updateWorkflowPlan({
								planId,
								status: "failed",
								result: {
									success: false,
									error: "Approval request timed out",
								},
							});
							throw ApplicationFailure.nonRetryable(
								"Approval request timed out",
								"TASK_AGENT_FAILED",
							);
						}

						// Process resolution
						const resolution = checkpointResolution;
						checkpointResolution = undefined;
						currentCheckpoint = undefined;

						if (resolution.action === "cancel") {
							// Update step as failed
							const stepIndex = steps.findIndex(
								(s) => s.id === toolStepId,
							);
							if (stepIndex >= 0) {
								steps[stepIndex].status = "failed";
								steps[stepIndex].error = "Cancelled by user";
								steps[stepIndex].completedAt =
									new Date().toISOString();
							}
							status = "cancelled";
							await updateWorkflowPlan({
								planId,
								status: "failed",
								steps: [...steps],
								result: {
									success: false,
									error: "Cancelled by user",
								},
							});
							throw ApplicationFailure.nonRetryable(
								"Cancelled by user",
								"TASK_AGENT_FAILED",
							);
						}

						// Mark step as completed
						const stepIndex = steps.findIndex(
							(s) => s.id === toolStepId,
						);
						if (stepIndex >= 0) {
							steps[stepIndex].status = "completed";
							steps[stepIndex].completedAt =
								new Date().toISOString();
						}

						status = "running";
						await updateWorkflowPlan({
							planId,
							status: "running",
							steps: [...steps],
							checkpointData: null,
						});

						// Build tool result based on resolution
						const approvalResult =
							resolution.action === "request_changes"
								? {
										approved: false,
										action: "request_changes",
										feedback:
											resolution.feedback ||
											"User requested changes",
										message:
											"Please address the feedback and request approval again.",
									}
								: {
										approved: true,
										feedback: resolution.feedback,
										...(resolution.userData && {
											userData: resolution.userData,
										}),
									};
						toolResultMessages.push({
							role: "tool",
							content: JSON.stringify(approvalResult),
							tool_call_id: toolCall.id,
						});
					} else {
						// Regular tool call
						const toolStep: AgentStep = {
							id: toolStepId,
							name: formatToolName(toolCall.name),
							type: "tool",
							status: "running",
							startedAt: new Date().toISOString(),
							toolName: toolCall.name,
							toolArgs: toolCall.args,
						};
						steps.push(toolStep);

						await updateWorkflowPlan({ planId, steps: [...steps] });

						// Broadcast step added immediately
						await broadcastProgress({
							planId,
							projectId,
							type: "step_added",
							data: { step: toolStep },
						});

						await addWorkflowLog({
							planId,
							level: "info",
							message: `Calling ${formatToolName(toolCall.name)}`,
							stepId: toolStepId,
							metadata: {
								tool: toolCall.name,
								args: toolCall.args,
							},
						});

						const startTime = Date.now();

						try {
							// Use long timeout for certain tools
							const isLongRunning = LONG_RUNNING_TOOLS.some((t) =>
								toolCall.name.includes(t),
							);
							const executeToolFn = isLongRunning
								? executeTaskAgentToolLong
								: executeTaskAgentTool;

							const result = await executeToolFn({
								toolName: toolCall.name,
								args: toolCall.args,
								userId,
								organizationId,
								mcpConfig,
								projectId,
							});

							const durationMs = Date.now() - startTime;

							// Update step as completed
							const stepIdx = steps.findIndex(
								(s) => s.id === toolStepId,
							);
							if (stepIdx >= 0) {
								steps[stepIdx].status = "completed";
								steps[stepIdx].completedAt =
									new Date().toISOString();
								steps[stepIdx].durationMs = durationMs;
								steps[stepIdx].result = result;
							}

							await addWorkflowLog({
								planId,
								level: "info",
								message: `Tool completed in ${durationMs}ms`,
								stepId: toolStepId,
							});

							// Broadcast tool completion
							const updatedStep = steps.find(
								(s) => s.id === toolStepId,
							);
							if (updatedStep) {
								await broadcastProgress({
									planId,
									projectId,
									type: "step_completed",
									data: { step: updatedStep },
								});
							}

							// Reset consecutive failures on success
							consecutiveFailures = 0;

							// Cache diff results to avoid LLM output truncation
							// When the agent calls request_approval for a PR, we'll inject
							// the cached diff instead of relying on the LLM to pass it through
							if (toolCall.name.includes("getDiff") && result) {
								const diffResult = result as {
									diff?: string;
									stats?: {
										files: number;
										additions: number;
										deletions: number;
									};
								};
								if (diffResult.diff && diffResult.stats) {
									cachedDiff = {
										diff: diffResult.diff,
										stats: diffResult.stats,
									};
									log.info("Cached diff result", {
										planId,
										files: diffResult.stats.files,
										additions: diffResult.stats.additions,
										deletions: diffResult.stats.deletions,
									});
								}
							}

							// Extract artifact if applicable
							const artifact = extractArtifact(
								toolCall.name,
								result,
							);
							if (artifact) {
								artifacts.push(artifact);
							}

							toolResultMessages.push({
								role: "tool",
								content: JSON.stringify(result),
								tool_call_id: toolCall.id,
							});
						} catch (error) {
							const errorMsg =
								error instanceof Error
									? error.message
									: String(error);
							const durationMs = Date.now() - startTime;

							// Update step as failed
							const stepIdx = steps.findIndex(
								(s) => s.id === toolStepId,
							);
							if (stepIdx >= 0) {
								steps[stepIdx].status = "failed";
								steps[stepIdx].completedAt =
									new Date().toISOString();
								steps[stepIdx].durationMs = durationMs;
								steps[stepIdx].error = errorMsg;
							}

							// Check for critical errors that should fail immediately
							const isCriticalError =
								errorMsg.includes("Session not found") ||
								errorMsg.includes("session expired") ||
								errorMsg.includes("SANDBOX_WORKER_URL") ||
								errorMsg.includes("SANDBOX_AUTH_SECRET") ||
								errorMsg.includes(
									"Anthropic API key not configured",
								) ||
								errorMsg.includes("GitHub not connected");

							// Track consecutive failures
							consecutiveFailures++;

							await addWorkflowLog({
								planId,
								level: "error",
								message: `Tool failed: ${errorMsg}`,
								stepId: toolStepId,
							});

							// Broadcast tool failure
							const failedStep = steps.find(
								(s) => s.id === toolStepId,
							);
							if (failedStep) {
								await broadcastProgress({
									planId,
									projectId,
									type: "step_completed",
									data: { step: failedStep },
								});
							}

							toolResultMessages.push({
								role: "tool",
								content: JSON.stringify({ error: errorMsg }),
								tool_call_id: toolCall.id,
							});

							// Fail immediately on critical configuration/session errors
							if (isCriticalError) {
								log.error(
									"Critical error detected, stopping workflow immediately",
									{
										planId,
										error: errorMsg,
									},
								);

								await addWorkflowLog({
									planId,
									level: "error",
									message: `Workflow stopped: ${errorMsg}`,
								});

								await updateWorkflowPlan({
									planId,
									status: "failed",
									steps: [...steps],
									result: {
										success: false,
										error: errorMsg,
										totalTurns: turnIndex,
									},
								});

								await broadcastProgress({
									planId,
									projectId,
									type: "agent_failed",
									data: {
										error: errorMsg,
										turnIndex,
									},
								});

								throw ApplicationFailure.nonRetryable(
									errorMsg,
									"TASK_AGENT_FAILED",
								);
							}

							// Check if we've hit too many consecutive failures
							if (
								consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
							) {
								const consecutiveError = `Agent stopped after ${consecutiveFailures} consecutive tool failures`;
								log.warn(
									"Too many consecutive tool failures, stopping workflow",
									{
										planId,
										consecutiveFailures,
									},
								);

								await addWorkflowLog({
									planId,
									level: "error",
									message: `Workflow stopped: ${consecutiveFailures} consecutive tool failures. The agent appears to be stuck.`,
								});

								await updateWorkflowPlan({
									planId,
									status: "failed",
									steps: [...steps],
									result: {
										success: false,
										error: consecutiveError,
									},
								});

								await broadcastProgress({
									planId,
									projectId,
									type: "agent_failed",
									data: {
										error: consecutiveError,
										turnIndex,
									},
								});

								throw ApplicationFailure.nonRetryable(
									consecutiveError,
									"TASK_AGENT_FAILED",
								);
							}
						}

						await updateWorkflowPlan({ planId, steps: [...steps] });
					}
				}

				// Add tool results as individual tool messages (proper AI SDK format)
				for (const toolResult of toolResultMessages) {
					messages.push(toolResult);
				}
			} else if (turnResult.stopReason === "end_turn") {
				// Agent finished
				break;
			}

			turnIndex++;

			// Small delay between turns
			await sleep(100);
		}

		// Determine final status
		const failedSteps = steps.filter((s) => s.status === "failed");
		const hasArtifacts = artifacts.length > 0;
		const isSuccess = hasArtifacts || failedSteps.length === 0;

		const finalStatus = cancelled
			? "cancelled"
			: isSuccess
				? "completed"
				: "failed";

		await updateWorkflowPlan({
			planId,
			status: finalStatus,
			steps: [...steps],
			result: {
				success: isSuccess,
				totalTurns: turnIndex,
				artifacts: hasArtifacts ? artifacts : undefined,
				...(failedSteps.length > 0 && {
					warnings: failedSteps.map((s) => ({
						name: s.name,
						error: s.error,
					})),
				}),
			},
		});

		await addWorkflowLog({
			planId,
			level: isSuccess ? "info" : "error",
			message: isSuccess
				? `Agent completed successfully in ${turnIndex} turns`
				: `Agent failed with ${failedSteps.length} errors`,
		});

		// Broadcast completion status
		if (cancelled) {
			await broadcastProgress({
				planId,
				projectId,
				type: "agent_cancelled",
				data: { reason: "User cancelled" },
			});
		} else if (isSuccess) {
			await broadcastProgress({
				planId,
				projectId,
				type: "agent_completed",
				data: {
					result: {
						success: true,
						totalTurns: turnIndex,
						artifacts: hasArtifacts ? artifacts : undefined,
					},
				},
			});
		} else {
			await broadcastProgress({
				planId,
				projectId,
				type: "agent_failed",
				data: {
					error: `${failedSteps.length} tool(s) failed`,
					turnIndex,
				},
			});
		}

		return {
			planId,
			status: finalStatus,
			totalTurns: turnIndex,
			artifacts: hasArtifacts ? artifacts : undefined,
			...(failedSteps.length > 0 && {
				error: `${failedSteps.length} tool(s) failed`,
			}),
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		// Extract the actual error message from Temporal's wrapped errors
		const errorMsg = extractErrorMessage(error);
		log.error("Workflow error", { planId, error: errorMsg });

		await updateWorkflowPlan({
			planId,
			status: "failed",
			result: { success: false, error: errorMsg },
		});

		await addWorkflowLog({
			planId,
			level: "error",
			message: `Workflow failed: ${errorMsg}`,
		});

		// Broadcast failure
		await broadcastProgress({
			planId,
			projectId,
			type: "agent_failed",
			data: { error: errorMsg, turnIndex },
		});

		throw ApplicationFailure.nonRetryable(errorMsg, "TASK_AGENT_FAILED");
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

function buildTaskPrompt(
	taskTitle: string,
	taskDescription: string,
	projectContext?: {
		projectName: string;
		projectDescription?: string;
	},
	storyContext?: {
		storyTitle: string;
		storyDescription?: string;
		acceptanceCriteria?: string;
	},
	ragContexts?: string[],
	repositoryContext?: {
		repositoryUrl: string;
		repositoryOwner?: string;
		repositoryName?: string;
		targetBranch: string;
	},
): string {
	let prompt = `# Task: ${taskTitle}\n\n`;

	if (taskDescription) {
		prompt += `## Description\n${taskDescription}\n\n`;
	}

	// Add project context
	if (projectContext) {
		prompt += "## Project Context\n";
		prompt += `**Project:** ${projectContext.projectName}\n`;
		if (projectContext.projectDescription) {
			prompt += `\n${projectContext.projectDescription}\n`;
		}
		prompt += "\n";
	}

	// Add story context
	if (storyContext) {
		prompt += "## Story Context\n";
		prompt += `**Story:** ${storyContext.storyTitle}\n`;
		if (storyContext.storyDescription) {
			prompt += `\n${storyContext.storyDescription}\n`;
		}
		if (storyContext.acceptanceCriteria) {
			prompt += `\n**Acceptance Criteria:**\n${storyContext.acceptanceCriteria}\n`;
		}
		prompt += "\n";
	}

	// Add repository context for code tasks
	if (repositoryContext) {
		prompt += "## Repository Context\n";
		prompt += "This task involves code changes in a GitHub repository.\n\n";
		prompt += `**Repository:** ${repositoryContext.repositoryUrl}\n`;
		if (
			repositoryContext.repositoryOwner &&
			repositoryContext.repositoryName
		) {
			prompt += `**Owner/Name:** ${repositoryContext.repositoryOwner}/${repositoryContext.repositoryName}\n`;
		}
		prompt += `**Target Branch:** ${repositoryContext.targetBranch}\n\n`;

		prompt += "### Code Task Workflow\n";
		prompt +=
			"1. **Create Sandbox Session:** Use `Sandbox__createSession` with this repository URL to clone the code:\n";
		prompt += `   - repoUrl: "${repositoryContext.repositoryUrl}"\n`;
		prompt += `   - branch: "${repositoryContext.targetBranch}"\n\n`;
		prompt +=
			"2. **Make Changes:** Use `Sandbox__runClaude` to have Claude Code make the necessary code changes.\n\n";
		prompt +=
			"3. **Review Changes:** Use `Sandbox__getDiff` to see the changes made.\n\n";
		prompt +=
			"4. **Request Approval:** Before committing, request approval with the diff data.\n\n";
		prompt +=
			"5. **Commit & Push:** After approval, use `Sandbox__commit` and `Sandbox__push` to save changes.\n\n";
		prompt +=
			"6. **Create PR:** Use `GitHub__create_pull_request` to open a pull request:\n";
		prompt += `   - owner: "${repositoryContext.repositoryOwner || "owner"}"\n`;
		prompt += `   - repo: "${repositoryContext.repositoryName || "repo"}"\n`;
		prompt += `   - base: "${repositoryContext.targetBranch}"\n\n`;
		prompt +=
			"7. **Cleanup:** Always call `Sandbox__destroySession` when done.\n\n";
	}

	// Add RAG-retrieved project knowledge
	if (ragContexts && ragContexts.length > 0) {
		prompt += "## Relevant Project Knowledge\n";
		prompt +=
			"The following information from the project documentation may be helpful:\n\n";
		for (let i = 0; i < ragContexts.length; i++) {
			// Truncate long contexts to avoid token limits
			const context =
				ragContexts[i].length > 2000
					? `${ragContexts[i].substring(0, 2000)}...`
					: ragContexts[i];
			prompt += `### Context ${i + 1}\n${context}\n\n`;
		}
	}

	// Instructions
	prompt += "## Instructions\n";
	if (repositoryContext) {
		prompt +=
			"This is a code task. Follow the Code Task Workflow above to make changes, get approval, and create a pull request.\n";
	} else {
		prompt += "Please complete this task. Use available tools as needed.\n";
	}
	prompt += "Request approval before any irreversible actions.";

	return prompt;
}

/**
 * Extract the actual error message from Temporal's wrapped errors
 * Temporal wraps activity failures in ActivityFailure -> ApplicationFailure -> actual error
 */
function extractErrorMessage(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}

	// Handle Temporal's ActivityFailure (wraps activity errors)
	if (error instanceof ActivityFailure) {
		// ActivityFailure wraps the actual error in its cause
		if (error.cause) {
			return extractErrorMessage(error.cause);
		}
		return error.message;
	}

	// Handle Temporal's ApplicationFailure (actual error from activity)
	if (error instanceof ApplicationFailure) {
		// ApplicationFailure.message contains the actual error message
		// Also check cause for nested errors
		if (error.cause) {
			const causeMsg = extractErrorMessage(error.cause);
			// Prefer cause if it has more info
			if (causeMsg && causeMsg !== "Unknown error") {
				return causeMsg;
			}
		}
		return error.message;
	}

	// Generic error handling
	if (error instanceof Error) {
		const anyError = error as { cause?: unknown };

		// Recursively check cause chain
		if (anyError.cause) {
			const causeMsg = extractErrorMessage(anyError.cause);
			if (
				causeMsg &&
				causeMsg !== "Unknown error" &&
				!causeMsg.includes("Activity task failed")
			) {
				return causeMsg;
			}
		}

		// Check if the message contains useful info
		if (error.message && !error.message.includes("Activity task failed")) {
			return error.message;
		}

		return error.message;
	}

	return String(error);
}

function formatToolName(toolName: string): string {
	const parts = toolName.split("__");
	const method = parts.length > 1 ? parts[1] : toolName;
	return method
		.replace(/([A-Z])/g, " $1")
		.replace(/^./, (str) => str.toUpperCase())
		.trim();
}

function extractArtifact(
	toolName: string,
	result: unknown,
): WorkflowArtifact | null {
	const structured = (
		result as { structuredContent?: Record<string, unknown> }
	)?.structuredContent;
	if (!structured) {
		return null;
	}

	const url = structured.url as string | undefined;
	const title = structured.title as string | undefined;

	if (!url) {
		return null;
	}

	// Determine artifact type from tool name
	const lower = toolName.toLowerCase();
	let type: WorkflowArtifact["type"] = "other";

	if (
		lower.includes("github") &&
		(lower.includes("pr") || lower.includes("pull_request"))
	) {
		type = "github_pr";
	} else if (lower.includes("github") && lower.includes("issue")) {
		type = "github_issue";
	} else if (lower.includes("google_docs") || lower.includes("docs__")) {
		type = "google_doc";
	} else if (lower.includes("google_sheets") || lower.includes("sheets__")) {
		type = "google_sheet";
	} else if (lower.includes("gmail")) {
		type = "gmail_message";
	}

	return { type, url, title };
}

/**
 * Validate that required fields are present in approval data
 * Local function (not an activity) since it's pure computation
 */
function validateApprovalFields(
	input: ValidateApprovalFieldsInput,
): { valid: false; error: string; missingFields: string[] } | { valid: true } {
	const { toolName, data, mcpConfig } = input;

	// Tool name format: "ServerName__methodName"
	const parts = toolName.split("__");
	if (parts.length !== 2) {
		return { valid: true }; // Can't validate, assume valid
	}

	const [serverName, methodName] = parts;

	// Find the matching tool in MCP config
	const matchingTool = mcpConfig.tools.find((t) => {
		const toolServerName = t.name.split("__")[0];
		const toolMethodName = t.name.split("__")[1];
		return toolServerName === serverName && toolMethodName === methodName;
	});

	if (!matchingTool?.approvalRequiredFields?.length) {
		return { valid: true }; // No required fields defined
	}

	// Check for missing required fields
	const missingFields = matchingTool.approvalRequiredFields.filter(
		(field) =>
			data[field] === undefined ||
			data[field] === null ||
			data[field] === "",
	);

	if (missingFields.length > 0) {
		const fieldList = matchingTool.approvalRequiredFields
			.map((f) => `"${f}"`)
			.join(", ");
		return {
			valid: false,
			error: `Missing required fields for ${toolName}: ${missingFields.join(", ")}. Please include these fields in the data parameter: ${fieldList}.`,
			missingFields,
		};
	}

	return { valid: true };
}
