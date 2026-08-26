/**
 * Trigger System Activities
 *
 * Activities for the trigger system workflows.
 * These handle trigger configuration, agent invocation, and output delivery.
 */

import type {
	TriggerConfig,
	TriggerContext,
	TriggerEvent,
} from "../workflows/trigger-system/types";

// =============================================================================
// Configuration Activities
// =============================================================================

export async function loadTriggerConfig(input: {
	triggerId: string;
	userId: string;
	organizationId?: string;
}): Promise<TriggerConfig | null> {
	const trigger = await db.agentDeploymentTrigger.findUnique({
		where: { id: input.triggerId },
		include: {
			deployment: {
				include: {
					instance: true,
				},
			},
		},
	});

	if (!trigger) {
		return null;
	}

	// Parse config from JSON
	const config = trigger.config as Record<string, unknown>;

	// Map DeploymentTriggerType to TriggerType
	const triggerTypeMap: Record<string, string> = {
		SLACK: "SLACK_MENTION",
		WEBHOOK: "WEBHOOK",
		SCHEDULE: "SCHEDULE",
		EMAIL: "EMAIL",
		API: "API",
		LIFECYCLE_EVENT: "LIFECYCLE_EVENT",
	};

	return {
		id: trigger.id,
		agentId: trigger.deployment.instance.id,
		agentName: trigger.deployment.name,
		name: trigger.deployment.name,
		type: (triggerTypeMap[trigger.type] ??
			trigger.type) as import("../workflows/trigger-system/types").TriggerType,
		status: trigger.isActive ? "ACTIVE" : "PAUSED",
		// Parse type-specific config - cast to proper type
		config: config as unknown as import("../workflows/trigger-system/types").TriggerTypeConfig,
		// Default output config: respond to source for Slack mentions
		outputConfig: {
			respondToSource: trigger.type === "SLACK",
			storeResults: true,
		},
		userId: trigger.userId ?? input.userId,
		createdAt: trigger.createdAt,
		updatedAt: trigger.updatedAt,
	};
}

export async function updateTriggerStats(input: {
	triggerId: string;
	lastTriggeredAt: string;
	success: boolean;
	error?: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	await db.agentDeploymentTrigger.update({
		where: { id: input.triggerId },
		data: {
			lastRunAt: new Date(input.lastTriggeredAt),
			totalExecutions: { increment: 1 },
		},
	});
}

// =============================================================================
// Input Transformation Activities
// =============================================================================

export async function transformInput(input: {
	template: string;
	event: TriggerEvent;
	context: TriggerContext;
}): Promise<string> {
	// Simple template substitution
	// Supported variables: {{message}}, {{userId}}, {{userName}}, {{sourceId}}, {{timestamp}}
	let result = input.template;

	const substitutions: Record<string, string> = {
		"{{message}}": input.event.message,
		"{{userId}}": input.context.triggeredBy?.id ?? "unknown",
		"{{userName}}": input.context.triggeredBy?.name ?? "Unknown User",
		"{{sourceId}}": input.context.sourceId,
		"{{timestamp}}": new Date().toISOString(),
	};

	for (const [key, value] of Object.entries(substitutions)) {
		// Escape special regex characters in the key
		const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(escapedKey, "g"), value);
	}

	return result;
}

export async function transformOutput(input: {
	template: string;
	response: string;
	event: TriggerEvent;
}): Promise<string> {
	// Simple template substitution
	// Supported variables: {{response}}, {{eventId}}, {{timestamp}}
	let result = input.template;

	const substitutions: Record<string, string> = {
		"{{response}}": input.response,
		"{{eventId}}": input.event.id,
		"{{timestamp}}": new Date().toISOString(),
	};

	for (const [key, value] of Object.entries(substitutions)) {
		// Escape special regex characters in the key
		const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		result = result.replace(new RegExp(escapedKey, "g"), value);
	}

	return result;
}

// =============================================================================
// Agent Invocation Activities
// =============================================================================

