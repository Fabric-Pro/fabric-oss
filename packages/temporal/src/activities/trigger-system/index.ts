/**
 * Trigger System Activities
 *
 * Activities for the trigger system workflows:
 * - triggerEventWorkflow
 * - scheduledTriggerWorkflow
 * - slackMentionHandlerWorkflow
 */

import { db, hasProjectAccess, isProjectReadOnly } from "@repo/database";
import { channelRegistry } from "@repo/integrations";
import { sendSlackMessage } from "@repo/integrations/slack";
import { decryptApiKey } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import type { TriggerEvent } from "../../workflows/trigger-system/types";
import { makeInFlightToolCompactor } from "../agentic-loop/in-flight-tool-compaction";

// =============================================================================
// Types
// =============================================================================

export interface TriggerConfig {
	id: string;
	agentId: string;
	agentName: string;
	status: "ACTIVE" | "INACTIVE";
	inputTemplate?: string;
	outputConfig?: {
		outputTemplate?: string;
		webhookUrl?: string;
		emailTo?: string[];
		slackChannel?: string;
		storeResults?: boolean;
	};
}

// =============================================================================
// Trigger Configuration Activities
// =============================================================================

/**
 * Load trigger configuration from database
 */
export async function loadTriggerConfig({
	triggerId,
	userId,
	organizationId,
}: {
	triggerId: string;
	userId: string;
	organizationId?: string;
}): Promise<TriggerConfig | null> {
	const trigger = await db.agentDeploymentTrigger.findFirst({
		where: {
			id: triggerId,
			isActive: true,
			userId,
			organizationId: organizationId ?? null,
		},
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

	const config = trigger.config as Record<string, unknown> | null;

	return {
		id: trigger.id,
		agentId: trigger.deploymentId,
		agentName: trigger.deployment.instance.name,
		status: trigger.isActive ? "ACTIVE" : "INACTIVE",
		inputTemplate: config?.inputTemplate as string | undefined,
		outputConfig: {
			outputTemplate: config?.outputTemplate as string | undefined,
			webhookUrl: config?.webhookUrl as string | undefined,
			emailTo: config?.emailTo as string[] | undefined,
			slackChannel: config?.slackChannel as string | undefined,
			storeResults: config?.storeResults as boolean | undefined,
		},
	};
}

/**
 * Transform input using template
 */
export async function transformInput({
	template,
	event,
	context,
}: {
	template: string;
	event: TriggerEvent;
	context: Record<string, unknown>;
}): Promise<string> {
	// Simple template replacement
	let result = template;
	result = result.replace(/{{message}}/g, event.message);
	result = result.replace(/{{sourceId}}/g, context.sourceId as string);
	result = result.replace(
		/{{triggeredBy}}/g,
		JSON.stringify(context.triggeredBy),
	);
	result = result.replace(/{{metadata}}/g, JSON.stringify(context.metadata));

	return result;
}

// =============================================================================
// Slack Thread Management Activities
// =============================================================================

export interface SlackThreadMessage {
	role: "user" | "assistant";
	content: string;
	ts: string;
}

/**
 * Load Slack thread mapping and conversation history
 */
export async function loadSlackThreadMapping({
	slackTeamId,
	slackChannelId,
	slackThreadTs,
	userId,
	organizationId,
}: {
	slackTeamId: string;
	slackChannelId: string;
	slackThreadTs: string;
	userId: string;
	organizationId?: string;
}): Promise<{
	mapping: {
		id: string;
		deploymentId: string;
		triggerId: string | null;
		status: string;
		contextJson: Record<string, unknown> | null;
	} | null;
	conversationHistory: SlackThreadMessage[];
}> {
	const mapping = await db.slackThreadMapping.findFirst({
		where: {
			slackTeamId,
			slackChannelId,
			slackThreadTs,
			userId,
			organizationId: organizationId ?? null,
		},
		select: {
			id: true,
			deploymentId: true,
			triggerId: true,
			status: true,
			contextJson: true,
		},
	});

	if (!mapping) {
		return { mapping: null, conversationHistory: [] };
	}

	// Extract conversation history from contextJson
	const contextJson = (mapping.contextJson as Record<string, unknown>) || {};
	const history =
		(contextJson.conversationHistory as SlackThreadMessage[]) || [];

	return {
		mapping: {
			id: mapping.id,
			deploymentId: mapping.deploymentId,
			triggerId: mapping.triggerId,
			status: mapping.status,
			contextJson: mapping.contextJson as Record<string, unknown> | null,
		},
		conversationHistory: history,
	};
}

/**
 * Save conversation context to Slack thread mapping
 */
export async function saveSlackThreadMappingContext({
	mappingId,
	conversationHistory,
}: {
	mappingId: string;
	conversationHistory: SlackThreadMessage[];
}): Promise<{ success: boolean }> {
	try {
		await db.slackThreadMapping.update({
			where: { id: mappingId },
			data: {
				contextJson: {
					conversationHistory,
					lastUpdated: new Date().toISOString(),
				} as unknown as import("@prisma/client/runtime/library").InputJsonValue,
			},
		});
		return { success: true };
	} catch (error) {
		console.error("[TriggerSystem] Failed to save thread context:", error);
		return { success: false };
	}
}

// =============================================================================
// Agent Execution Activities
// =============================================================================

/**
 * Invoke agent with the trigger event.
 *
 * Loads the agent deployment configuration, resolves an AI model,
 * and generates a response using the LLM with conversation context.
 *
 * Project context is bound at the agent level via the Project Context tool
 * (toolConnections["project-context"].projectId). When set, project metadata
 * is injected into the system prompt and the project_rag_query tool is
 * exposed to the LLM via AI SDK multi-step tool calling — regardless of
 * which trigger fired the agent.
 *
 * Note on identity: queries here use the trigger owner's
 * { userId, organizationId } — not the Slack user who sent the message.
 * That means anyone in the bound channel effectively reads project content
 * as the trigger owner. This is consistent with the rest of the trigger
 * system's identity model.
 */
export async function invokeAgent({
	agentId,
	message,
	context,
	userId,
	organizationId,
	conversationHistory,
}: {
	agentId: string;
	message: string;
	context: Record<string, unknown>;
	userId: string;
	organizationId?: string;
	conversationHistory?: Array<{
		role: "user" | "assistant";
		content: string;
	}>;
}): Promise<{
	success: boolean;
	response: string;
	executionId?: string;
	error?: string;
	/**
	 * The agent's bound project (toolConnections["project-context"]), surfaced
	 * so the calling workflow can thread it into reply activities for the
	 * read-only reply gate. Undefined when the agent has no
	 * project binding.
	 */
	projectId?: string;
}> {
	const executionId = `trigger-${agentId}-${Date.now()}`;

	// Hoisted outside the try so the catch-path return carries the binding
	// too — error notices are replies as well and must obey the gate.
	let boundProjectId: string | undefined;

	try {
		// Load deployment configuration
		const {
			getAgentDeploymentById,
			extractEnabledBuiltInToolKeys,
			mapBuiltInKeysToFabricToolIds,
			getBuiltInToolConfig,
		} = await import("@repo/database");
		const deployment = await getAgentDeploymentById(agentId, {
			userId,
			organizationId,
		});

		if (!deployment) {
			return {
				success: false,
				response: "",
				error: `Agent deployment ${agentId} not found or access denied`,
			};
		}

		const instance = deployment.instance;
		const template = instance.template;

		// Project binding lives on the agent (toolConnections["project-context"]),
		// not the trigger — same agent answers about the same project across
		// Slack, web chat, and schedules.
		const projectContextConfig = getBuiltInToolConfig(
			instance.toolConnections,
			"project-context",
		);
		const projectIdRaw = projectContextConfig?.projectId;
		const projectId =
			typeof projectIdRaw === "string" && projectIdRaw.length > 0
				? projectIdRaw
				: undefined;
		boundProjectId = projectId;

		const { getAIModelWithMetadata, getCurrentDateContext } = await import(
			"@repo/ai"
		);
		const { generateText, stepCountIs } = await import("ai");

		const enabledBuiltInKeys = extractEnabledBuiltInToolKeys(
			instance.toolConnections,
		);
		const enabledFabricToolIds =
			mapBuiltInKeysToFabricToolIds(enabledBuiltInKeys);

		// Authorize the bound project against project membership before any
		// project-scoped fetch. tenantWhere() in getProjectMetadataActivity
		// only checks org-level scope, which would let any org member reach
		// any org project. hasProjectAccess enforces the project-membership
		// contract used by the rest of the project RAG entry points.
		const [{ model, metadata }, projectAccessOk] = await Promise.all([
			getAIModelWithMetadata(
				{ taskType: "CHAT" },
				{ userId, organizationId },
			),
			projectId
				? hasProjectAccess(projectId, userId, organizationId)
				: Promise.resolve(false),
		]);

		const verifiedProjectId =
			projectId && projectAccessOk ? projectId : undefined;
		if (projectId && !verifiedProjectId) {
			console.warn(
				"[TriggerSystem] Skipping project context — bound project not accessible to agent owner",
				{ executionId, agentId, projectId, userId, organizationId },
			);
		}

		// Build the system-prompt block only after access is verified.
		const projectBlock = verifiedProjectId
			? await import("../shared/project-context-block").then(
					({ buildProjectContextBlock }) =>
						buildProjectContextBlock(verifiedProjectId, {
							userId,
							organizationId: organizationId ?? null,
						}),
				)
			: null;

		const effectiveFabricToolIds = verifiedProjectId
			? enabledFabricToolIds
			: enabledFabricToolIds.filter((id) => id !== "project_rag_query");

		// createBuiltInTools is shared with the direct-chat runtime — same
		// project_rag_query factory backs both surfaces.
		const tools: Record<string, unknown> =
			effectiveFabricToolIds.length > 0
				? await import("../direct-chat/built-in-tools").then(
						({ createBuiltInTools }) =>
							createBuiltInTools({
								userId,
								organizationId,
								projectId: verifiedProjectId,
								enabledFabricToolIds: effectiveFabricToolIds,
							}),
					)
				: {};

		const parts: string[] = [];

		parts.push(`You are ${instance.name}, an intelligent assistant.`);

		if (template.instructions) {
			parts.push(template.instructions);
		}

		if (instance.description) {
			parts.push(`About you: ${instance.description}`);
		}

		const customInstructions = instance.customInstructions as
			| Record<string, unknown>
			| undefined;
		if (customInstructions?.systemPrompt) {
			parts.push(String(customInstructions.systemPrompt));
		}

		if (projectBlock) {
			parts.push(projectBlock);
		}

		const source = context.source as string | undefined;
		const triggeredBy = context.triggeredBy as
			| { id: string; name: string }
			| undefined;

		if (source === "trigger" || source === "SLACK_MENTION") {
			parts.push(
				"You are responding via Slack. Be concise, friendly, and use markdown formatting where appropriate.",
			);
		}

		if (triggeredBy) {
			parts.push(`The user messaging you is: ${triggeredBy.name}`);
		}

		parts.push("Respond concisely and helpfully.");

		// Date context last — keeps the stable instruction text at position 0
		// so provider prompt caching can match on it across turns.
		parts.push(getCurrentDateContext());

		const systemPrompt = parts.join("\n\n");

		const toolNames = Object.keys(tools);

		// Build messages array with conversation history
		const messages: Array<{ role: "user" | "assistant"; content: string }> =
			[];

		for (const h of conversationHistory || []) {
			messages.push({ role: h.role, content: h.content });
		}

		messages.push({ role: "user", content: message });

		console.log("[TriggerSystem] Invoking agent", {
			executionId,
			agentId,
			projectId: verifiedProjectId ?? null,
			model: metadata.modelString,
			historyLength: conversationHistory?.length ?? 0,
			messageLength: message.length,
			tools: toolNames,
			builtInKeys: enabledBuiltInKeys,
		});

		// Heartbeat before the LLM call so Temporal sees liveness even if
		// the first step (model warmup, reranker first-load) takes a while.
		heartbeat({ phase: "invoking_model", executionId });

		// Generate response. With tools enabled, allow the model to take
		// multiple tool-calling steps before emitting the final assistant text.
		// Heartbeat on every step boundary so a multi-step run can't silently
		// outrun the activity heartbeat timeout.
		const result = await generateText({
			model,
			system: systemPrompt,
			messages,
			onStepFinish: () => {
				heartbeat({ phase: "step_finished", executionId });
			},
			prepareStep: makeInFlightToolCompactor(),
			...(toolNames.length > 0
				? { tools, stopWhen: stepCountIs(8) }
				: {}),
		} as Parameters<typeof generateText>[0]);

		const stepCount = Array.isArray((result as { steps?: unknown[] }).steps)
			? (result as { steps: unknown[] }).steps.length
			: undefined;

		console.log("[TriggerSystem] Agent response generated", {
			executionId,
			responseLength: result.text.length,
			steps: stepCount,
		});

		return {
			success: true,
			response: result.text,
			executionId,
			projectId: boundProjectId,
		};
	} catch (error) {
		console.error("[TriggerSystem] Agent invocation failed:", error);
		return {
			success: false,
			response: "",
			executionId,
			error: error instanceof Error ? error.message : "Unknown error",
			projectId: boundProjectId,
		};
	}
}

// =============================================================================
// Output Handling Activities
// =============================================================================

/**
 * Transform output using template
 */
export async function transformOutput({
	template,
	response,
	event,
}: {
	template: string;
	response: string;
	event: TriggerEvent;
}): Promise<string> {
	// Simple template replacement
	let result = template;
	result = result.replace(/{{response}}/g, response);
	result = result.replace(/{{eventId}}/g, event.id);
	result = result.replace(/{{triggerType}}/g, event.triggerType);

	return result;
}

/**
 * Send webhook notification
 */
export async function sendWebhook({
	url,
	payload,
}: {
	url: string;
	payload: Record<string, unknown>;
}): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Webhook failed: ${response.status} ${response.statusText}`,
			};
		}

		return { success: true };
	} catch (error) {
		console.error("[TriggerSystem] Webhook failed:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Send email notification
 */
export async function sendEmail({
	to,
	subject,
	body,
}: {
	to: string[];
	subject: string;
	body: string;
}): Promise<{ success: boolean; error?: string }> {
	// Email sending would be implemented here
	// For now, just log
	console.log("[TriggerSystem] Email would be sent:", {
		to,
		subject,
		bodyLength: body.length,
	});
	return { success: true };
}

/**
 * Post message to Slack
 */
export async function postToSlack({
	channel,
	message,
	threadTs,
	slackTeamId,
	userId,
	organizationId,
	projectId,
}: {
	channel: string;
	message: string;
	threadTs?: string;
	slackTeamId?: string;
	userId: string;
	organizationId?: string;
	/** The agent's bound project — enables the read-only reply gate below. */
	projectId?: string;
}): Promise<{
	success: boolean;
	error?: string;
	messageTs?: string;
	skipped?: boolean;
}> {
	// Read-only mode reply gate:
	// a project-BOUND agent posts nothing to Slack while its project is in
	// Read-only mode — the mention goes unanswered. Dropped, not failed, so
	// the workflow neither errors nor retries. Agents with no project binding
	// reply normally.
	if (projectId && (await isProjectReadOnly(projectId))) {
		console.info(
			"[TriggerSystem] Skipping Slack reply — bound project is in Read-only mode",
			{ channel, projectId },
		);
		return { success: true, skipped: true };
	}

	try {
		if (!slackTeamId) {
			return {
				success: false,
				error: "No Slack team ID provided",
			};
		}

		const result = await sendSlackMessage({
			teamId: slackTeamId,
			channel,
			text: message,
			threadTs,
			userId,
			organizationId,
		});

		if (result.ok && result.messageTs && threadTs) {
			await db.slackThreadMapping
				.updateMany({
					where: {
						slackTeamId,
						slackChannelId: channel,
						slackThreadTs: threadTs,
					},
					data: { lastMessageTs: result.messageTs },
				})
				.catch((error) => {
					console.warn(
						"[TriggerSystem] Failed to update Slack thread mapping after reply:",
						error,
					);
				});
		}

		return {
			success: result.ok,
			messageTs: result.messageTs,
			error: result.error,
		};
	} catch (error) {
		console.error("[TriggerSystem] Slack post failed:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Store execution result
 */
export async function storeResult({
	triggerId,
	eventId,
	response: _response,
	userId: _userId,
	organizationId: _organizationId,
}: {
	triggerId: string;
	eventId: string;
	response: string;
	userId: string;
	organizationId?: string;
}): Promise<{ success: boolean }> {
	try {
		// Results are tracked via AgentDeploymentExecution in updateTriggerStats
		console.info(
			`[TriggerSystem] Result stored for trigger=${triggerId} event=${eventId}`,
		);
		return { success: true };
	} catch (error) {
		console.error("[TriggerSystem] Store result failed:", error);
		return { success: false };
	}
}

// =============================================================================
// Workflow Management Activities
// =============================================================================

/**
 * Start a trigger event workflow
 */
export async function startTriggerEventWorkflow({
	triggerId,
	event,
	userId,
	organizationId,
}: {
	triggerId: string;
	event: TriggerEvent;
	userId: string;
	organizationId?: string;
}): Promise<{ success: boolean; workflowId?: string; error?: string }> {
	try {
		const { getTemporalClient } = await import("../../client");
		const temporalClient = await getTemporalClient();

		const workflowId = `trigger-event-${event.id}`;

		await temporalClient.workflow.start("triggerEventWorkflow", {
			workflowId,
			taskQueue: "trigger-system",
			args: [
				{
					triggerId,
					event,
					userId,
					organizationId,
				},
			],
		});

		return { success: true, workflowId };
	} catch (error) {
		console.error("[TriggerSystem] Start workflow failed:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Get active execution count for a trigger
 */
export async function getActiveExecutionCount({
	triggerId,
}: {
	triggerId: string;
}): Promise<number> {
	const count = await db.agentDeploymentExecution.count({
		where: {
			triggerId,
			status: {
				in: ["PENDING", "RUNNING"],
			},
		},
	});

	return count;
}

/**
 * Update trigger statistics
 */
export async function updateTriggerStats({
	triggerId,
	lastTriggeredAt,
	success,
	error,
	userId,
	organizationId,
}: {
	triggerId: string;
	lastTriggeredAt: string;
	success: boolean;
	error?: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	try {
		await db.agentDeploymentTrigger.update({
			where: { id: triggerId },
			data: {
				lastRunAt: new Date(lastTriggeredAt),
				totalExecutions: { increment: 1 },
			},
		});

		// Create execution record for history
		const trigger = await db.agentDeploymentTrigger.findUnique({
			where: { id: triggerId },
			select: { deploymentId: true, type: true },
		});

		await db.agentDeploymentExecution.create({
			data: {
				executionId: `trigger-${triggerId}-${Date.now()}`,
				triggerType: trigger?.type ?? "webhook",
				triggerId,
				status: success ? "COMPLETED" : "FAILED",
				startedAt: new Date(lastTriggeredAt),
				completedAt: new Date(),
				error: error || null,
				userId,
				organizationId: organizationId ?? null,
				deployment: {
					connect: {
						id: trigger?.deploymentId ?? "",
					},
				},
			},
		});
	} catch (err) {
		console.error("[TriggerSystem] Update stats failed:", err);
		// Non-critical, don't throw
	}
}

// =============================================================================
// Channel-agnostic activities (Slice 5a.1)
// =============================================================================

/**
 * Resolve credentials for a (tenant, providerKey) pair the same way the
 * unified webhook route does. Used by `postToChannel` to look up the bot
 * token before calling the adapter.
 */
async function resolveChannelCredentials(
	userId: string,
	organizationId: string | undefined,
	providerKey: string,
): Promise<Record<string, unknown> | undefined> {
	type ProviderEnum = NonNullable<
		Parameters<typeof db.workflowIntegration.findFirst>[0]
	>["where"] extends infer W
		? W extends { provider?: infer P }
			? P
			: never
		: never;
	const where = organizationId
		? { organizationId, isActive: true }
		: { userId, organizationId: null, isActive: true };
	const integration = await db.workflowIntegration.findFirst({
		where: { ...where, provider: providerKey as unknown as ProviderEnum },
		orderBy: { lastUsedAt: "desc" },
	});
	if (!integration) {
		return undefined;
	}
	try {
		return JSON.parse(decryptApiKey(integration.credentials)) as Record<
			string,
			unknown
		>;
	} catch {
		return undefined;
	}
}

/**
 * Send an outbound message via a registered ChannelAdapter. Channel-agnostic
 * — the same activity handles Telegram today, Discord/Teams/etc. as adapters
 * land, and (Slice 5b) Slack once it migrates onto the abstraction.
 */
export async function postToChannel({
	channel,
	channelId,
	threadId,
	text,
	userId,
	organizationId,
	projectId,
}: {
	channel: string;
	channelId: string;
	threadId?: string;
	text: string;
	userId: string;
	organizationId?: string;
	/** The agent's bound project — enables the read-only reply gate below. */
	projectId?: string;
}): Promise<{
	success: boolean;
	messageId?: string;
	error?: string;
	skipped?: boolean;
}> {
	// Read-only mode reply gate — same strict contract as
	// postToSlack: a project-bound agent stays silent while its project is
	// read-only.
	if (projectId && (await isProjectReadOnly(projectId))) {
		console.info(
			"[TriggerSystem] Skipping channel reply — bound project is in Read-only mode",
			{ channel, channelId, projectId },
		);
		return { success: true, skipped: true };
	}

	const adapter = channelRegistry.get(channel);
	if (!adapter) {
		return {
			success: false,
			error: `No adapter registered for channel "${channel}"`,
		};
	}
	const credentials = await resolveChannelCredentials(
		userId,
		organizationId,
		adapter.providerKey,
	);
	if (!credentials) {
		return {
			success: false,
			error: `No active ${adapter.name} integration for tenant`,
		};
	}
	try {
		const result = await adapter.send(
			{ channelId, threadId, text },
			{
				credentials,
				tenantId: organizationId
					? `org:${organizationId}`
					: `user:${userId}`,
			},
		);
		// Stamp the channel thread mapping so a follow-up reply lands in the
		// same conversation. Idempotent on (channel, channelId, threadId).
		if (result.ok) {
			await db.channelThreadMapping
				.updateMany({
					where: { channel, channelId, threadId: threadId ?? "" },
					data: { lastMessageAt: new Date() },
				})
				.catch((err) => {
					console.warn(
						"[TriggerSystem] Failed to update channel mapping after send:",
						err,
					);
				});
		}
		return {
			success: result.ok,
			messageId: result.messageId,
			error: result.error,
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Resolve which AgentDeploymentTrigger should handle an inbound channel
 * message. Matches by `type = CHANNEL_MESSAGE` + `config.channel = <slug>`,
 * with optional `config.chatIdPattern` filtering on the incoming channelId.
 *
 * Returns the trigger plus a tenant context (the trigger owner) — anyone in
 * the bound channel effectively reaches the agent as the trigger owner,
 * matching the slack model.
 */
export async function matchTriggerForChannel({
	channel,
	channelId,
}: {
	channel: string;
	channelId: string;
}): Promise<{
	triggerId: string;
	deploymentId: string;
	userId: string | null;
	organizationId: string | null;
} | null> {
	const candidates = await db.agentDeploymentTrigger.findMany({
		where: {
			isActive: true,
			type: "CHANNEL_MESSAGE",
		},
		select: {
			id: true,
			deploymentId: true,
			userId: true,
			organizationId: true,
			config: true,
		},
	});

	const match = candidates.find((row) => {
		const cfg = (row.config as Record<string, unknown>) ?? {};
		if (cfg.channel !== channel) {
			return false;
		}
		const pattern = cfg.chatIdPattern;
		if (typeof pattern !== "string" || pattern.length === 0) {
			return true; // any chat
		}
		try {
			return new RegExp(pattern).test(channelId);
		} catch {
			return false;
		}
	});
	if (!match) {
		return null;
	}
	return {
		triggerId: match.id,
		deploymentId: match.deploymentId,
		userId: match.userId,
		organizationId: match.organizationId,
	};
}
