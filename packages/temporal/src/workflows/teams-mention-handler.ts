/**
 * Teams Mention Handler Workflow
 *
 * Handles @mention events from Microsoft Teams, similar to the Slack mention handler.
 * Maintains conversation history, invokes the agent, and posts replies back to Teams.
 *
 * Features:
 * - Signal-based event processing for real-time responses
 * - Conversation history persistence via DB mapping
 * - Agent invocation with context
 * - Reply posting via Microsoft Graph API
 * - continueAsNew after 50 events to avoid infinite workflow growth
 */

import {
	condition,
	continueAsNew,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type * as teamsActivities from "../activities/teams-mention";
import type * as triggerActivities from "../activities/trigger-system/index";

// Re-export shared signals from trigger-system
import {
	cancelSignal,
	pauseSignal,
	resumeSignal,
	statusQuery,
} from "./trigger-system/index";

export { cancelSignal, pauseSignal, resumeSignal, statusQuery };

// =============================================================================
// Signals
// =============================================================================

export interface TeamsMentionEvent {
	eventId: string;
	teamId: string;
	channelId: string;
	chatId?: string;
	messageId?: string;
	threadId: string;
	user: {
		id: string;
		name: string;
	};
	text: string;
	ts: string;
	isMention: boolean;
}

export const teamsMentionSignal =
	defineSignal<[TeamsMentionEvent]>("teamsMention");

// =============================================================================
// Activity Proxies
// =============================================================================

const activities = proxyActivities<typeof teamsActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

const triggerSystemActivities = proxyActivities<typeof triggerActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
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
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "120s",
		maximumAttempts: 2,
	},
});

type WorkflowStatus = "running" | "paused" | "cancelled";

// =============================================================================
// Workflow
// =============================================================================

