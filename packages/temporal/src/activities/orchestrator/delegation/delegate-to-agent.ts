/**
 * Agent Delegation Module
 *
 * Handles delegation of tasks to specialized agents via A2A protocol.
 * All agents MUST support A2A protocol for orchestrator communication.
 *
 * Security: Uses SecureA2AClient to pass signed tenant context to agents,
 * ensuring multi-tenant isolation and preventing unauthorized access.
 *
 * AI Config: For system agents, fetches the user's AI provider configuration
 * and passes it via headers so agents use the correct model/provider.
 */

import { A2AClient, type AIConfig, SecureA2AClient } from "@repo/agent-core";
import {
	DEFAULT_BASE_URLS,
	GATEWAY_PROVIDERS,
	getAIModelWithMetadata,
} from "@repo/ai";
import { issueAIToken } from "@repo/ai-token";
import { Context } from "@temporalio/activity";
import type {
	DelegateToAgentInput,
	DelegateToAgentOutput,
	ResolvedAgent,
} from "../types";
import {
	publishToolComplete,
	publishToolStart,
} from "../utils/partykit-publisher";
import { resolveAgentEndpoint } from "./resolve-endpoint";

// Regular A2A client for health checks (no auth needed for /.well-known/agent.json)
const a2aClient = new A2AClient({ timeout: 120000 });

// Secure A2A client for actual agent communication (includes tenant context)
const secureA2aClient = new SecureA2AClient({
	timeout: 120000,
	sourceAgent: "orchestrator",
});

/**
 * Delegates a task to an agent via A2A protocol.
 * All agents MUST support A2A protocol - this is the only way the orchestrator
 * communicates with agents, ensuring a unified protocol regardless of the
 * underlying agent implementation (LangGraph, Python, Go, etc.).
 */
/**
 * Head-room added to the token's life so it outlives the call that uses it
 * rather than expiring in the final seconds of a long run.
 */
const TOKEN_TTL_BUFFER_SECONDS = 120;

/** Used when the caller is not an activity, so no timeout can be read. */
const DEFAULT_DELEGATED_TOKEN_TTL_SECONDS = 900;

/** Ceiling, so an activity with a very long timeout still gets a bounded token. */
const MAX_DELEGATED_TOKEN_TTL_SECONDS = 2 * 60 * 60;

/**
 * Floor, equal to the issuer's own default. Without it a short activity would
 * come out with a token shorter than the one it had before this was derived at
 * all — a narrowing nobody asked for. The point here is to stop tokens dying
 * mid-run, so the derivation may only ever lengthen them.
 */
const MIN_DELEGATED_TOKEN_TTL_SECONDS = 300;

/**
 * How long the delegated agent's AI token should live.
 *
 * Tokens default to five minutes. A delegated run is a full agent turn and
 * routinely outlasts that, and every call the agent makes after expiry is
 * rejected — including the usage-logging POST, which is dropped outright with
 * no retry or dead-letter. The visible symptom is silently missing billing and
 * quota rows, always undercounting.
 *
 * Deriving the life from the calling activity's own `startToCloseTimeout`
 * keeps the token valid for exactly as long as the work it authorises can run,
 * without every call site having to remember a number.
 */
export function delegatedTokenTtlSeconds(): number {
	try {
		const timeoutMs = Context.current().info.startToCloseTimeoutMs;
		if (timeoutMs > 0) {
			const derived =
				Math.ceil(timeoutMs / 1000) + TOKEN_TTL_BUFFER_SECONDS;
			return Math.min(
				Math.max(derived, MIN_DELEGATED_TOKEN_TTL_SECONDS),
				MAX_DELEGATED_TOKEN_TTL_SECONDS,
			);
		}
	} catch {
		// Not running inside an activity (unit tests, direct invocation).
	}
	return DEFAULT_DELEGATED_TOKEN_TTL_SECONDS;
}

