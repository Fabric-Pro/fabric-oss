/**
 * The A2A relay's steps, shared by `POST /api/agents/a2a/send` and the agent
 * runtime's `cuga-generalist` engine: find the ACTIVE SYSTEM agent and check
 * its endpoint and the caller's membership, resolve the model and issue the
 * AI token the agent exchanges for provider credentials, send the message,
 * and read the agent's reply.
 *
 * The A2A client comes from `@repo/agent-core/a2a`, never the package root:
 * the runtime route loads this module for every agent, and the root also
 * loads LangChain's model clients and the unified server.
 */

import {
	type A2AMessage,
	type A2ATask,
	type AIConfig,
	type Artifact,
	SecureA2AClient,
	type SecureTenantContext,
	type TaskStatus,
} from "@repo/agent-core/a2a";
import {
	buildEffectiveBaseUrl,
	getAIModelWithMetadata,
	getRAGProviderConfigForModel,
} from "@repo/ai";
import { issueAIToken } from "@repo/ai-token";
import {
	getActiveSystemRegisteredAgent,
	isOrganizationMember,
} from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import { agentEndpointRefusal } from "@repo/utils/agent-endpoint";

export type A2ARelayAdmission =
	| { ok: true; agentUrl: string }
	| { ok: false; reason: "agent-not-found"; status: 404; error: string }
	| { ok: false; reason: "endpoint-refused"; status: 400; error: string }
	| { ok: false; reason: "not-a-member"; status: 403; error: string };

/**
 * The SYSTEM agent the relay may send to, or why not: the agent lookup, the
 * endpoint guard, then membership when an organization is named.
 */
export async function admitA2ARelay({
	userId,
	agentId,
	organizationId,
}: {
	userId: string;
	agentId: string;
	organizationId: string | undefined;
}): Promise<A2ARelayAdmission> {
	// Only platform-admin registrations and operator seeds can create SYSTEM
	// agents (the registry create procedures enforce this). Ignore caller URLs:
	// the AI token is exchangeable for provider credentials. Keep service
	// authentication unset on this relay, as before.
	const agent = await getActiveSystemRegisteredAgent(agentId);
	if (!agent?.deploymentUrl) {
		return {
			ok: false,
			reason: "agent-not-found",
			status: 404,
			error: "Agent not found",
		};
	}
	const agentUrl = agent.deploymentUrl;
	// The relay requires an ACTIVE SYSTEM registration in every environment.
	// No safe fetch here: SYSTEM agents may sit on private hostnames.
	// Loopback and host.docker.internal are allowlisted by default only
	// outside production; otherwise endpoint-check exemptions require
	// AGENT_DISCOVERY_ALLOWED_HOSTS.
	const endpointRefusal = agentEndpointRefusal(agentUrl);
	if (endpointRefusal) {
		return {
			ok: false,
			reason: "endpoint-refused",
			status: 400,
			error: endpointRefusal,
		};
	}

	// The organization is caller-supplied too, and it is not decorative:
	// it selects the AI model and RAG config and is stamped into the AI
	// token the relay issues. Nothing downstream re-checks it.
	if (
		organizationId &&
		!(await isOrganizationMember(userId, organizationId))
	) {
		return {
			ok: false,
			reason: "not-a-member",
			status: 403,
			error: `Access denied: you are not a member of organization ${organizationId}`,
		};
	}

	return { ok: true, agentUrl };
}

export type A2ARelayAIConfig =
	| { ok: true; aiConfig: AIConfig | undefined }
	| { ok: false; limit: AiUsageLimitExceededError };

/**
 * The AI config the agent gets: the person's model and an AI token for it,
 * or none when it cannot be issued (the agent then uses its own defaults).
 * A HARD usage limit is returned for the caller to refuse the request.
 */
export async function resolveA2ARelayAIConfig({
	userId,
	organizationId,
	impersonated,
}: {
	userId: string;
	organizationId: string | undefined;
	impersonated: boolean;
}): Promise<A2ARelayAIConfig> {
	// Issue AI token for secure credential exchange
	let aiToken: string | undefined;
	let aiModel: string | undefined;
	let aiProvider: string | undefined;
	let aiBaseUrl: string | undefined;

	try {
		// Get AI model with metadata using centralized entry point
		// A person sent this message, so it may run on their ChatGPT plan
		// or one the organization shares.
		const { metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "TOOL_CALLING" },
			{ userId, organizationId, planEligible: true },
		);
		const onPlan = metadata.provider === "OPENAI_CHATGPT_PLAN";

		// Track usage (fire-and-forget)
		trackUsage();

		// Get raw provider config for base URL
		const providerConfig = await getRAGProviderConfigForModel(
			{ userId, organizationId },
			metadata,
		);

		aiToken = await issueAIToken({
			userId,
			organizationId,
			impersonated,
			source: "a2a-proxy",
			// The same decision as the resolution above, so the agent's key
			// exchange lands on the same plan, or on the member's own key
			// while the plans are spent; never while impersonating.
			planEligible: onPlan || Boolean(metadata.planSpentPersonalKey),
		});

		aiModel = metadata.modelString;
		aiProvider = metadata.provider;
		// A plan has no base URL; the organization's would point the agent
		// at the wrong provider.
		aiBaseUrl = onPlan
			? undefined
			: buildEffectiveBaseUrl(
					metadata.provider,
					providerConfig.baseUrl || undefined,
				) || undefined;

		console.log("[A2A Send] Issued AI token for user:", {
			userId,
			organizationId,
			aiProvider,
			aiModel,
		});
	} catch (error) {
		// AI usage-limit chokepoint hit a HARD limit.
		// The default `Continue without AI
		// config` branch silently masks the block and lets the
		// agent fall through with no token; surface the structured
		// payload directly so the caller renders the shared
		// destructive toast and stops the request.
		if (error instanceof AiUsageLimitExceededError) {
			return { ok: false, limit: error };
		}
		console.warn("[A2A Send] Failed to issue AI token:", error);
		// Continue without AI config - agent will use its own defaults
	}

	return {
		ok: true,
		aiConfig:
			aiToken && aiModel && aiProvider
				? {
						token: aiToken,
						model: aiModel,
						provider: aiProvider,
						baseUrl: aiBaseUrl,
					}
				: undefined,
	};
}