export async function invokeAgent(input: {
	agentId: string;
	message: string;
	context: {
		triggerId: string;
		triggerType: string;
		sourceId: string;
		triggeredBy?: { id: string; name: string; email?: string };
		metadata: Record<string, unknown>;
	};
	userId: string;
	organizationId?: string;
}): Promise<{ executionId: string; response: string }> {
	// For now, return a placeholder response
	// TODO: Integrate with actual agent execution system
	// This could start a child workflow or call an external agent service

	const executionId = `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

	// Placeholder: In production, this would:
	// 1. Start an agent execution workflow
	// 2. Wait for completion
	// 3. Return the response

	return {
		executionId,
		response: `I received your message: "${input.message}". This is a placeholder response while agent integration is being completed.`,
	};
}

export async function startTriggerEventWorkflow(_input: {
	triggerId: string;
	event: TriggerEvent;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	// Note: This is called from within a workflow, so it should use workflow.continueAsNew
	// or the parent workflow should handle this directly.
	// For now, this is a placeholder as the actual workflow orchestration happens
	// in the slackMentionHandlerWorkflow which calls activities directly.
}

export async function getActiveExecutionCount(_input: {
	triggerId: string;
}): Promise<number> {
	// For now, return 0 as we don't track active executions in real-time
	// TODO: Implement real-time execution counting if needed
	return 0;
}

// =============================================================================
// Output Delivery Activities
// =============================================================================

export async function sendWebhook(input: {
	url: string;
	payload: Record<string, unknown>;
}): Promise<void> {
	const response = await fetch(input.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input.payload),
	});

	if (!response.ok) {
		throw new Error(
			`Webhook failed: ${response.status} ${response.statusText}`,
		);
	}
}

export async function sendEmail(input: {
	to: string[];
	subject: string;
	body: string;
}): Promise<void> {
	// For now, this is a placeholder
	// TODO: Integrate with actual email service (e.g., Resend)
	console.log("[TriggerSystem] Would send email:", {
		to: input.to,
		subject: input.subject,
		bodyLength: input.body.length,
	});
}

export async function postToSlack(input: {
	channel: string;
	message: string;
	threadTs?: string;
	slackTeamId?: string;
	userId?: string;
	organizationId?: string;
}): Promise<{ messageTs: string; ok: boolean }> {
	// Get Slack credentials from integration
	const { getSlackCredentials } = await import("@repo/integrations");

	if (!input.userId) {
		throw new Error("userId is required for Slack post");
	}

	const credentials = await getSlackCredentials(
		input.userId,
		input.organizationId,
	);

	// Post message to Slack thread
	const response = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			channel: input.channel,
			thread_ts: input.threadTs,
			text: input.message,
			// Don't unfurl links to keep messages compact
			unfurl_links: false,
			unfurl_media: false,
		}),
	});

	if (!response.ok) {
		throw new Error(`Slack API error: ${response.status}`);
	}

	const data = await response.json();

	if (!data.ok) {
		throw new Error(`Slack API error: ${data.error}`);
	}

	return {
		messageTs: data.ts as string,
		ok: true,
	};
}

export async function storeResult(input: {
	triggerId: string;
	eventId: string;
	response: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	// Store the result in agent_deployment_trigger's config or a separate table
	// For now, this is a placeholder
	// TODO: Implement proper result storage if needed for history/audit
	console.log(`[TriggerSystem] Stored result for event ${input.eventId}:`, {
		triggerId: input.triggerId,
		responseLength: input.response.length,
	});
}

// =============================================================================
// Slack Thread Management Activities
// =============================================================================

import { db } from "@repo/database";

export interface ThreadMapping {
	id: string;
	slackTeamId: string;
	slackChannelId: string;
	slackThreadTs: string;
	deploymentId: string;
	triggerId: string | null;
	workflowId: string | null;
	conversationId: string | null;
	status: "active" | "paused" | "closed";
	lastMessageTs: string | null;
	timeoutAt: Date | null;
	contextJson: Record<string, unknown> | null;
	userId: string | null;
	organizationId: string | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * Get existing thread mapping or create a new one.
 * Used by the Slack Events API to track conversation continuity.
 */
export async function getOrCreateThreadMapping(input: {
	slackTeamId: string;
	slackChannelId: string;
	slackThreadTs: string;
	deploymentId: string;
	userId: string;
	organizationId?: string;
	timeoutHours?: number; // default: 24
}): Promise<{
	mappingId: string;
	isNew: boolean;
	existingWorkflowId?: string;
	existingConversationId?: string;
	context?: Record<string, unknown>;
}> {
	const timeoutHours = input.timeoutHours ?? 24;
	const timeoutAt = new Date(Date.now() + timeoutHours * 60 * 60 * 1000);

	// Try to find existing mapping
	const existing = await db.slackThreadMapping.findUnique({
		where: {
			slackTeamId_slackChannelId_slackThreadTs: {
				slackTeamId: input.slackTeamId,
				slackChannelId: input.slackChannelId,
				slackThreadTs: input.slackThreadTs,
			},
		},
	});

	if (existing) {
		return {
			mappingId: existing.id,
			isNew: false,
			existingWorkflowId: existing.workflowId ?? undefined,
			existingConversationId: existing.conversationId ?? undefined,
			context:
				(existing.contextJson as Record<string, unknown>) ?? undefined,
		};
	}

	// Create new mapping
	const created = await db.slackThreadMapping.create({
		data: {
			slackTeamId: input.slackTeamId,
			slackChannelId: input.slackChannelId,
			slackThreadTs: input.slackThreadTs,
			deploymentId: input.deploymentId,
			status: "active",
			timeoutAt,
			userId: input.userId,
			organizationId: input.organizationId,
		},
	});

	return {
		mappingId: created.id,
		isNew: true,
	};
}

/**
 * Record event receipt for idempotency protection.
 * Prevents duplicate processing of Slack Events API retries.
 */
export async function recordEventReceipt(input: {
	slackEventId: string;
	slackTeamId: string;
	slackChannelId?: string;
	slackMessageTs?: string;
	organizationId?: string;
	userId?: string;
}): Promise<{ alreadyProcessed: boolean }> {
	// Check if already processed
	const existing = await db.slackEventReceipt.findUnique({
		where: { slackEventId: input.slackEventId },
	});

	if (existing) {
		return { alreadyProcessed: true };
	}

	// Record new receipt
	await db.slackEventReceipt.create({
		data: {
			slackEventId: input.slackEventId,
			slackTeamId: input.slackTeamId,
			slackChannelId: input.slackChannelId,
			slackMessageTs: input.slackMessageTs,
			organizationId: input.organizationId,
			userId: input.userId,
		},
	});

	return { alreadyProcessed: false };
}

/**
 * Update thread mapping state after workflow changes.
 */
export async function updateThreadState(input: {
	mappingId: string;
	workflowId?: string;
	conversationId?: string;
	lastMessageTs?: string;
	contextJson?: Record<string, unknown>;
	status?: "active" | "paused" | "closed";
}): Promise<void> {
	const updateData: Record<string, unknown> = {
		updatedAt: new Date(),
	};

	if (input.workflowId !== undefined) {
		updateData.workflowId = input.workflowId;
	}
	if (input.conversationId !== undefined) {
		updateData.conversationId = input.conversationId;
	}
	if (input.lastMessageTs !== undefined) {
		updateData.lastMessageTs = input.lastMessageTs;
	}
	if (input.contextJson !== undefined) {
		updateData.contextJson = input.contextJson;
	}
	if (input.status !== undefined) {
		updateData.status = input.status;
	}

	await db.slackThreadMapping.update({
		where: { id: input.mappingId },
		data: updateData,
	});
}

/**
 * Send a reply message to a Slack thread.
 * Uses the bot token from integration connection.
 */
export async function sendSlackReply(input: {
	slackTeamId: string;
	slackChannelId: string;
	slackThreadTs: string;
	text: string;
	userId: string;
	organizationId?: string;
}): Promise<{
	messageTs: string;
	ok: boolean;
}> {
	// Get Slack credentials from integration
	const { getSlackCredentials } = await import("@repo/integrations");

	const credentials = await getSlackCredentials(
		input.userId,
		input.organizationId,
	);

	// Post reply to thread
	const response = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${credentials.accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			channel: input.slackChannelId,
			thread_ts: input.slackThreadTs,
			text: input.text,
			// Don't unfurl links to keep messages compact
			unfurl_links: false,
			unfurl_media: false,
		}),
	});

	if (!response.ok) {
		throw new Error(`Slack API error: ${response.status}`);
	}

	const data = await response.json();

	if (!data.ok) {
		throw new Error(`Slack API error: ${data.error}`);
	}

	return {
		messageTs: data.ts as string,
		ok: true,
	};
}

/**
 * Check if a thread has timed out.
 * Returns whether the thread is still active.
 */
export async function checkThreadTimeout(input: {
	mappingId: string;
}): Promise<{
	isTimedOut: boolean;
	shouldClose: boolean;
	status: string;
}> {
	const mapping = await db.slackThreadMapping.findUnique({
		where: { id: input.mappingId },
	});

	if (!mapping) {
		return {
			isTimedOut: true,
			shouldClose: true,
			status: "not_found",
		};
	}

	const now = new Date();
	const isTimedOut =
		mapping.status !== "active" ||
		(mapping.timeoutAt && mapping.timeoutAt < now);

	return {
		isTimedOut: Boolean(isTimedOut),
		shouldClose: Boolean(isTimedOut),
		status: mapping.status,
	};
}

/**
 * Close a thread mapping.
 * Used when a conversation ends or times out.
 */
export async function closeThreadMapping(input: {
	mappingId: string;
	reason: "completed" | "error" | "timeout";
}): Promise<void> {
	await db.slackThreadMapping.update({
		where: { id: input.mappingId },
		data: {
			status: "closed",
			contextJson: {
				closedAt: new Date().toISOString(),
				closeReason: input.reason,
			},
			updatedAt: new Date(),
		},
	});
}

/**
 * Get thread mapping by ID.
 */
export async function getThreadMapping(input: {
	mappingId: string;
}): Promise<ThreadMapping | null> {
	const mapping = await db.slackThreadMapping.findUnique({
		where: { id: input.mappingId },
	});

	if (!mapping) {
		return null;
	}

	return mapping as ThreadMapping;
}