export async function delegateToAgent(
	input: DelegateToAgentInput,
): Promise<DelegateToAgentOutput> {
	const startTime = Date.now();
	console.log(`[Orchestrator] Delegating to agent: ${input.agentId}`);

	// Resolve agent endpoint
	const agent = await resolveAgentEndpoint(
		input.agentId,
		input.userId,
		input.organizationId,
	);

	if (!agent) {
		throw new Error(
			`Agent not found or no A2A endpoint configured: ${input.agentId}. All agents must expose A2A protocol endpoints.`,
		);
	}

	console.log(
		`[Orchestrator] Delegating to ${agent.name} via A2A at ${agent.deploymentUrl}`,
	);

	// Publish delegation start to PartyKit for instant UI feedback
	// This shows the user that delegation is happening, not just "thinking"
	if (input.executionId && input.stepId) {
		const delegationToolId = `delegate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		await publishToolStart(input.executionId, input.stepId, {
			id: delegationToolId,
			name: `delegate:${agent.name}`,
			serverName: agent.protocol,
			args: { message: input.message.substring(0, 100) },
		}).catch(() => {}); // Non-blocking
		console.log(
			`[Orchestrator] Published delegation start to PartyKit: delegate:${agent.name}`,
		);
	}

	// Preflight health check - fail fast if agent is not reachable
	const preflightStartTime = Date.now();
	let isHealthy = false;

	try {
		isHealthy = await a2aClient.healthCheck(agent.deploymentUrl);
	} catch (healthError) {
		console.warn(
			`[Orchestrator] Health check threw error for ${agent.name}:`,
			healthError,
		);
	}

	if (!isHealthy) {
		const preflightDuration = Date.now() - preflightStartTime;
		console.error(
			`[Orchestrator] Agent ${agent.name} failed health check at ${agent.deploymentUrl} (took ${preflightDuration}ms)`,
		);
		return {
			response: `A2A delegation to ${agent.name} failed: Agent not responding at ${agent.deploymentUrl}. Check if the agent service is running.`,
			artifacts: [],
			status: "failed",
			durationMs: Date.now() - startTime,
		};
	}

	console.log(
		`[Orchestrator] Health check passed for ${agent.name}, proceeding with delegation`,
	);

	Context.current().heartbeat({
		status: "starting_delegation",
		agentName: agent.name,
	});

	try {
		// All agents use A2A protocol - this is the unified communication standard
		const result = await delegateViaA2A(agent, input, startTime);

		// Publish delegation complete to PartyKit
		if (input.executionId && input.stepId) {
			await publishToolComplete(input.executionId, input.stepId, {
				id: `delegate_${agent.agentId || agent.name}`,
				name: `delegate:${agent.name}`,
				serverName: agent.protocol,
				result: {
					status: result.status,
					hasArtifacts: result.artifacts.length > 0,
				},
				status: result.status === "completed" ? "complete" : "error",
				durationMs: result.durationMs,
			}).catch(() => {}); // Non-blocking
		}

		return result;
	} catch (error) {
		console.error(
			`[Orchestrator] A2A delegation to ${agent.name} failed:`,
			error,
		);

		// Publish delegation failure to PartyKit
		if (input.executionId && input.stepId) {
			await publishToolComplete(input.executionId, input.stepId, {
				id: `delegate_${agent.agentId || agent.name}`,
				name: `delegate:${agent.name}`,
				serverName: agent.protocol,
				status: "error",
				error: error instanceof Error ? error.message : "Unknown error",
				durationMs: Date.now() - startTime,
			}).catch(() => {}); // Non-blocking
		}

		// Extract detailed error information
		const errorDetails =
			error instanceof Error ? error.message : "Unknown error";
		const isNetworkError =
			errorDetails.toLowerCase().includes("network") ||
			errorDetails.toLowerCase().includes("econnrefused") ||
			errorDetails.toLowerCase().includes("fetch failed");

		const suggestion = isNetworkError
			? " Check if the agent service is running and accessible."
			: "";

		return {
			response: `A2A delegation to ${agent.name} failed: ${errorDetails}${suggestion}`,
			artifacts: [],
			status: "failed",
			durationMs: Date.now() - startTime,
		};
	}
}

/**
 * Delegate via A2A protocol (Google's Agent-to-Agent protocol)
 *
 * Uses SecureA2AClient to pass signed tenant context, ensuring:
 * - Multi-tenant isolation (userId/organizationId propagated)
 * - Tamper protection (HMAC-signed context)
 * - Audit trail (request tracing)
 *
 * For system agents (isExternal=false), also passes AI config so they
 * use the user's configured AI provider instead of defaults.
 */
async function delegateViaA2A(
	agent: ResolvedAgent,
	input: DelegateToAgentInput,
	startTime: number,
): Promise<DelegateToAgentOutput> {
	const isCompleteTaskDelegation = input.delegationMode === "complete-task";
	const isSystemAgent = !agent.isExternal;

	console.log(
		`[Orchestrator] Using A2A protocol for ${agent.name} (mode: ${input.delegationMode || "single-step"}, isSystemAgent: ${isSystemAgent})`,
	);

	// For system agents, issue an AI token to pass along
	// External agents manage their own AI providers
	let aiConfig: AIConfig | undefined;
	if (isSystemAgent) {
		try {
			// Get AI model configuration using centralized entry point
			const { metadata, trackUsage } = await getAIModelWithMetadata(
				{ taskType: "COMPLEX" },
				{
					userId: input.userId,
					organizationId: input.organizationId,
				},
			);

			// Track usage (fire-and-forget)
			trackUsage();

			// Issue a short-lived token instead of passing raw API key
			// Agent will exchange this token for the actual API key
			const aiToken = await issueAIToken({
				userId: input.userId,
				organizationId: input.organizationId,
				source: `orchestrator->${agent.name}`,
				expirySeconds: delegatedTokenTtlSeconds(),
			});

			// Determine the correct base URL for the provider
			// Gateway providers use their gateway URLs, direct providers use their API URLs
			const provider = metadata.provider || "VERCEL_GATEWAY";
			const isGateway = GATEWAY_PROVIDERS.includes(
				provider as (typeof GATEWAY_PROVIDERS)[number],
			);

			// For gateways, use the gateway URL
			// For direct providers (Cerebras, Groq, etc.), use their API URL
			const baseUrl =
				DEFAULT_BASE_URLS[provider] ||
				(isGateway ? "https://ai-gateway.vercel.sh/v1" : undefined);

			aiConfig = {
				token: aiToken,
				model: metadata.modelString,
				provider,
				baseUrl,
			};

			console.log(
				`[Orchestrator] Passing AI token to system agent ${agent.name}:`,
				{
					provider: aiConfig.provider,
					model: aiConfig.model,
					baseUrl: aiConfig.baseUrl,
					hasToken: !!aiConfig.token,
				},
			);
		} catch (error) {
			console.warn(
				"[Orchestrator] Failed to issue AI token for system agent:",
				error,
			);
			// Continue without AI config - agent will use defaults or fail gracefully
		}
	}

	// Build delegation context for generalist agents
	const delegationContext: Record<string, unknown> = {
		...input.context,
		delegationMode: input.delegationMode || "single-step",
		preserveContext: input.preserveContext || false,
		// Forward project scope to agent so it can attribute AI usage back to the project
		...(input.projectId ? { project_id: input.projectId } : {}),
	};

	// For complete-task delegation, include additional context
	if (isCompleteTaskDelegation) {
		delegationContext.originalTaskDescription =
			input.originalTaskDescription || input.message;
		delegationContext.inheritedVariables = input.inheritedVariables || {};
		delegationContext.expectedArtifacts = input.expectedArtifacts || [
			"code",
			"subtasks",
			"variables",
		];

		// Include workspace for full context preservation
		if (input.inheritedWorkspace) {
			delegationContext.workspace = input.inheritedWorkspace;
			console.log(
				`[Orchestrator] Passing workspace to agent: ${input.inheritedWorkspace.files?.length || 0} files, ${input.inheritedWorkspace.codeExecutions?.length || 0} code executions`,
			);
		}

		console.log(
			"[Orchestrator] Complete-task delegation - agent will handle decomposition internally",
		);
	}

	// Include conversation history for context in follow-up questions
	if (input.conversationHistory && input.conversationHistory.length > 0) {
		delegationContext.history = input.conversationHistory;
		console.log(
			`[Orchestrator] Passing ${input.conversationHistory.length} messages of conversation history to agent`,
		);
	}

	// Tenant context for secure communication
	const tenantContext = {
		userId: input.userId,
		organizationId: input.organizationId ?? null,
		// Scopes could be passed from the original request if needed
	};

	console.log(
		`[Orchestrator] Sending secure request with tenant context: userId=${input.userId}, orgId=${input.organizationId || "none"}`,
	);

	// Send message via secure A2A with tenant context and AI config (for system agents)
	// Heartbeat while waiting so Temporal doesn't time out long-running agent calls
	const sendHeartbeat = setInterval(() => {
		Context.current().heartbeat({
			status: "delegating_to_agent",
			agentName: agent.name,
			elapsedMs: Date.now() - startTime,
		});
	}, 15000);

	let task: Awaited<ReturnType<typeof secureA2aClient.sendMessageSecure>>;
	try {
		task = await secureA2aClient.sendMessageSecure(
			agent.deploymentUrl,
			{
				role: "user",
				parts: [{ type: "text", text: input.message }],
				metadata: delegationContext,
			},
			tenantContext,
			{
				metadata: {
					orchestratorContext: delegationContext,
					delegationMode: input.delegationMode || "single-step",
					isCompleteTaskDelegation,
					history: input.conversationHistory || [],
				},
				// Pass AI config only to system agents
				aiConfig: isSystemAgent ? aiConfig : undefined,
			},
		);
	} finally {
		clearInterval(sendHeartbeat);
	}

	// If task is not immediately complete, wait for it
	if (task.status !== "completed" && task.status !== "failed") {
		const waitStartTime = Date.now();
		const heartbeatInterval = setInterval(() => {
			Context.current().heartbeat({
				status: "waiting_for_agent",
				agentName: agent.name,
				elapsedMs: Date.now() - waitStartTime,
			});
		}, 10000);

		let completedTask: Awaited<
			ReturnType<typeof a2aClient.waitForCompletion>
		>;
		try {
			completedTask = await a2aClient.waitForCompletion(
				agent.deploymentUrl,
				task.id,
				{ timeout: input.timeout || 120000 },
			);
		} finally {
			clearInterval(heartbeatInterval);
		}

		return formatA2AResponse(completedTask, startTime);
	}

	return formatA2AResponse(task, startTime);
}

/**
 * Format A2A task response
 */
function formatA2AResponse(
	task: {
		id: string;
		status: string;
		messages: Array<{
			role: string;
			parts: Array<{ type: string; text?: string; data?: unknown }>;
		}>;
		artifacts?: Array<{
			id: string;
			name: string;
			mimeType: string;
			parts: Array<{ type: string; text?: string; data?: unknown }>;
		}>;
	},
	startTime: number,
): DelegateToAgentOutput {
	// Extract response from agent messages
	const agentMessages = task.messages.filter((m) => m.role === "agent");
	const lastAgentMessage = agentMessages[agentMessages.length - 1];

	let response = "";
	if (lastAgentMessage) {
		for (const part of lastAgentMessage.parts) {
			if (part.type === "text" && part.text) {
				response += part.text;
			}
		}
	}

	// Extract artifacts
	const artifacts = (task.artifacts || []).map((a) => ({
		id: a.id,
		name: a.name,
		mimeType: a.mimeType,
		content:
			a.parts.find((p) => p.type === "text")?.text ||
			a.parts.find((p) => p.type === "data")?.data,
	}));

	return {
		response,
		artifacts,
		status:
			task.status === "completed"
				? "completed"
				: task.status === "failed"
					? "failed"
					: "input-required",
		taskId: task.id,
		durationMs: Date.now() - startTime,
	};
}
