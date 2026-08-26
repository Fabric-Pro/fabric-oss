/**
 * Trigger System Workflows
 *
 * Workflows for handling agent triggers:
 * 1. triggerEventWorkflow - Process a single trigger event
 * 2. scheduledTriggerWorkflow - Long-running workflow for scheduled triggers
 * 3. slackMentionHandlerWorkflow - Handle Slack @mentions
 */

import {
	ApplicationFailure,
	condition,
	continueAsNew,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";
import type * as triggerActivities from "../../activities/trigger-system/index";

import type {
	ScheduledTriggerInput,
	ScheduleTriggerConfig,
	TriggerConfig,
	TriggerEvent,
	TriggerWorkflowInput,
	TriggerWorkflowOutput,
} from "./types";

// Re-export types
export * from "./types";

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSignal = defineSignal("cancel");
export const pauseSignal = defineSignal("pause");
export const resumeSignal = defineSignal("resume");
export const updateScheduleSignal =
	defineSignal<[ScheduleTriggerConfig]>("updateSchedule");

export const statusQuery = defineQuery<"running" | "paused" | "cancelled">(
	"status",
);
export const nextExecutionQuery = defineQuery<Date | null>("nextExecution");
export const executionCountQuery = defineQuery<number>("executionCount");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof triggerActivities>({
	startToCloseTimeout: "5 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

// Agent execution (can take longer)
const agentActivities = proxyActivities<typeof triggerActivities>({
	startToCloseTimeout: "30 minutes",
	// Generous timeout because invokeAgent runs an 8-step LLM loop that may
	// load the cross-encoder reranker (30–60s on first call) and call slow
	// tools (RAG retrieval, story drafting). The activity heartbeats on every
	// step boundary via onStepFinish, so this only needs to cover one step.
	heartbeatTimeout: "5 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "120s",
		maximumAttempts: 2,
	},
});

// =============================================================================
// Trigger Event Workflow
// =============================================================================

/**
 * Process a single trigger event and invoke the associated agent.
 */
export async function triggerEventWorkflow(
	input: TriggerWorkflowInput,
): Promise<TriggerWorkflowOutput> {
	const startTime = Date.now();
	let cancelled = false;

	setHandler(cancelSignal, () => {
		cancelled = true;
	});

	try {
		log.info("Processing trigger event", {
			eventId: input.event.id,
			triggerId: input.triggerId,
			triggerType: input.event.triggerType,
		});

		// Load trigger configuration
		const triggerConfig = await activities.loadTriggerConfig({
			triggerId: input.triggerId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (!triggerConfig) {
			throw new Error(`Trigger ${input.triggerId} not found`);
		}

		if (triggerConfig.status !== "ACTIVE") {
			throw new Error(`Trigger ${input.triggerId} is not active`);
		}

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled",
				"TRIGGER_SYSTEM_FAILED",
			);
		}

		// Transform input using template if configured
		let message = input.event.message;
		if (triggerConfig.inputTemplate) {
			message = await activities.transformInput({
				template: triggerConfig.inputTemplate,
				event: input.event,
				context: input.event.context as unknown as Record<
					string,
					unknown
				>,
			});
		}

		// Invoke the agent. Project binding lives on the agent's
		// toolConnections["project-context"].projectId, resolved inside
		// invokeAgent — no need to thread it through workflow inputs.
		const agentResult = await agentActivities.invokeAgent({
			agentId: triggerConfig.agentId,
			message,
			context: {
				triggerId: input.triggerId,
				triggerType: input.event.triggerType,
				sourceId: input.event.context.sourceId,
				triggeredBy: input.event.context.triggeredBy,
				metadata: input.event.context.metadata,
			} as unknown as Record<string, unknown>,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (cancelled) {
			throw ApplicationFailure.nonRetryable(
				"Cancelled during execution",
				"TRIGGER_SYSTEM_FAILED",
			);
		}

		// Handle output
		if (triggerConfig.outputConfig) {
			await handleOutput(
				triggerConfig as TriggerConfig,
				input.event,
				agentResult.response,
				input.userId,
				input.organizationId,
				agentResult.projectId,
			);
		}

		// Update trigger stats
		await activities.updateTriggerStats({
			triggerId: input.triggerId,
			lastTriggeredAt: new Date().toISOString(),
			success: true,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		log.info("Trigger event processed successfully", {
			eventId: input.event.id,
			agentExecutionId: agentResult.executionId,
			durationMs: Date.now() - startTime,
		});

		return {
			eventId: input.event.id,
			triggerId: input.triggerId,
			success: true,
			agentExecutionId: agentResult.executionId,
			response: agentResult.response,
			durationMs: Date.now() - startTime,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Trigger event processing failed", {
			eventId: input.event.id,
			error: errorMessage,
		});

		// Update trigger stats with error
		try {
			await activities.updateTriggerStats({
				triggerId: input.triggerId,
				lastTriggeredAt: new Date().toISOString(),
				success: false,
				error: errorMessage,
				userId: input.userId,
				organizationId: input.organizationId,
			});
		} catch {
			// Ignore stats update errors
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"TRIGGER_SYSTEM_FAILED",
		);
	}
}

// =============================================================================
// Scheduled Trigger Workflow
// =============================================================================

/**
 * Long-running workflow that manages scheduled agent executions.
 * Supports cron expressions, intervals, and natural language schedules.
 */
type WorkflowStatus = "running" | "paused" | "cancelled";

export async function scheduledTriggerWorkflow(
	input: ScheduledTriggerInput,
): Promise<void> {
	const state = {
		status: "running" as WorkflowStatus,
		scheduleConfig: input.scheduleConfig,
		executionCount: 0,
		nextExecution: null as Date | null,
	};

	// Signal handlers
	setHandler(cancelSignal, () => {
		state.status = "cancelled";
	});

	setHandler(pauseSignal, () => {
		state.status = "paused";
	});

	setHandler(resumeSignal, () => {
		if (state.status === "paused") {
			state.status = "running";
		}
	});

	setHandler(updateScheduleSignal, (newConfig: ScheduleTriggerConfig) => {
		state.scheduleConfig = newConfig;
		// Recalculate next execution
		state.nextExecution = calculateNextExecution(state.scheduleConfig);
	});

	// Query handlers
	setHandler(statusQuery, () => state.status);
	setHandler(nextExecutionQuery, () => state.nextExecution);
	setHandler(executionCountQuery, () => state.executionCount);

	log.info("Starting scheduled trigger workflow", {
		triggerId: input.triggerId,
		scheduleType: state.scheduleConfig.scheduleType,
	});

	// Helper to check status
	const isCancelled = () => state.status === "cancelled";
	const isPaused = () => state.status === "paused";
	const isRunning = () => state.status === "running";

	// Main loop
	while (!isCancelled()) {
		// Wait if paused
		if (isPaused()) {
			await condition(() => !isPaused());
			if (isCancelled()) {
				break;
			}
		}

		// Calculate next execution time
		state.nextExecution = calculateNextExecution(state.scheduleConfig);

		if (!state.nextExecution) {
			log.warn("Could not calculate next execution time", {
				triggerId: input.triggerId,
			});
			break;
		}

		const now = new Date();
		const waitMs = state.nextExecution.getTime() - now.getTime();

		if (waitMs > 0) {
			log.info("Waiting for next scheduled execution", {
				triggerId: input.triggerId,
				nextExecution: state.nextExecution.toISOString(),
				waitMs,
			});

			// Sleep until next execution (or until signal)
			const slept = await Promise.race([
				sleep(waitMs).then(() => true),
				condition(() => !isRunning()).then(() => false),
			]);

			// Check if we were interrupted
			if (!slept || !isRunning()) {
				continue;
			}
		}

		// Check concurrent execution limit
		if (state.scheduleConfig.maxConcurrent) {
			const activeCount = await activities.getActiveExecutionCount({
				triggerId: input.triggerId,
			});

			if (activeCount >= state.scheduleConfig.maxConcurrent) {
				log.warn("Max concurrent executions reached, skipping", {
					triggerId: input.triggerId,
					activeCount,
					maxConcurrent: state.scheduleConfig.maxConcurrent,
				});
				continue;
			}
		}

		// Execute the trigger
		try {
			const event: TriggerEvent = {
				id: `sched_${Date.now()}`,
				triggerId: input.triggerId,
				triggerType: "SCHEDULE",
				rawInput: { scheduledAt: state.nextExecution.toISOString() },
				message:
					state.scheduleConfig.fixedInput || "Scheduled execution",
				context: {
					sourceId: `schedule_${input.triggerId}`,
					sourceName: "Scheduled Trigger",
					metadata: {
						scheduleType: state.scheduleConfig.scheduleType,
						executionNumber: state.executionCount + 1,
					},
				},
				receivedAt: new Date(),
				status: "pending",
			};

			// Fire and forget - don't wait for agent completion
			await activities.startTriggerEventWorkflow({
				triggerId: input.triggerId,
				event,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			state.executionCount++;

			log.info("Scheduled execution started", {
				triggerId: input.triggerId,
				eventId: event.id,
				executionCount: state.executionCount,
			});
		} catch (error) {
			log.error("Failed to start scheduled execution", {
				triggerId: input.triggerId,
				error: error instanceof Error ? error.message : "Unknown",
			});
		}

		// continueAsNew when the server suggests it (~4K events / ~4MB).
		// Gated by patched() so in-flight executions started under the prior
		// `executionCount >= 1000` threshold replay deterministically — old
		// runs stay on the count-based predicate; new runs use the server hint.
		const shouldContinueAsNew = patched(
			"scheduled-trigger-can-suggested-2026-04",
		)
			? workflowInfo().continueAsNewSuggested
			: state.executionCount >= 1000;

		if (shouldContinueAsNew) {
			await continueAsNew<typeof scheduledTriggerWorkflow>({
				...input,
				scheduleConfig: state.scheduleConfig,
			});
		}
	}

	log.info("Scheduled trigger workflow ended", {
		triggerId: input.triggerId,
		status: state.status,
		totalExecutions: state.executionCount,
	});
}

// =============================================================================
// Slack Mention Handler Workflow
// =============================================================================

/**
 * Long-running workflow that processes Slack @mentions for an agent.
 * Receives events via signal and processes them with full conversation continuity.
 *
 * Architecture:
 * 1. Workflow starts and waits for events via slackMentionSignal
 * 2. For each event, loads thread mapping + conversation history
 * 3. Calls invokeAgent activity with the full conversation context
 * 4. Calls postToSlack activity to send the reply back to the thread
 * 5. Saves updated conversation history to the thread mapping
 * 6. Uses continueAsNew after 50 events to avoid infinite growth
 */
export const slackMentionSignal =
	defineSignal<[SlackMentionEvent]>("slackMention");

export interface SlackMentionEvent {
	eventId: string;
	channel: string;
	threadTs?: string;
	user: {
		id: string;
		name: string;
	};
	text: string;
	ts: string;
	isAppMention?: boolean;
	isDm?: boolean;
}

export async function slackMentionHandlerWorkflow(input: {
	triggerId: string;
	workspaceId: string;
	botUserId: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	const state = {
		status: "running" as WorkflowStatus,
		pendingEvents: [] as SlackMentionEvent[],
		processedCount: 0,
		// Conversation history maintained in workflow state for the current session
		conversationHistory: [] as Array<{
			role: "user" | "assistant";
			content: string;
			ts: string;
		}>,
	};

	// Signal handlers
	setHandler(cancelSignal, () => {
		state.status = "cancelled";
	});

	setHandler(pauseSignal, () => {
		state.status = "paused";
	});

	setHandler(resumeSignal, () => {
		if (state.status === "paused") {
			state.status = "running";
		}
	});

	setHandler(slackMentionSignal, (event: SlackMentionEvent) => {
		state.pendingEvents.push(event);
	});

	setHandler(statusQuery, () => state.status);

	// Helper functions for status checks
	const isCancelled = () => state.status === "cancelled";
	const isPaused = () => state.status === "paused";
	const isRunning = () => state.status === "running";

	log.info("Starting Slack mention handler workflow", {
		triggerId: input.triggerId,
		workspaceId: input.workspaceId,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	// Idle threads should not pin a workflow forever. Without this, every
	// Slack DM thread leaks a long-running workflow after the conversation
	// goes quiet. Default 24h matches the threadTimeoutHours UI default.
	// TODO: thread the user-configured threadTimeoutHours from trigger config
	// once loadTriggerConfig surfaces the slack panel settings.
	const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
	const useIdleTimeout = patched("slack-mention-idle-cleanup-2026-04");

	while (!isCancelled()) {
		if (useIdleTimeout) {
			// Race the next signal against the idle window; if sleep wins, the
			// thread has gone quiet long enough that we can safely end the run
			// and free up worker resources.
			const idle = await Promise.race([
				condition(
					() => state.pendingEvents.length > 0 || !isRunning(),
				).then(() => false),
				sleep(IDLE_TIMEOUT_MS).then(() => true),
			]);
			if (idle && state.pendingEvents.length === 0 && isRunning()) {
				log.info("Slack mention thread idle past timeout, ending", {
					triggerId: input.triggerId,
					processedCount: state.processedCount,
				});
				state.status = "cancelled";
				break;
			}
		} else {
			await condition(
				() => state.pendingEvents.length > 0 || !isRunning(),
			);
		}

		if (isCancelled()) {
			break;
		}

		if (isPaused()) {
			await condition(() => !isPaused());
			continue;
		}

		// Process pending events
		while (state.pendingEvents.length > 0 && isRunning()) {
			const event = state.pendingEvents.shift();
			if (!event) {
				break;
			}

			// The agent's bound project, resolved by invokeAgent — threaded
			// into every postToSlack call (reply, error notice, catch-path
			// notice) so the activity-side read-only reply gate covers all of
			// them. Hoisted so the catch block sees it too.
			let boundProjectId: string | undefined;

			try {
				log.info("Processing Slack mention event", {
					eventId: event.eventId,
					channel: event.channel,
					threadTs: event.threadTs,
					processedCount: state.processedCount,
				});

				// Load trigger configuration to get agent ID
				const triggerConfig = await activities.loadTriggerConfig({
					triggerId: input.triggerId,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				if (!triggerConfig) {
					log.error("Trigger configuration not found", {
						triggerId: input.triggerId,
					});
					continue;
				}

				if (triggerConfig.status !== "ACTIVE") {
					log.warn("Trigger is not active, skipping event", {
						triggerId: input.triggerId,
						status: triggerConfig.status,
					});
					continue;
				}

				// Load thread mapping and any existing conversation history from DB
				const threadResult = await activities.loadSlackThreadMapping({
					slackTeamId: input.workspaceId,
					slackChannelId: event.channel,
					slackThreadTs: event.threadTs || event.ts,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				// Merge DB history with workflow state history (workflow state is more recent)
				const dbHistory = threadResult.conversationHistory.map((h) => ({
					role: h.role,
					content: h.content,
					ts: h.ts,
				}));

				// Use workflow state history if we have it, otherwise use DB history
				const currentHistory =
					state.conversationHistory.length > 0
						? state.conversationHistory
						: dbHistory;

				// Prepare the message (apply input template if configured)
				let message = event.text;
				if (triggerConfig.inputTemplate) {
					message = await activities.transformInput({
						template: triggerConfig.inputTemplate,
						event: {
							id: event.eventId,
							triggerId: input.triggerId,
							triggerType: "SLACK_MENTION",
							rawInput: event,
							message: event.text,
							context: {
								sourceId: event.channel,
								sourceName: `#${event.channel}`,
								triggeredBy: {
									id: event.user.id,
									name: event.user.name,
								},
								metadata: {
									threadTs: event.threadTs,
									messageTs: event.ts,
									workspaceId: input.workspaceId,
								},
							},
							receivedAt: new Date(),
							status: "pending",
						},
						context: {
							sourceId: event.channel,
							triggeredBy: {
								id: event.user.id,
								name: event.user.name,
							},
							metadata: {
								threadTs: event.threadTs,
								messageTs: event.ts,
								workspaceId: input.workspaceId,
							},
						},
					});
				}

				// Invoke the agent with conversation history. Project
				// binding lives on the agent's toolConnections, not the
				// trigger — invokeAgent reads it from the deployment.
				const agentResult = await agentActivities.invokeAgent({
					agentId: triggerConfig.agentId,
					message,
					context: {
						source: "SLACK_MENTION",
						triggerId: input.triggerId,
						workspaceId: input.workspaceId,
						channel: event.channel,
						threadTs: event.threadTs,
						messageTs: event.ts,
						triggeredBy: {
							id: event.user.id,
							name: event.user.name,
						},
					},
					userId: input.userId,
					organizationId: input.organizationId,
					conversationHistory: currentHistory.map((h) => ({
						role: h.role,
						content: h.content,
					})),
				});
				boundProjectId = agentResult.projectId;

				if (!agentResult.success) {
					log.error("Agent invocation failed", {
						eventId: event.eventId,
						error: agentResult.error,
					});

					// Post error message to Slack
					await activities.postToSlack({
						channel: event.channel,
						message: `Sorry, I encountered an error: ${agentResult.error || "Unknown error"}`,
						threadTs: event.threadTs || event.ts,
						slackTeamId: input.workspaceId,
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: boundProjectId,
					});

					// Update stats with error
					await activities.updateTriggerStats({
						triggerId: input.triggerId,
						lastTriggeredAt: new Date().toISOString(),
						success: false,
						error: agentResult.error,
						userId: input.userId,
						organizationId: input.organizationId,
					});

					continue;
				}

				// Transform output if template configured
				let response = agentResult.response;
				if (triggerConfig.outputConfig?.outputTemplate) {
					response = await activities.transformOutput({
						template: triggerConfig.outputConfig.outputTemplate,
						response: agentResult.response,
						event: {
							id: event.eventId,
							triggerId: input.triggerId,
							triggerType: "SLACK_MENTION",
							rawInput: event,
							message: event.text,
							context: {
								sourceId: event.channel,
								triggeredBy: {
									id: event.user.id,
									name: event.user.name,
								},
								metadata: {
									threadTs: event.threadTs,
									messageTs: event.ts,
									workspaceId: input.workspaceId,
								},
							},
							receivedAt: new Date(),
							status: "pending",
						},
					});
				}

				// Post reply to Slack thread
				const postResult = await activities.postToSlack({
					channel: event.channel,
					message: response,
					threadTs: event.threadTs || event.ts,
					slackTeamId: input.workspaceId,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: boundProjectId,
				});

				if (!postResult.success) {
					log.error("Failed to post Slack reply", {
						eventId: event.eventId,
						error: postResult.error,
					});
				}

				// Update conversation history
				state.conversationHistory.push(
					{ role: "user", content: event.text, ts: event.ts },
					{
						role: "assistant",
						content: agentResult.response,
						ts: postResult.messageTs || Date.now().toString(),
					},
				);

				// Save conversation history to thread mapping for persistence
				if (threadResult.mapping) {
					await activities.saveSlackThreadMappingContext({
						mappingId: threadResult.mapping.id,
						conversationHistory: state.conversationHistory,
					});
				}

				// Update trigger stats
				await activities.updateTriggerStats({
					triggerId: input.triggerId,
					lastTriggeredAt: new Date().toISOString(),
					success: true,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				state.processedCount++;

				log.info("Slack mention processed successfully", {
					eventId: event.eventId,
					channel: event.channel,
					processedCount: state.processedCount,
					agentExecutionId: agentResult.executionId,
					responseLength: response.length,
				});
			} catch (error) {
				log.error("Failed to process Slack mention", {
					eventId: event.eventId,
					error: error instanceof Error ? error.message : "Unknown",
				});

				// Try to post error to Slack
				try {
					await activities.postToSlack({
						channel: event.channel,
						message:
							"Sorry, I encountered an unexpected error processing your message. Please try again.",
						threadTs: event.threadTs || event.ts,
						slackTeamId: input.workspaceId,
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: boundProjectId,
					});
				} catch (postError) {
					log.error("Failed to post error message to Slack", {
						error:
							postError instanceof Error
								? postError.message
								: "Unknown",
					});
				}
			}
		}

		// continueAsNew after 50 events to avoid infinite workflow growth.
		// This preserves conversation history by saving to DB before continuing.
		// Gated by patched() so in-flight executions replay deterministically.
		const shouldContinueAsNew = patched(
			"slack-mention-can-suggested-2026-04",
		)
			? workflowInfo().continueAsNewSuggested
			: state.processedCount >= 50;

		if (shouldContinueAsNew) {
			log.info("Continuing as new workflow", {
				triggerId: input.triggerId,
				processedCount: state.processedCount,
			});
			await continueAsNew<typeof slackMentionHandlerWorkflow>(input);
		}
	}

	log.info("Slack mention handler workflow ended", {
		triggerId: input.triggerId,
		status: state.status,
		totalProcessed: state.processedCount,
	});
}

// =============================================================================
// Helper Functions
// =============================================================================

function calculateNextExecution(config: ScheduleTriggerConfig): Date | null {
	const now = new Date();

	if (config.scheduleType === "interval" && config.intervalMinutes) {
		return new Date(now.getTime() + config.intervalMinutes * 60 * 1000);
	}

	if (config.scheduleType === "cron" && config.cronExpression) {
		// Parse cron expression and calculate next occurrence
		// This is a simplified implementation - in production, use a library like cron-parser
		return calculateNextCronOccurrence(
			config.cronExpression,
			config.timezone,
		);
	}

	if (config.scheduleType === "natural_language" && config.parsedCron) {
		return calculateNextCronOccurrence(config.parsedCron, config.timezone);
	}

	return null;
}

function calculateNextCronOccurrence(
	_cronExpression: string,
	_timezone: string,
): Date | null {
	// Simplified cron parsing - in production use cron-parser library
	// For now, default to 1 hour from now
	return new Date(Date.now() + 60 * 60 * 1000);
}

async function handleOutput(
	config: TriggerConfig,
	event: TriggerEvent,
	response: string,
	userId: string,
	organizationId?: string,
	// The agent's bound project, resolved by invokeAgent — threaded into the
	// Slack post so the activity-side read-only reply gate can apply.
	projectId?: string,
): Promise<void> {
	const outputConfig = config.outputConfig;

	// Transform output if template provided
	let output = response;
	if (outputConfig?.outputTemplate) {
		output = await activities.transformOutput({
			template: outputConfig.outputTemplate,
			response,
			event,
		});
	}

	// Send to webhook
	if (outputConfig?.webhookUrl) {
		await activities.sendWebhook({
			url: outputConfig.webhookUrl,
			payload: { eventId: event.id, response: output },
		});
	}

	// Send email
	if (outputConfig?.emailTo?.length) {
		await activities.sendEmail({
			to: outputConfig.emailTo,
			subject: `Agent Response: ${config.agentName}`,
			body: output,
		});
	}

	// Post to Slack
	// For Slack mentions, reply in the same thread using the source channel
	const shouldPostToSlack =
		outputConfig?.slackChannel ||
		(event.triggerType === "SLACK_MENTION" && event.context.sourceId);

	if (shouldPostToSlack) {
		const channel = outputConfig?.slackChannel || event.context.sourceId;
		await activities.postToSlack({
			channel,
			message: output,
			threadTs:
				event.triggerType === "SLACK_MENTION"
					? (event.context.metadata.threadTs as string)
					: undefined,
			slackTeamId:
				event.triggerType === "SLACK_MENTION"
					? (event.context.metadata.workspaceId as string)
					: undefined,
			userId,
			organizationId,
			projectId,
		});
	}

	// Store results
	if (outputConfig?.storeResults) {
		await activities.storeResult({
			triggerId: config.id,
			eventId: event.id,
			response: output,
			userId,
			organizationId,
		});
	}
}

// =============================================================================
// Channel-agnostic message handler (Slice 5a.1)
// =============================================================================

/**
 * Channel-agnostic inbound message envelope. Mirrors NormalizedMessage from
 * @repo/integrations/channels but lives here so workflow code stays
 * dependency-free at the Temporal sandbox boundary.
 */
export interface ChannelMessageEvent {
	externalEventId: string;
	channel: string;
	channelId: string;
	threadId: string;
	text: string;
	sender: { id: string; name?: string };
	isDirect: boolean;
	occurredAt: string;
}

export const channelMessageSignal =
	defineSignal<[ChannelMessageEvent]>("channelMessage");

/**
 * Long-running per-thread workflow that drains channel messages, invokes the
 * bound agent for each, and posts the response back via the same channel.
 *
 * Mirrors slackMentionHandlerWorkflow but channel-agnostic — Telegram today;
 * Discord/Teams/etc. as adapters land. Slack continues to use its bespoke
 * workflow until Slice 5b retires it.
 */
export async function channelMessageHandlerWorkflow(input: {
	triggerId: string;
	deploymentId: string;
	channel: string;
	channelId: string;
	threadId: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	const state = {
		status: "running" as WorkflowStatus,
		pendingEvents: [] as ChannelMessageEvent[],
		processedCount: 0,
		conversationHistory: [] as Array<{
			role: "user" | "assistant";
			content: string;
		}>,
	};

	setHandler(cancelSignal, () => {
		state.status = "cancelled";
	});
	setHandler(pauseSignal, () => {
		state.status = "paused";
	});
	setHandler(resumeSignal, () => {
		if (state.status === "paused") {
			state.status = "running";
		}
	});
	setHandler(channelMessageSignal, (event: ChannelMessageEvent) => {
		state.pendingEvents.push(event);
	});
	setHandler(statusQuery, () => state.status);

	const isCancelled = () => state.status === "cancelled";
	const isPaused = () => state.status === "paused";
	const isRunning = () => state.status === "running";

	log.info("channelMessageHandlerWorkflow start", {
		triggerId: input.triggerId,
		channel: input.channel,
		channelId: input.channelId,
		threadId: input.threadId,
	});

	const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

	while (!isCancelled()) {
		const idle = await Promise.race([
			condition(
				() => state.pendingEvents.length > 0 || !isRunning(),
			).then(() => false),
			sleep(IDLE_TIMEOUT_MS).then(() => true),
		]);
		if (idle && state.pendingEvents.length === 0 && isRunning()) {
			log.info(
				"channelMessageHandlerWorkflow idle past timeout, ending",
				{
					triggerId: input.triggerId,
					processedCount: state.processedCount,
				},
			);
			state.status = "cancelled";
			break;
		}
		if (isCancelled()) {
			break;
		}
		if (isPaused()) {
			await condition(() => !isPaused());
			continue;
		}

		while (state.pendingEvents.length > 0 && isRunning()) {
			const event = state.pendingEvents.shift();
			if (!event) {
				break;
			}
			try {
				const result = await activities.invokeAgent({
					agentId: input.deploymentId,
					message: event.text,
					context: {
						channel: event.channel,
						channelId: event.channelId,
						threadId: event.threadId,
						sender: event.sender,
						isDirect: event.isDirect,
					},
					userId: input.userId,
					organizationId: input.organizationId,
					conversationHistory: state.conversationHistory.map((m) => ({
						role: m.role,
						content: m.content,
					})),
				});

				state.conversationHistory.push({
					role: "user",
					content: event.text,
				});
				if (result.success && result.response) {
					state.conversationHistory.push({
						role: "assistant",
						content: result.response,
					});
					await activities.postToChannel({
						channel: input.channel,
						channelId: input.channelId,
						threadId: input.threadId || undefined,
						text: result.response,
						userId: input.userId,
						organizationId: input.organizationId,
						// Bound project resolved by invokeAgent — read-only
						// reply gate lives in the activity.
						projectId: result.projectId,
					});
				} else {
					log.error(
						"channelMessageHandlerWorkflow agent invoke failed",
						{
							triggerId: input.triggerId,
							eventId: event.externalEventId,
							error: result.error,
						},
					);
				}
				state.processedCount += 1;
			} catch (err) {
				if (err instanceof ApplicationFailure) {
					throw err;
				}
				log.error("channelMessageHandlerWorkflow event failed", {
					triggerId: input.triggerId,
					eventId: event.externalEventId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Cap conversation history to keep workflow state bounded.
		if (state.conversationHistory.length > 50) {
			state.conversationHistory = state.conversationHistory.slice(-50);
		}

		// Continue-as-new after a sane number of events to keep history small.
		if (state.processedCount >= 50 && state.pendingEvents.length === 0) {
			log.info("channelMessageHandlerWorkflow continueAsNew", {
				triggerId: input.triggerId,
				processedCount: state.processedCount,
			});
			await continueAsNew<typeof channelMessageHandlerWorkflow>(input);
		}
	}
}