export async function teamsMentionHandlerWorkflow(input: {
	deploymentId: string;
	teamId: string;
	channelId: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	const state = {
		status: "running" as WorkflowStatus,
		pendingEvents: [] as TeamsMentionEvent[],
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

	setHandler(teamsMentionSignal, (event: TeamsMentionEvent) => {
		state.pendingEvents.push(event);
	});

	setHandler(statusQuery, () => state.status);

	// Helper functions for status checks
	const isCancelled = () => state.status === "cancelled";
	const isPaused = () => state.status === "paused";
	const isRunning = () => state.status === "running";

	log.info("Starting Teams mention handler workflow", {
		deploymentId: input.deploymentId,
		teamId: input.teamId,
		channelId: input.channelId,
		userId: input.userId,
		organizationId: input.organizationId,
	});

	while (!isCancelled()) {
		// Wait for events or status change
		await condition(() => state.pendingEvents.length > 0 || !isRunning());

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

			// The agent's bound project, resolved by invokeAgent from the
			// deployment's toolConnections — threaded into every postToTeams
			// call (reply, error notice, catch-path notice) so the
			// activity-side read-only reply gate covers all of them.
			let boundProjectId: string | undefined;

			try {
				log.info("Processing Teams mention event", {
					eventId: event.eventId,
					teamId: event.teamId,
					channelId: event.channelId,
					processedCount: state.processedCount,
				});

				// Load thread mapping and any existing conversation history from DB
				const threadResult = await activities.loadTeamsThreadMapping({
					teamsTeamId: event.teamId,
					teamsChannelId: event.channelId,
					teamsThreadId: event.threadId,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				// Merge DB history with workflow state history (workflow state is more recent)
				const dbHistory = threadResult.conversationHistory.map(
					(h: {
						role: "user" | "assistant";
						content: string;
						ts: string;
					}) => ({
						role: h.role,
						content: h.content,
						ts: h.ts,
					}),
				);

				const currentHistory =
					state.conversationHistory.length > 0
						? state.conversationHistory
						: dbHistory;

				// Invoke the agent with conversation history
				const agentResult = await agentActivities.invokeAgent({
					agentId: input.deploymentId,
					message: event.text,
					context: {
						source: "TEAMS_MENTION",
						triggerId: input.deploymentId,
						workspaceId: event.teamId,
						channel: event.channelId,
						threadId: event.threadId,
						messageId: event.messageId,
						triggeredBy: {
							id: event.user.id,
							name: event.user.name,
						},
					},
					userId: input.userId,
					organizationId: input.organizationId,
					conversationHistory: currentHistory.map(
						(h: {
							role: "user" | "assistant";
							content: string;
						}) => ({
							role: h.role,
							content: h.content,
						}),
					),
				});
				boundProjectId = agentResult.projectId;

				if (!agentResult.success) {
					log.error("Agent invocation failed", {
						eventId: event.eventId,
						error: agentResult.error,
					});

					// Post error message to Teams
					await activities.postToTeams({
						teamId: event.teamId,
						channelId: event.channelId,
						chatId: event.chatId,
						messageId: event.messageId,
						message: `Sorry, I encountered an error: ${agentResult.error || "Unknown error"}`,
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: boundProjectId,
					});

					await triggerSystemActivities.updateTriggerStats({
						triggerId: input.deploymentId,
						lastTriggeredAt: new Date().toISOString(),
						success: false,
						error: agentResult.error,
						userId: input.userId,
						organizationId: input.organizationId,
					});

					continue;
				}

				// Post reply to Teams thread
				const postResult = await activities.postToTeams({
					teamId: event.teamId,
					channelId: event.channelId,
					chatId: event.chatId,
					messageId: event.messageId,
					message: agentResult.response,
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: boundProjectId,
				});

				if (!postResult.success) {
					log.error("Failed to post Teams reply", {
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
						ts: postResult.messageId || Date.now().toString(),
					},
				);

				// Save conversation history to thread mapping for persistence
				if (threadResult.mapping) {
					await activities.saveTeamsThreadMappingContext({
						mappingId: threadResult.mapping.id,
						conversationHistory: state.conversationHistory,
					});
				}

				// Update trigger stats
				await triggerSystemActivities.updateTriggerStats({
					triggerId: input.deploymentId,
					lastTriggeredAt: new Date().toISOString(),
					success: true,
					userId: input.userId,
					organizationId: input.organizationId,
				});

				state.processedCount++;

				log.info("Teams mention processed successfully", {
					eventId: event.eventId,
					channelId: event.channelId,
					processedCount: state.processedCount,
					agentExecutionId: agentResult.executionId,
					responseLength: agentResult.response.length,
				});
			} catch (error) {
				log.error("Failed to process Teams mention", {
					eventId: event.eventId,
					error: error instanceof Error ? error.message : "Unknown",
				});

				// Try to post error to Teams
				try {
					await activities.postToTeams({
						teamId: event.teamId,
						channelId: event.channelId,
						chatId: event.chatId,
						messageId: event.messageId,
						message:
							"Sorry, I encountered an unexpected error processing your message. Please try again.",
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: boundProjectId,
					});
				} catch (postError) {
					log.error("Failed to post error message to Teams", {
						error:
							postError instanceof Error
								? postError.message
								: "Unknown",
					});
				}
			}
		}

		// continueAsNew after 50 events to avoid infinite workflow growth.
		const shouldContinueAsNew = patched(
			"teams-mention-can-suggested-2026-04",
		)
			? workflowInfo().continueAsNewSuggested
			: state.processedCount >= 50;

		if (shouldContinueAsNew) {
			log.info("Continuing as new workflow", {
				deploymentId: input.deploymentId,
				processedCount: state.processedCount,
			});
			await continueAsNew<typeof teamsMentionHandlerWorkflow>(input);
		}
	}

	log.info("Teams mention handler workflow ended", {
		deploymentId: input.deploymentId,
		status: state.status,
		totalProcessed: state.processedCount,
	});
}