/**
 * Send the person's message, with the conversation so far in its metadata,
 * to the SYSTEM agent with the tenant context and AI config. Never a
 * trusted destination or a service credential. `signal` ends the request.
 */
export async function sendA2ARelayMessage({
	agentUrl,
	content,
	metadata,
	history,
	contextId,
	tenant,
	aiConfig,
	signal,
}: {
	agentUrl: string;
	content: string;
	metadata: Record<string, unknown> | undefined;
	history: Array<{ role: string; content: string }> | undefined;
	contextId: string | null | undefined;
	tenant: SecureTenantContext;
	aiConfig: AIConfig | undefined;
	signal?: AbortSignal;
}): Promise<A2ATask> {
	// Create secure A2A client
	const client = new SecureA2AClient({
		timeout: 120000, // 2 minutes for agent response
		sourceAgent: "fabric-web",
	});

	// Build the A2A message with proper structure (parts array required)
	const a2aMessage: A2AMessage = {
		role: "user",
		parts: [{ type: "text", text: content }],
		metadata: {
			...metadata,
			history: history || [],
		},
	};

	console.log("[A2A Send] Sending message to agent:", {
		agentUrl,
		contentLength: content.length,
		hasHistory: !!history?.length,
		contextId,
		hasAiToken: !!aiConfig?.token,
		userId: tenant.userId,
	});

	// Send message via secure A2A protocol with tenant context and AI config
	const task = await client.sendMessageSecure(agentUrl, a2aMessage, tenant, {
		contextId: contextId || undefined,
		metadata,
		aiConfig,
		...(signal ? { signal } : {}),
	});

	console.log("[A2A Send] Received task:", {
		taskId: task.id,
		status: task.status,
		hasArtifacts: !!task.artifacts?.length,
	});

	return task;
}

/** The relay's answer to the browser, read from the agent's task. */
export interface A2ATaskReply {
	response: string;
	contextId: string | null | undefined;
	taskId: string;
	status: TaskStatus;
	toolCalls: unknown;
	artifacts: Artifact[] | undefined;
	reasoning: string | undefined;
}

export function readA2ATaskReply(
	task: A2ATask,
	contextId: string | null | undefined,
): A2ATaskReply {
	// Extract response from task
	let responseContent = "";
	let toolCalls: unknown = [];
	let reasoning: string | undefined;

	// Check task messages for the agent response
	if (task.messages && task.messages.length > 0) {
		const lastMessage = task.messages[task.messages.length - 1];
		if (lastMessage.role === "agent" && lastMessage.parts) {
			// Extract text from parts
			for (const part of lastMessage.parts) {
				if (part.type === "text") {
					responseContent += part.text;
				}
				// Check for reasoning in data parts
				if (part.type === "data") {
					const data = part.data;
					if (data.reasoning && typeof data.reasoning === "string") {
						reasoning = data.reasoning;
					}
				}
			}
		}
	}

	// Also check task metadata for reasoning
	if (
		!reasoning &&
		task.metadata?.reasoning &&
		typeof task.metadata.reasoning === "string"
	) {
		reasoning = task.metadata.reasoning;
	}

	// Check artifacts for structured output
	if (task.artifacts && task.artifacts.length > 0) {
		for (const artifact of task.artifacts) {
			if (artifact.parts) {
				for (const part of artifact.parts) {
					if (part.type === "text") {
						// If we don't have response content yet, use the artifact text
						if (!responseContent) {
							responseContent = part.text;
						}
					}
					if (part.type === "data") {
						// Extract tool calls if present in data
						const data = part.data;
						if (data.toolCalls) {
							toolCalls = data.toolCalls;
						}
					}
				}
			}
		}
	}

	// Fallback: use task status message if no content
	if (!responseContent && task.status === "completed") {
		responseContent = "Task completed successfully.";
	}

	if (!responseContent && task.status === "failed") {
		// Check metadata for error info
		const errorInfo = task.metadata?.error as
			| { message?: string }
			| undefined;
		responseContent =
			errorInfo?.message || "Task failed with unknown error.";
	}

	return {
		response: responseContent,
		contextId: task.contextId || contextId,
		taskId: task.id,
		status: task.status,
		toolCalls,
		artifacts: task.artifacts,
		reasoning,
	};
}
