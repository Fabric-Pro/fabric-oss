/**
 * Unified Agent Server
 *
 * A single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 * This eliminates the need for separate services per protocol, reducing infrastructure overhead.
 *
 * Protocol Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 *
 * Both protocols invoke the same underlying LangGraph agent.
 */

import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { type A2AAgentExecutor, A2AServer } from "./a2a/server";
import type { AgentSkill, Artifact } from "./a2a/types";
import {
	createAuthMiddleware,
	isAuthEnabled,
	loadAuthConfigFromEnv,
} from "./middleware/auth";
import {
	createRateLimitMiddleware,
	loadRateLimitConfigFromEnv,
} from "./middleware/rate-limit";
import {
	type AICredentials,
	extractAIToken,
	getAICredentialsFromHeaders,
} from "./services/token-exchange";

// Note: @repo/observability is imported dynamically in start() to avoid
// bundling OpenTelemetry packages in environments that don't support them (e.g., Turbopack)

/**
 * Safely extract string content from a message content field.
 * Handles both string content and Anthropic-style content block arrays.
 *
 * @param content - The content field which may be string, array, or undefined
 * @returns The extracted string content, or empty string if not extractable
 */
type KeyBag = Record<string, unknown> | null | undefined;

// Pick the first string value stored under any of `keys` across `sources`,
// checked in order. Used to resolve identifiers (project_id, tenant_*) that
// A2A callers may pass in snake_case or camelCase, in configurable/context/properties/body/input.
function pickFirstString(
	sources: KeyBag[],
	keys: string[],
): string | undefined {
	for (const src of sources) {
		if (!src) {
			continue;
		}
		for (const key of keys) {
			const v = src[key];
			if (typeof v === "string" && v.length > 0) {
				return v;
			}
		}
	}
	return undefined;
}

function extractStringContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		// Anthropic content blocks: [{type: "text", text: "..."}, ...]
		return content
			.map((block: unknown) => {
				if (typeof block === "string") {
					return block;
				}
				if (block && typeof block === "object" && "text" in block) {
					return (block as { text: string }).text || "";
				}
				return "";
			})
			.join("");
	}
	return "";
}

/**
 * What the assistant emits when a run ends with no text and no tool calls — the
 * model returned an empty turn. It is a UI message, not something the model
 * said, so it must never be fed back as conversation history.
 *
 * Kept as one exported constant because it is now read in two places (emitted
 * below, stripped by `stripEmptyResponseFallbacks`), and two copies of a string
 * that have to stay equal is how the pairing silently breaks.
 */
export const EMPTY_RESPONSE_FALLBACK =
	"I wasn't able to generate a response. Please try again.";

/**
 * Drop the assistant's own empty-response notices from an incoming thread.
 *
 * The client persists whatever the assistant emitted, so the notice came back as
 * a normal assistant turn on the next request and was replayed to the model as
 * though the assistant had genuinely said it. Each failed attempt therefore made
 * the next one likelier to fail too, which is why retrying produced the same
 * empty answer rather than a fresh one. Stripping on the way IN rather than
 * refusing to emit keeps the notice visible in the UI — the user should see that
 * the turn failed — while starting every retry from a clean history, and it also
 * repairs threads that were already polluted before this shipped.
 *
 * Exported as a pure top-level function so unit tests can exercise it without
 * spinning up the full Hono app, matching `sanitizeStateForCopilotKit` below.
 */
export function stripEmptyResponseFallbacks(messages: unknown[]): unknown[] {
	return messages.filter((msg) => {
		if (!msg || typeof msg !== "object") {
			return true;
		}
		const m = msg as Record<string, unknown>;
		// Only ever drop an assistant turn. A user who types the same sentence
		// is asking a real question and must not be silently discarded.
		if (m.role === "user" || m.type === "human") {
			return true;
		}
		// Never drop a turn that made tool calls: the tool results that follow
		// reference it, and providers reject a tool result whose calling turn is
		// missing. The notice is only ever emitted on the no-tool-call path, so
		// this costs nothing in practice and rules out turning one empty answer
		// into a hard 400 — which would present as the same silent failure.
		if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
			return true;
		}
		return (
			extractStringContent(m.content).trim() !== EMPTY_RESPONSE_FALLBACK
		);
	});
}

/**
 * Sanitize state for CopilotKit by converting LangChain messages to simple format.
 * CopilotKit doesn't understand LangChain's serialized message format (lc, type, constructor).
 *
 * IMPORTANT: This function does a shallow copy of `state` and only transforms the
 * `messages` array. All other top-level fields (document, reasoningByTurn,
 * projectId, organizationId, etc.) MUST pass through untouched so that
 * AG-UI STATE_SNAPSHOT events keep custom agent state visible to useCoAgent.
 *
 * Preserves tool_calls on AI messages for CopilotKit action rendering.
 * CopilotKit uses tool_calls to trigger renderAndWaitForResponse actions like
 * confirm_changes.
 *
 * Exported as a pure top-level function so unit tests can exercise the
 * passthrough guarantee without spinning up the full Hono app.
 */
export function sanitizeStateForCopilotKit(
	state: Record<string, unknown>,
): Record<string, unknown> {
	// Create a shallow copy that preserves all fields
	const sanitized = { ...state };

	// Convert LangChain messages to LangGraph format with 'type' property
	// CopilotKit's @ag-ui/langgraph expects: {type: 'human' | 'ai' | 'system' | 'tool', content, id}
	// LangChain messages are class instances that serialize to {lc, type, id, kwargs} format
	if (Array.isArray(sanitized.messages)) {
		sanitized.messages = sanitized.messages
			.map((msg: unknown, index: number) => {
				if (!msg || typeof msg !== "object") {
					return null;
				}

				const msgObj = msg as Record<string, unknown>;
				let content = "";
				let type = "ai"; // Default to AI message
				let id = (msgObj.id as string) || `msg_${index}`;
				let toolCallId: string | undefined;
				let toolCalls: unknown | undefined;

				// Already in LangGraph format with 'type' property
				if (
					"type" in msgObj &&
					typeof msgObj.type === "string" &&
					["human", "ai", "system", "tool"].includes(msgObj.type)
				) {
					return msgObj; // Already correct format
				}

				// Simple format with 'role' property - convert role to type
				if (
					"role" in msgObj &&
					"content" in msgObj &&
					!("additional_kwargs" in msgObj) &&
					!("lc" in msgObj)
				) {
					const role = msgObj.role as string;
					content = extractStringContent(msgObj.content);
					if (role === "user") {
						type = "human";
					} else if (role === "assistant") {
						type = "ai";
					} else if (role === "system") {
						type = "system";
					} else if (role === "tool") {
						type = "tool";
						toolCallId =
							(msgObj.tool_call_id as string) ||
							(msgObj.toolCallId as string);
					} else if (role === "function") {
						return null; // Skip function messages
					}

					// IMPORTANT: Preserve tool_calls for CopilotKit action rendering
					// CopilotKit needs tool_calls to trigger renderAndWaitForResponse actions
					if (msgObj.tool_calls && Array.isArray(msgObj.tool_calls)) {
						toolCalls = msgObj.tool_calls;
					}

					const result: Record<string, unknown> = {
						type,
						content,
						id,
					};
					if (toolCallId) {
						result.tool_call_id = toolCallId;
					}
					if (toolCalls) {
						result.tool_calls = toolCalls;
					}
					return result;
				}

				// Handle serialized LangChain format (after JSON.stringify)
				if ("lc" in msgObj && "kwargs" in msgObj) {
					const kwargs = msgObj.kwargs as Record<string, unknown>;
					content = extractStringContent(kwargs?.content);
					id = (kwargs?.id as string) || id;
					const msgType =
						(msgObj.id as string[])?.[2]?.toLowerCase() || "ai";
					if (msgType.includes("human")) {
						type = "human";
					} else if (msgType.includes("system")) {
						type = "system";
					} else if (msgType.includes("tool")) {
						type = "tool";
						toolCallId = kwargs?.tool_call_id as string;
					} else {
						type = "ai";
					}

					// Preserve tool_calls from kwargs
					if (
						kwargs?.tool_calls &&
						Array.isArray(kwargs.tool_calls)
					) {
						toolCalls = kwargs.tool_calls;
					}

					const result: Record<string, unknown> = {
						type,
						content,
						id,
					};
					if (toolCallId) {
						result.tool_call_id = toolCallId;
					}
					if (toolCalls) {
						result.tool_calls = toolCalls;
					}
					return result;
				}

				// Handle LangChain message class instance
				if ("content" in msgObj) {
					content = extractStringContent(msgObj.content);
					// Detect type from class constructor name
					const ctor = (msg as object).constructor;
					const className = ctor?.name?.toLowerCase() || "";
					if (className.includes("human")) {
						type = "human";
					} else if (className.includes("system")) {
						type = "system";
					} else if (className.includes("tool")) {
						type = "tool";
						toolCallId = msgObj.tool_call_id as string;
					} else {
						type = "ai";
					}

					// Preserve tool_calls from message object
					if (msgObj.tool_calls && Array.isArray(msgObj.tool_calls)) {
						toolCalls = msgObj.tool_calls;
					}

					const result: Record<string, unknown> = {
						type,
						content,
						id,
					};
					if (toolCallId) {
						result.tool_call_id = toolCallId;
					}
					if (toolCalls) {
						result.tool_calls = toolCalls;
					}
					return result;
				}

				return null;
			})
			.filter((msg): msg is Record<string, unknown> => msg !== null);
	}

	return sanitized;
}

/**
 * Configuration for the unified server
 */
export interface UnifiedServerConfig {
	/** Agent name/identifier */
	name: string;
	/** Human-readable description */
	description: string;
	/** Base URL for the server */
	baseUrl: string;
	/** Port to listen on */
	port: number;
	/** Host to bind to (default: 0.0.0.0) */
	host?: string;
	/** Agent skills for A2A discovery */
	skills: AgentSkill[];
	/** Tags for categorization */
	tags?: string[];
	/** Whether streaming is supported */
	supportsStreaming?: boolean;
	/** A2A protocol version (default: 0.3) */
	protocolVersion?: string;

	// =============================================================================
	// Generalist Agent Capabilities
	// =============================================================================

	/**
	 * Whether this agent can handle complete tasks autonomously.
	 * When true, the orchestrator should delegate entire tasks rather than steps.
	 */
	autonomousExecution?: boolean;

	/**
	 * Whether this agent has internal task decomposition and planning.
	 */
	taskDecomposition?: boolean;

	/**
	 * Whether this agent preserves context across subtasks/steps.
	 */
	contextPreservation?: boolean;

	/**
	 * Whether this agent can execute code (Python, JavaScript, etc.)
	 */
	codeExecution?: boolean;

	/**
	 * Whether this agent can automate browser interactions.
	 */
	browserAutomation?: boolean;

	/**
	 * Whether this agent has persistent memory for learning.
	 */
	memoryEnabled?: boolean;

	/**
	 * Whether this agent is aware of Fabric's multi-tenancy.
	 */
	multiTenancyAware?: boolean;

	/**
	 * Maximum autonomy level this agent supports.
	 * - 'step': Only handles single steps
	 * - 'subtask': Can handle subtasks with multiple steps
	 * - 'task': Can handle complete tasks autonomously
	 * - 'session': Can maintain context across multiple tasks
	 */
	maxAutonomyLevel?: "step" | "subtask" | "task" | "session";
}

/**
 * LangGraph executor function type
 */
export type LangGraphExecutor = (input: {
	messages: Array<{ role: string; content: string }>;
	[key: string]: unknown;
}) => Promise<{
	messages?: Array<{ role: string; content: string }>;
	[key: string]: unknown;
}>;

/**
 * LangGraph streaming executor function type (for A2A protocol)
 */
export type LangGraphStreamExecutor = (input: {
	messages: Array<{ role: string; content: string }>;
	[key: string]: unknown;
}) => AsyncGenerator<{
	type: string;
	content?: string;
	[key: string]: unknown;
}>;

/**
 * LangGraph Platform API streaming event
 * Used for CopilotKit's useCoAgent which expects updates events with node names
 */
export interface LangGraphStreamEvent {
	/** The node that produced this update */
	nodeName: string;
	/** State updates from this node */
	state: Record<string, unknown>;
	/** Whether this is the final update from this node */
	isFinal?: boolean;
	/**
	 * Marks a preview-only event that a later event of the same kind fully
	 * supersedes (e.g. per-token predictive-state previews of a tool call
	 * still being streamed). The server may coalesce/drop a droppable event
	 * under backpressure since the next one — or the authoritative final
	 * "updates" event — makes it obsolete. Regular node-update events are
	 * NOT droppable: they are deltas, not cumulative snapshots, and dropping
	 * one can permanently lose state (e.g. a reasoning/message update).
	 */
	droppable?: boolean;
}

/**
 * Runtime config for LangGraph agents
 * Contains AI provider configuration from CopilotKit
 */
export interface AgentRuntimeConfig {
	configurable?: {
		ai_api_key?: string;
		ai_model?: string;
		ai_gateway_url?: string;
		ai_provider?: string;
		ai_deployment_name?: string;
		/**
		 * Whether the resolved model emits `<think>` reasoning tags (DeepSeek-R1),
		 * derived from the CANONICAL identity upstream. Gates Databricks `<think>`
		 * stripping when the serving alias is opaque (Bug #1942 review).
		 */
		ai_is_reasoning?: boolean;
		[key: string]: unknown;
	};
}

/**
 * Coerce a reasoning flag that may arrive as a boolean (CopilotKit props) or a
 * string ("true"/"false" from the `X-AI-Is-Reasoning` header) to a boolean, or
 * `undefined` when unset/unrecognized (Bug #1942 review).
 */
function coerceReasoningFlag(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value;
	}
	if (value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	return undefined;
}

/**
 * LangGraph Platform API streaming executor
 * Yields state updates with node names for CopilotKit compatibility
 */
export type LangGraphPlatformStreamExecutor = (
	input: {
		messages: Array<{ role: string; content: string }>;
		[key: string]: unknown;
	},
	config?: AgentRuntimeConfig,
) => AsyncGenerator<LangGraphStreamEvent>;

/**
 * Output transform result type
 */
export interface TransformResult {
	response: string;
	artifacts?: Artifact[];
	metadata?: Record<string, unknown>;
}

/**
 * Coalesces droppable stream events when the consumer isn't draining.
 * Snapshot-style events are cumulative — each supersedes the previous — so
 * while desiredSize <= 0 we hold only the LATEST pending event instead of
 * enqueueing unboundedly, and flush it once the consumer drains (or at
 * stream end). Bounds memory when the client is slow or dead — otherwise a
 * dead client leaves interim events (per-token predictive state, in
 * particular) piling up in the ReadableStream's internal queue with no
 * upper bound, causing the GC pressure / event-loop stalls that trip the
 * /health probe and force a container restart.
 */
export class CoalescingEventGate<T> {
	private pending: T | null = null;
	private droppedCount = 0;
	private droppingLogged = false;

	constructor(
		private readonly logger?: {
			warn: (msg: string, meta?: Record<string, unknown>) => void;
		},
	) {}

	/** Returns events to emit now (0, 1, or 2: pending flush + current). */
	offer(event: T, desiredSize: number | null): T[] {
		if (desiredSize === null || desiredSize > 0) {
			const toEmit: T[] = [];
			if (this.pending !== null) {
				toEmit.push(this.pending);
				this.pending = null;
				// The consumer caught up — this coalescing episode is over.
				// Reset so a LATER episode logs its own begin-warning instead
				// of being silently swallowed by droppingLogged still being
				// true from this one.
				this.endEpisode();
			}
			toEmit.push(event);
			return toEmit;
		}

		if (this.pending !== null) {
			this.droppedCount++;
			if (!this.droppingLogged) {
				this.droppingLogged = true;
				this.logger?.warn(
					"CoalescingEventGate: consumer not draining, coalescing events",
				);
			}
		}
		this.pending = event;
		return [];
	}

	/** Returns the pending event to flush at stream end, if any. */
	flush(): T | null {
		const event = this.pending;
		this.pending = null;
		// Only log — and only reset — when this call actually flushed
		// something or closes out an episode that dropped events. A repeat
		// flush() with nothing pending and nothing dropped (e.g. the barrier
		// helper calling flush() ahead of every one of several events in a
		// row) is a no-op and must stay silent.
		if (event !== null || this.droppedCount > 0) {
			if (this.droppedCount > 0) {
				this.logger?.warn(
					"CoalescingEventGate: flushed after dropping events",
					{
						droppedCount: this.droppedCount,
					},
				);
			}
			this.endEpisode();
		}
		return event;
	}

	private endEpisode() {
		this.droppedCount = 0;
		this.droppingLogged = false;
	}
}

/**
 * Create a unified server that handles both AG-UI and A2A protocols
 *
 * @param config Server configuration
 * @param invokeAgent Function to invoke the LangGraph agent
 * @param transformOutput Function to transform agent output for A2A response
 * @param streamAgent Optional function to stream from the LangGraph agent (A2A protocol)
 * @param platformStreamAgent Optional function to stream with LangGraph Platform API format (CopilotKit)
 * @returns Hono app instance
 */
export function createUnifiedServer(
	config: UnifiedServerConfig,
	invokeAgent: LangGraphExecutor,
	transformOutput: (output: Record<string, unknown>) => TransformResult,
	streamAgent?: LangGraphStreamExecutor,
	platformStreamAgent?: LangGraphPlatformStreamExecutor,
): { app: Hono; start: () => void } {
	const app = new Hono();

	// Load security configuration from environment
	const authConfig = loadAuthConfigFromEnv();
	const rateLimitConfig = loadRateLimitConfigFromEnv();

	// Enable CORS — fail closed in production (SOC 2 CC7.1). This server is
	// called server-to-server via X-Agent-Key (no browser Origin), so an empty
	// allow-list in prod doesn't affect real traffic; it just stops advertising
	// a wildcard CORS surface. Set CORS_ALLOWED_ORIGINS to allow browser origins;
	// dev defaults to "*" for convenience.
	const corsEnv = process.env.CORS_ALLOWED_ORIGINS;
	const allowedOrigins = corsEnv
		? corsEnv
				.split(",")
				.map((o) => o.trim())
				.filter(Boolean)
		: process.env.NODE_ENV === "production"
			? []
			: ["*"];
	app.use(
		"*",
		cors({
			origin: allowedOrigins,
			allowMethods: ["GET", "POST", "OPTIONS"],
			allowHeaders: [
				"Content-Type",
				"Authorization",
				"X-Agent-Key",
				"X-AI-Token",
				"X-AI-Provider",
				"X-AI-Model",
				"X-AI-Base-URL",
				"X-AI-Deployment-Name",
				"X-AI-Is-Reasoning",
				"X-Tenant-User-ID",
				"X-Tenant-Organization-ID",
				"X-Service-Token",
				"X-Tenant-Payload",
				"X-Tenant-Signature",
				"X-Tenant-Timestamp",
				"X-Source-Agent",
				"X-Request-ID",
			],
		}),
	);

	// Apply rate limiting
	app.use("*", createRateLimitMiddleware(rateLimitConfig));

	// Auth is mandatory in production — tenant isolation depends entirely on
	// the signed headers the middleware validates.
	if (isAuthEnabled(authConfig)) {
		console.log(`[UnifiedServer:${config.name}] Authentication enabled`);
		app.use("*", createAuthMiddleware(authConfig));
	} else if (process.env.NODE_ENV === "production") {
		throw new Error(
			`[UnifiedServer:${config.name}] Refusing to start without authentication in production. ` +
				"Set AGENT_API_KEY or AGENT_HMAC_SECRET environment variables.",
		);
	} else {
		console.warn(
			`[UnifiedServer:${config.name}] ⚠️  No authentication configured (dev mode). ` +
				"Production builds refuse to start without AGENT_API_KEY or AGENT_HMAC_SECRET.",
		);
	}

	// Create A2A executor that wraps the LangGraph agent
	const a2aExecutor: A2AAgentExecutor = {
		async execute(message, contextId, metadata) {
			// Extract text from A2A message
			const textPart = message.parts.find((p) => p.type === "text");
			const userMessage =
				textPart && "text" in textPart ? textPart.text : "";

			// Build messages array for LangGraph
			const messages = [{ role: "user" as const, content: userMessage }];

			// Invoke the agent
			const result = await invokeAgent({
				messages,
				contextId,
				...metadata,
			});

			// Transform output for A2A
			return transformOutput(result);
		},

		async *executeStream(message, contextId, metadata) {
			if (!streamAgent) {
				// Fall back to non-streaming
				const result = await this.execute(message, contextId, metadata);
				yield { type: "text", text: result.response };
				return;
			}

			const textPart = message.parts.find((p) => p.type === "text");
			const userMessage =
				textPart && "text" in textPart ? textPart.text : "";
			const messages = [{ role: "user" as const, content: userMessage }];

			const stream = streamAgent({
				messages,
				contextId,
				...metadata,
			});

			for await (const chunk of stream) {
				if (chunk.type === "text" && chunk.content) {
					yield { type: "text", text: chunk.content };
				}
			}
		},
	};

	// Create A2A server
	const a2aServer = new A2AServer(
		{
			name: config.name,
			description: config.description,
			url: config.baseUrl,
			skills: config.skills,
			protocolVersion: config.protocolVersion || "0.3.0",
			supportsStreaming: config.supportsStreaming ?? false,
			tags: config.tags,
			port: config.port,
			// Pass generalist agent capabilities
			autonomousExecution: config.autonomousExecution,
			taskDecomposition: config.taskDecomposition,
			contextPreservation: config.contextPreservation,
			codeExecution: config.codeExecution,
			browserAutomation: config.browserAutomation,
			memoryEnabled: config.memoryEnabled,
			multiTenancyAware: config.multiTenancyAware,
			maxAutonomyLevel: config.maxAutonomyLevel,
		},
		a2aExecutor,
	);

	const handlers = a2aServer.createHandlers();

	// ============================================
	// LangGraph Platform API Endpoints (for CopilotKit LangGraphAgent)
	// These endpoints are what @langgraph/sdk Client expects
	// ============================================

	// Assistant ID for this agent (used by LangGraph SDK)
	const assistantId = config.name;

	// POST /assistants/search - Search for assistants (returns this agent)
	app.post("/assistants/search", async (c: Context) => {
		console.log(
			`[UnifiedServer:${config.name}] LangGraph /assistants/search`,
		);
		return c.json([
			{
				assistant_id: assistantId,
				graph_id: config.name,
				name: config.name,
				config: {
					configurable: {},
				},
				metadata: {
					description: config.description,
					tags: config.tags || [],
				},
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
			},
		]);
	});

	// GET /assistants/:assistantId - Get assistant details
	app.get("/assistants/:assistantId", async (c: Context) => {
		const reqAssistantId = c.req.param("assistantId");
		console.log(
			`[UnifiedServer:${config.name}] LangGraph /assistants/${reqAssistantId}`,
		);
		return c.json({
			assistant_id: reqAssistantId,
			graph_id: config.name,
			name: config.name,
			config: {
				configurable: {},
			},
			metadata: {
				description: config.description,
				tags: config.tags || [],
			},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
	});

	// GET /assistants/:assistantId/graph - Get graph structure
	app.get("/assistants/:assistantId/graph", async (c: Context) => {
		const reqAssistantId = c.req.param("assistantId");
		console.log(
			`[UnifiedServer:${config.name}] LangGraph /assistants/${reqAssistantId}/graph`,
		);
		// Return a minimal graph structure
		return c.json({
			nodes: [
				{ id: "__start__", type: "start" },
				{ id: "agent", type: "agent" },
				{ id: "__end__", type: "end" },
			],
			edges: [
				{ source: "__start__", target: "agent" },
				{ source: "agent", target: "__end__" },
			],
		});
	});

	// GET /assistants/:assistantId/schemas - Get input/output schemas
	app.get("/assistants/:assistantId/schemas", async (c: Context) => {
		const reqAssistantId = c.req.param("assistantId");
		console.log(
			`[UnifiedServer:${config.name}] LangGraph /assistants/${reqAssistantId}/schemas`,
		);
		// Return schema information
		// Return comprehensive schema for CopilotKit to properly propagate state
		// The output_schema keys determine which state fields are included in STATE_SNAPSHOT events
		return c.json({
			graph_id: config.name,
			input_schema: {
				type: "object",
				properties: {
					messages: {
						type: "array",
						items: {
							type: "object",
							properties: {
								role: { type: "string" },
								content: { type: "string" },
							},
						},
					},
					currentContent: { type: "string" },
					promptId: { type: "string" },
					promptName: { type: "string" },
					enhancementType: { type: "string" },
					documentType: { type: "string" },
				},
			},
			output_schema: {
				type: "object",
				properties: {
					messages: { type: "array" },
					// Prompt enhancer fields
					enhancedContent: { type: "string" },
					streamingContent: { type: "string" },
					focusAnchor: { type: "string" },
					explanation: { type: "string" },
					// Document generator fields
					document: { type: "string" },
					// PO follow-up to F-1171: reasoning trace per user turn,
					// keyed by turnIndex (count of human messages preceding the
					// assistant message). See
					// docs/superpowers/specs/2026-05-15-ai-assistant-reasoning-trace-design.md
					reasoningByTurn: {
						type: "object",
						additionalProperties: {
							type: "object",
							properties: {
								text: { type: "string" },
								durationMs: { type: "number" },
								startedAt: { type: "number" },
								completedAt: { type: "number" },
							},
						},
					},
					// Follow-up to F-1171: per-turn tool-call trace, keyed by
					// the same turnIndex as reasoningByTurn. Each turn holds an
					// ordered array of pending/success/error entries surfaced
					// inline in the AI Assistant collapsible.
					toolCallsByTurn: {
						type: "object",
						additionalProperties: {
							type: "array",
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									name: { type: "string" },
									status: { type: "string" },
									startedAt: { type: "number" },
									durationMs: { type: "number" },
									errorMessage: { type: "string" },
								},
							},
						},
					},
				},
			},
			config_schema: {
				type: "object",
				properties: {},
			},
			state_schema: {
				type: "object",
				properties: {
					messages: { type: "array" },
					enhancedContent: { type: "string" },
					streamingContent: { type: "string" },
					focusAnchor: { type: "string" },
					document: { type: "string" },
					// PO follow-up to F-1171: reasoning trace per user turn,
					// keyed by turnIndex (count of human messages preceding the
					// assistant message). See
					// docs/superpowers/specs/2026-05-15-ai-assistant-reasoning-trace-design.md
					reasoningByTurn: {
						type: "object",
						additionalProperties: {
							type: "object",
							properties: {
								text: { type: "string" },
								durationMs: { type: "number" },
								startedAt: { type: "number" },
								completedAt: { type: "number" },
							},
						},
					},
					// Follow-up to F-1171: per-turn tool-call trace, keyed by
					// the same turnIndex as reasoningByTurn. Each turn holds an
					// ordered array of pending/success/error entries surfaced
					// inline in the AI Assistant collapsible.
					toolCallsByTurn: {
						type: "object",
						additionalProperties: {
							type: "array",
							items: {
								type: "object",
								properties: {
									id: { type: "string" },
									name: { type: "string" },
									status: { type: "string" },
									startedAt: { type: "number" },
									durationMs: { type: "number" },
									errorMessage: { type: "string" },
								},
							},
						},
					},
				},
			},
		});
	});

	// PUT /assistants/:assistantId - Update assistant (no-op, but needed by SDK)
	app.put("/assistants/:assistantId", async (c: Context) => {
		const reqAssistantId = c.req.param("assistantId");
		console.log(
			`[UnifiedServer:${config.name}] LangGraph PUT /assistants/${reqAssistantId}`,
		);
		return c.json({
			assistant_id: reqAssistantId,
			graph_id: config.name,
			name: config.name,
			config: {
				configurable: {},
			},
			metadata: {
				description: config.description,
			},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
	});

	// PATCH /assistants/:assistantId - Patch assistant (no-op, but needed by SDK)
	app.patch("/assistants/:assistantId", async (c: Context) => {
		const reqAssistantId = c.req.param("assistantId");
		console.log(
			`[UnifiedServer:${config.name}] LangGraph PATCH /assistants/${reqAssistantId}`,
		);
		return c.json({
			assistant_id: reqAssistantId,
			graph_id: config.name,
			name: config.name,
			config: {
				configurable: {},
			},
			metadata: {
				description: config.description,
			},
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
	});

	// ============================================
	// Thread Management Endpoints (for CopilotKit)
	// ============================================

	// In-memory thread storage (for development - in production, use a database)
	const threads = new Map<
		string,
		{
			thread_id: string;
			created_at: string;
			metadata: Record<string, unknown>;
			values: Record<string, unknown>;
		}
	>();

	// POST /threads - Create a new thread
	app.post("/threads", async (c: Context) => {
		const body = await c.req.json().catch(() => ({}));
		const threadId =
			body.thread_id ||
			`thread_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
		const thread = {
			thread_id: threadId,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			metadata: body.metadata || {},
			values: {},
		};
		threads.set(threadId, thread);
		console.log(
			`[UnifiedServer:${config.name}] LangGraph POST /threads - created ${threadId}`,
		);
		return c.json(thread);
	});

	// GET /threads/:threadId - Get thread details
	app.get("/threads/:threadId", async (c: Context) => {
		const threadId = c.req.param("threadId")!;
		console.log(
			`[UnifiedServer:${config.name}] LangGraph GET /threads/${threadId}`,
		);
		const thread = threads.get(threadId) || {
			thread_id: threadId,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			metadata: {},
			values: {},
		};
		return c.json(thread);
	});

	// POST /threads/search - Search threads
	app.post("/threads/search", async (c: Context) => {
		console.log(
			`[UnifiedServer:${config.name}] LangGraph POST /threads/search`,
		);
		return c.json(Array.from(threads.values()));
	});

	// PATCH /threads/:threadId - Update thread
	app.patch("/threads/:threadId", async (c: Context) => {
		const threadId = c.req.param("threadId")!;
		const body = await c.req.json().catch(() => ({}));
		console.log(
			`[UnifiedServer:${config.name}] LangGraph PATCH /threads/${threadId}`,
		);

		const existingThread = threads.get(threadId);
		const thread = {
			thread_id: threadId,
			created_at: existingThread?.created_at || new Date().toISOString(),
			metadata: existingThread?.metadata || {},
			...body,
			updated_at: new Date().toISOString(),
		};
		threads.set(threadId, thread);
		return c.json(thread);
	});

	// DELETE /threads/:threadId - Delete thread
	app.delete("/threads/:threadId", async (c: Context) => {
		const threadId = c.req.param("threadId")!;
		console.log(
			`[UnifiedServer:${config.name}] LangGraph DELETE /threads/${threadId}`,
		);
		threads.delete(threadId);
		return c.json({ success: true });
	});

	// GET /threads/:threadId/state - Get thread state
	app.get("/threads/:threadId/state", async (c: Context) => {
		const threadId = c.req.param("threadId")!;
		const thread = threads.get(threadId);
		console.log(
			`[UnifiedServer:${config.name}] LangGraph GET /threads/${threadId}/state`,
			{
				hasThread: !!thread,
				valuesKeys: thread?.values ? Object.keys(thread.values) : [],
			},
		);
		return c.json({
			values: thread?.values || {},
			next: [],
			checkpoint: thread
				? {
						thread_id: threadId,
						checkpoint_ns: "",
						checkpoint_id: `checkpoint_${Date.now()}`,
					}
				: null,
			metadata: thread?.metadata || {},
			created_at: thread?.created_at || new Date().toISOString(),
			parent_checkpoint: null,
		});
	});

	// POST /threads/:threadId/state - Update thread state
	app.post("/threads/:threadId/state", async (c: Context) => {
		const threadId = c.req.param("threadId")!;
		console.log(
			`[UnifiedServer:${config.name}] LangGraph POST /threads/${threadId}/state`,
		);
		return c.json({
			checkpoint: {
				thread_id: threadId,
				checkpoint_ns: "",
				checkpoint_id: `checkpoint_${Date.now()}`,
			},
		});
	});

	// GET /threads/:threadId/history - Get thread history
	app.get("/threads/:threadId/history", async (c: Context) => {
		const threadId = c.req.param("threadId")!;
		console.log(
			`[UnifiedServer:${config.name}] LangGraph GET /threads/${threadId}/history`,
		);
		return c.json([]);
	});

	/**
	 * Inner wrapper around the top-level `sanitizeStateForCopilotKit` helper
	 * that adds agent-scoped debug logging.
	 *
	 * The pure transformation lives at module scope (above) so it can be
	 * exercised directly from unit tests without spinning up the full server.
	 */
	const sanitizeStateForCopilotKitWithLog = (
		state: Record<string, unknown>,
	): Record<string, unknown> => {
		// Debug: Log what we're sanitizing including messages with tool_calls
		const messagesWithToolCalls = Array.isArray(state.messages)
			? (state.messages as Array<Record<string, unknown>>).filter(
					(m) => m && typeof m === "object" && "tool_calls" in m,
				)
			: [];
		console.log(
			`[UnifiedServer:${config.name}] sanitizeStateForCopilotKit input:`,
			{
				inputKeys: Object.keys(state),
				hasDocument: "document" in state,
				documentLength: (state.document as string)?.length || 0,
				messageCount: Array.isArray(state.messages)
					? state.messages.length
					: 0,
				messagesWithToolCalls: messagesWithToolCalls.length,
				toolCallsDetails: messagesWithToolCalls.map((m) => ({
					role: m.role,
					type: m.type,
					toolCalls: m.tool_calls,
				})),
			},
		);

		const sanitized = sanitizeStateForCopilotKit(state);

		// Debug: Log sanitized output including tool_calls
		const sanitizedMessagesWithToolCalls = Array.isArray(sanitized.messages)
			? (sanitized.messages as Array<Record<string, unknown>>).filter(
					(m) => m && typeof m === "object" && "tool_calls" in m,
				)
			: [];
		console.log(
			`[UnifiedServer:${config.name}] sanitizeStateForCopilotKit output:`,
			{
				outputKeys: Object.keys(sanitized),
				hasDocument: "document" in sanitized,
				documentLength: (sanitized.document as string)?.length || 0,
				messageCount: Array.isArray(sanitized.messages)
					? sanitized.messages.length
					: 0,
				messagesWithToolCalls: sanitizedMessagesWithToolCalls.length,
				toolCallsDetails: sanitizedMessagesWithToolCalls.map((m) => ({
					type: m.type,
					content: m.content,
					toolCalls: m.tool_calls,
				})),
			},
		);

		return sanitized;
	};

	// Graph-owned transient fields declared in the agent's state annotation
	// but never set by the client. Must NOT be carried forward from
	// body.state — doing so replays stale values from previous turns. E.g.
	// focusAnchor survives in the client echo, so merging it back scrolls the
	// editor to the previous section on every post-confirmation "end"
	// snapshot. error / retryCount behave the same way.
	const GRAPH_TRANSIENT_KEYS = new Set([
		"focusAnchor",
		"error",
		"retryCount",
	]);

	// Build the payload for the terminal STATE_SNAPSHOT (nodeName "end").
	// `useCoAgent` replaces its state from this snapshot, so we must include
	// client-managed fields that the graph doesn't own — projectId,
	// organizationId, promptId, etc. — otherwise they get wiped on turns that
	// produce no new document (e.g. post-confirmation acknowledgments).
	// Graph-produced keys take precedence over whatever the client sent in,
	// and graph-owned transient keys from body.state are dropped so stale
	// values can't leak into the new turn.
	const buildTerminalSnapshot = (
		incomingState: unknown,
		finalState: Record<string, unknown>,
	): Record<string, unknown> => {
		if (!incomingState || typeof incomingState !== "object") {
			return { ...finalState };
		}

		const base: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			incomingState as Record<string, unknown>,
		)) {
			if (!GRAPH_TRANSIENT_KEYS.has(key)) {
				base[key] = value;
			}
		}

		return { ...base, ...finalState };
	};

	// Helper to create SSE stream response for LangGraph Platform API format
	const createLangGraphStreamResponse = async (
		c: Context,
		input: {
			messages?: Array<{ role: string; content: string }>;
			[key: string]: unknown;
		},
		threadId?: string,
		bodyConfig?: { configurable?: Record<string, unknown> },
		fullBody?: Record<string, unknown>,
	) => {
		const messages = input.messages || [];
		const runId = `run_${Date.now()}`;

		// Extract AI configuration from multiple possible locations
		// CopilotKit can send properties in different locations depending on version/config:
		// 1. HTTP headers (forwarded by CopilotKit from the incoming request)
		// 2. body.config.configurable (LangGraph Platform API format)
		// 3. body.context (AG-UI/LangGraph spreads forwardedProps into context)
		// 4. body.properties (CopilotKit runtime properties)
		// 5. body.* (top level - @ag-ui/langgraph spreads forwardedProps here)
		// 6. input.* (legacy/direct format)
		const configurable = bodyConfig?.configurable || {};
		const properties =
			(fullBody?.properties as Record<string, unknown>) || {};
		// Context from AG-UI protocol (@ag-ui/langgraph spreads forwardedProps into context)
		const context = (fullBody?.context as Record<string, unknown>) || {};
		// Top-level body properties (from @ag-ui/langgraph spreading forwardedProps)
		const topLevelBody = fullBody || {};

		// Extract tenant context from headers
		const headerTenantUserId =
			c.req.header("X-Tenant-User-ID") ||
			c.req.header("x-tenant-user-id");
		const headerTenantOrgId =
			c.req.header("X-Tenant-Organization-ID") ||
			c.req.header("x-tenant-organization-id");

		// Extract AI config headers (non-sensitive hints)
		const headerAiModel =
			c.req.header("X-AI-Model") || c.req.header("x-ai-model");
		const headerAiProvider =
			c.req.header("X-AI-Provider") || c.req.header("x-ai-provider");
		const headerAiBaseUrl =
			c.req.header("X-AI-Base-URL") || c.req.header("x-ai-base-url");
		const headerAiDeploymentName =
			c.req.header("X-AI-Deployment-Name") ||
			c.req.header("x-ai-deployment-name");
		// Canonical-derived "emits <think>" signal (Bug #1942 review). Header is a
		// string ("true"/"false"); CopilotKit props pass a real boolean.
		const headerAiIsReasoning =
			c.req.header("X-AI-Is-Reasoning") ||
			c.req.header("x-ai-is-reasoning");

		// Token-based AI config (secure) - exchange token for API key
		// Token is REQUIRED for AI operations - no fallback to insecure methods
		let exchangedCredentials: AICredentials | null = null;
		const aiToken = extractAIToken(c.req.raw.headers);
		if (aiToken) {
			try {
				exchangedCredentials = await getAICredentialsFromHeaders(
					c.req.raw.headers,
				);
				console.log(
					`[UnifiedServer:${config.name}] Token exchange successful:`,
					{
						provider: exchangedCredentials?.provider,
						model: exchangedCredentials?.model,
						deploymentName: exchangedCredentials?.deploymentName,
						expiresIn: exchangedCredentials?.expiresIn,
					},
				);
			} catch (error) {
				console.error(
					`[UnifiedServer:${config.name}] Token exchange failed:`,
					error,
				);
				// Token was provided but exchange failed - this is an error
				return c.json(
					{
						error: "AI token exchange failed. Please check your AI provider configuration.",
					},
					401,
				);
			}
		}

		// Debug: Log received headers
		console.log(`[UnifiedServer:${config.name}] Headers received:`, {
			hasAiToken: !!aiToken,
			hasExchangedCredentials: !!exchangedCredentials,
			aiModelHeader: headerAiModel,
			aiProviderHeader: headerAiProvider,
			tenantUserId: headerTenantUserId,
		});

		// Build runtime config
		// Priority: passed ai_api_key (override provider) > token exchange (default provider)
		const runtimeConfig: AgentRuntimeConfig = {
			configurable: {
				// AI provider configuration
				// When CopilotKit passes ai_api_key directly (override provider), use it
				// Otherwise fall back to token exchange (default provider)
				ai_api_key:
					(configurable.ai_api_key as string | undefined) ||
					(context.ai_api_key as string | undefined) ||
					(properties.ai_api_key as string | undefined) ||
					(topLevelBody.ai_api_key as string | undefined) ||
					(input.ai_api_key as string | undefined) ||
					exchangedCredentials?.apiKey,
				ai_model:
					exchangedCredentials?.model ||
					headerAiModel ||
					(configurable.ai_model as string | undefined) ||
					(context.ai_model as string | undefined) ||
					(properties.ai_model as string | undefined) ||
					(topLevelBody.ai_model as string | undefined) ||
					(input.ai_model as string | undefined),
				ai_gateway_url:
					exchangedCredentials?.baseUrl ||
					headerAiBaseUrl ||
					(configurable.ai_gateway_url as string | undefined) ||
					(context.ai_gateway_url as string | undefined) ||
					(properties.ai_gateway_url as string | undefined) ||
					(topLevelBody.ai_gateway_url as string | undefined) ||
					(input.ai_gateway_url as string | undefined),
				ai_provider:
					exchangedCredentials?.provider ||
					headerAiProvider ||
					(configurable.ai_provider as string | undefined) ||
					(context.ai_provider as string | undefined) ||
					(properties.ai_provider as string | undefined) ||
					(topLevelBody.ai_provider as string | undefined) ||
					(input.ai_provider as string | undefined),
				ai_deployment_name:
					exchangedCredentials?.deploymentName ||
					headerAiDeploymentName ||
					(configurable.ai_deployment_name as string | undefined) ||
					(context.ai_deployment_name as string | undefined) ||
					(properties.ai_deployment_name as string | undefined) ||
					(topLevelBody.ai_deployment_name as string | undefined) ||
					(input.ai_deployment_name as string | undefined),
				// Coerce header string / prop boolean to a boolean (Bug #1942 review).
				ai_is_reasoning: coerceReasoningFlag(
					headerAiIsReasoning ??
						configurable.ai_is_reasoning ??
						context.ai_is_reasoning ??
						properties.ai_is_reasoning ??
						topLevelBody.ai_is_reasoning ??
						input.ai_is_reasoning,
				),
				ai_billing_mode: exchangedCredentials?.billingMode,
				ai_billing_customer_id: exchangedCredentials?.billingCustomerId,
				// Pass through tenant context
				tenant_user_id:
					headerTenantUserId ||
					(configurable.tenant_user_id as string | undefined) ||
					(context.tenant_user_id as string | undefined) ||
					(properties.tenant_user_id as string | undefined) ||
					(topLevelBody.tenant_user_id as string | undefined) ||
					(input.tenant_user_id as string | undefined),
				tenant_organization_id:
					headerTenantOrgId ||
					(configurable.tenant_organization_id as
						| string
						| undefined) ||
					(context.tenant_organization_id as string | undefined) ||
					(properties.tenant_organization_id as string | undefined) ||
					(topLevelBody.tenant_organization_id as
						| string
						| undefined) ||
					(input.tenant_organization_id as string | undefined),
				// Project context for per-project AI usage attribution.
				// A2A callers may pass either snake_case or camelCase.
				project_id: pickFirstString(
					[configurable, context, properties, topLevelBody, input],
					["project_id", "projectId"],
				),
				// Pass AI token for MCP configs API access
				ai_token: aiToken || undefined,
				// Spread any additional configurable properties
				...configurable,
				// Also spread context properties
				...context,
				// Also spread properties (lower priority than configurable)
				...properties,
			},
		};

		// Log where the AI config was sourced from
		const passedApiKey =
			(configurable.ai_api_key as string | undefined) ||
			(context.ai_api_key as string | undefined) ||
			(properties.ai_api_key as string | undefined) ||
			(topLevelBody.ai_api_key as string | undefined) ||
			(input.ai_api_key as string | undefined);
		const aiConfigSource = passedApiKey
			? "direct-override"
			: exchangedCredentials
				? "token-exchange"
				: "none";

		console.log(
			`[UnifiedServer:${config.name}] LangGraph /runs/stream with ${messages.length} messages, threadId: ${threadId || "none"}`,
			{
				hasAiApiKey: !!runtimeConfig.configurable?.ai_api_key,
				aiModel: runtimeConfig.configurable?.ai_model,
				aiProvider: runtimeConfig.configurable?.ai_provider,
				aiGatewayUrl: runtimeConfig.configurable?.ai_gateway_url,
				aiConfigSource,
			},
		);

		// If we have a platform streaming executor, use it for proper CopilotKit compatibility
		if (platformStreamAgent) {
			console.log(
				`[UnifiedServer:${config.name}] Using platform streaming executor`,
			);

			// Shared state for the ReadableStream — hoisted so the cancel()
			// handler can reach them when the client disconnects.
			let keepaliveInterval: ReturnType<typeof setInterval> | undefined;
			let activeGenerator:
				| AsyncGenerator<LangGraphStreamEvent, void, unknown>
				| undefined;

			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					let finalState: Record<string, unknown> = {};

					// Coalesces interim "updates" events (each is a cumulative state
					// snapshot) when the client isn't draining the stream, so a slow
					// or dead consumer can't grow the controller's internal queue
					// unboundedly.
					const updatesGate = new CoalescingEventGate<string>({
						warn: (msg, meta) =>
							console.warn(
								`[UnifiedServer:${config.name}] ${msg}`,
								meta,
							),
					});

					// Track if controller is still open to avoid ERR_INVALID_STATE errors
					let isControllerOpen = true;

					// Helper to safely enqueue data
					const safeEnqueue = (data: Uint8Array) => {
						if (!isControllerOpen) {
							return false;
						}
						try {
							controller.enqueue(data);
							return true;
						} catch (error) {
							if (
								(error as NodeJS.ErrnoException).code ===
								"ERR_INVALID_STATE"
							) {
								console.log(
									`[UnifiedServer:${config.name}] Controller closed during enqueue`,
								);
								isControllerOpen = false;
								return false;
							}
							throw error;
						}
					};

					// Helper to safely close the controller
					const safeClose = () => {
						if (isControllerOpen) {
							isControllerOpen = false;
							try {
								controller.close();
							} catch (_error) {
								// Already closed, ignore
							}
						}
					};

					// Start SSE keepalive heartbeat to prevent Azure Container Apps
					// ingress from closing the connection during long LLM calls.
					// SSE comments (lines starting with ':') are ignored by clients.
					keepaliveInterval = setInterval(() => {
						safeEnqueue(encoder.encode(":keepalive\n\n"));
					}, 30_000); // every 30s, well under the 240s idle timeout

					try {
						// Send metadata event
						safeEnqueue(
							encoder.encode(
								`event: metadata\ndata: ${JSON.stringify({ run_id: runId })}\n\n`,
							),
						);

						// Stream updates from the platform executor with AI config
						// CRITICAL: Pass fullBody.context as context - this is where useCopilotReadable sends readable data
						// The AG-UI protocol sends readable contexts at body.context, NOT input.context
						console.log(
							`[UnifiedServer:${config.name}] Passing context to platformStreamAgent:`,
							{
								hasContext: !!fullBody?.context,
								contextLength: Array.isArray(fullBody?.context)
									? fullBody.context.length
									: 0,
							},
						);
						activeGenerator = platformStreamAgent(
							{
								messages,
								threadId,
								...input,
								// Include readable contexts from useCopilotReadable (Fix 1.5e)
								// fullBody.context contains the array of readable context objects
								context: fullBody?.context,
							},
							runtimeConfig,
						);

						let stoppedByClosedController = false;
						for await (const event of activeGenerator) {
							// Sanitize state for CopilotKit compatibility
							const sanitizedState =
								sanitizeStateForCopilotKitWithLog(event.state);

							// Debug: Log sanitized state
							console.log(
								`[UnifiedServer:${config.name}] Sanitized state:`,
								{
									nodeName: event.nodeName,
									stateKeys: Object.keys(sanitizedState),
									hasDocument: "document" in sanitizedState,
									documentLength:
										(sanitizedState.document as string)
											?.length || 0,
									messageCount:
										(sanitizedState.messages as unknown[])
											?.length || 0,
								},
							);

							// Accumulate state for final values event — this must happen
							// for EVERY event regardless of whether it gets coalesced
							// below, since finalState is the authoritative snapshot sent
							// in the terminal "values" event.
							finalState = { ...finalState, ...sanitizedState };

							// Send updates event for each node update
							// Format: { nodeName: { ...stateUpdates } }
							const updateData = {
								[event.nodeName]: sanitizedState,
							};
							const sseChunk = `event: updates\ndata: ${JSON.stringify(updateData)}\n\n`;

							// Only droppable (preview) events go through the coalescing
							// gate. Regular node-update events are deltas, not cumulative
							// snapshots — coalescing one could permanently drop state
							// (e.g. a reasoning/message update superseded by a document
							// update) — so every non-droppable event is delivered in
							// full, in order. It still acts as an ordering barrier: any
							// pending preview is flushed first so a held preview is never
							// delivered after a later, non-preview event derived from
							// newer state.
							const chunksToEmit: string[] = [];
							if (event.droppable === true) {
								chunksToEmit.push(
									...updatesGate.offer(
										sseChunk,
										controller.desiredSize,
									),
								);
							} else {
								const pending = updatesGate.flush();
								if (pending !== null) {
									chunksToEmit.push(pending);
								}
								chunksToEmit.push(sseChunk);
							}

							for (const chunk of chunksToEmit) {
								if (!safeEnqueue(encoder.encode(chunk))) {
									stoppedByClosedController = true;
									break;
								}
							}
							if (stoppedByClosedController) {
								break; // Stop streaming if controller closed
							}

							console.log(
								`[UnifiedServer:${config.name}] Streamed update from node: ${event.nodeName}`,
							);
						}

						// Flush any coalesced interim update BEFORE the terminal
						// end/values events below, so the final observable state the
						// client saw before completion still reflects the last real
						// interim update rather than skipping straight to "end".
						if (!stoppedByClosedController) {
							const pendingChunk = updatesGate.flush();
							if (pendingChunk !== null) {
								safeEnqueue(encoder.encode(pendingChunk));
							}
						}

						// Send final update with nodeName 'end' for CopilotKit compatibility
						// This signals to the frontend that streaming is complete
						// CopilotKit's useCoAgent uses nodeName == 'end' to detect completion
						const finalUpdateData = {
							end: finalState,
						};
						safeEnqueue(
							encoder.encode(
								`event: updates\ndata: ${JSON.stringify(finalUpdateData)}\n\n`,
							),
						);

						console.log(
							`[UnifiedServer:${config.name}] Sending final STATE_SNAPSHOT with document:`,
							{
								runId,
								threadId,
								documentLength:
									(finalState.document as string)?.length ||
									0,
								nodeName: "end",
							},
						);

						// Send final values event with complete state (already sanitized)
						safeEnqueue(
							encoder.encode(
								`event: values\ndata: ${JSON.stringify(finalState)}\n\n`,
							),
						);

						// Save final state to thread storage for subsequent GET /threads/:threadId/state calls
						if (threadId) {
							const existingThread = threads.get(threadId);
							if (existingThread) {
								existingThread.values = finalState;
								console.log(
									`[UnifiedServer:${config.name}] Saved final state to thread ${threadId}`,
									{
										stateKeys: Object.keys(finalState),
									},
								);
							} else {
								// Create thread if it doesn't exist
								threads.set(threadId, {
									thread_id: threadId,
									created_at: new Date().toISOString(),
									metadata: {},
									values: finalState,
								});
								console.log(
									`[UnifiedServer:${config.name}] Created thread ${threadId} with final state`,
								);
							}
						}

						// Send end event
						safeEnqueue(
							encoder.encode("event: end\ndata: null\n\n"),
						);
						safeClose();
					} catch (error) {
						// Only log if it's not an expected controller closed error
						if (
							(error as NodeJS.ErrnoException).code !==
							"ERR_INVALID_STATE"
						) {
							console.error(
								`[UnifiedServer:${config.name}] Stream error:`,
								error,
							);
						}
						// AG-UI's LangGraph adapter builds RUN_ERROR from
						// event.data.message, not event.data.error — emit both so
						// the adapter surfaces this instead of a generic failure.
						const errorMessage =
							error instanceof Error
								? error.message
								: "Unknown error";
						safeEnqueue(
							encoder.encode(
								`event: error\ndata: ${JSON.stringify({ message: errorMessage, error: errorMessage, code: "AGENT_RUN_ERROR" })}\n\n`,
							),
						);
						safeClose();
					} finally {
						clearInterval(keepaliveInterval);
						keepaliveInterval = undefined;
						activeGenerator = undefined;
					}
				},
				cancel() {
					// Called when the client disconnects — clears the heartbeat
					// immediately rather than waiting for start() to unwind, and
					// signals the generator to exit at its next yield point.
					if (keepaliveInterval !== undefined) {
						clearInterval(keepaliveInterval);
						keepaliveInterval = undefined;
					}
					if (activeGenerator) {
						activeGenerator.return(undefined as never);
						activeGenerator = undefined;
					}
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		}

		// Fallback: Invoke synchronously and send single values event
		console.log(
			`[UnifiedServer:${config.name}] Using synchronous invoke (no platform streaming)`,
		);

		const rawResult = await invokeAgent({
			messages,
			threadId,
			...input,
		});

		// Sanitize result for CopilotKit compatibility
		const result = sanitizeStateForCopilotKitWithLog(rawResult);

		// Save state to thread storage
		if (threadId) {
			const existingThread = threads.get(threadId);
			if (existingThread) {
				existingThread.values = result;
			} else {
				threads.set(threadId, {
					thread_id: threadId,
					created_at: new Date().toISOString(),
					metadata: {},
					values: result,
				});
			}
		}

		// Create SSE stream in LangGraph format
		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				let isControllerOpen = true;

				const safeEnqueue = (data: Uint8Array) => {
					if (!isControllerOpen) {
						return;
					}
					try {
						controller.enqueue(data);
					} catch (error) {
						if (
							(error as NodeJS.ErrnoException).code ===
							"ERR_INVALID_STATE"
						) {
							isControllerOpen = false;
						} else {
							throw error;
						}
					}
				};

				const safeClose = () => {
					if (isControllerOpen) {
						isControllerOpen = false;
						try {
							controller.close();
						} catch {
							/* ignore */
						}
					}
				};

				try {
					// Send metadata event
					safeEnqueue(
						encoder.encode(
							`event: metadata\ndata: ${JSON.stringify({ run_id: runId })}\n\n`,
						),
					);

					// Send values event with the sanitized result
					safeEnqueue(
						encoder.encode(
							`event: values\ndata: ${JSON.stringify(result)}\n\n`,
						),
					);

					// Send end event
					safeEnqueue(encoder.encode("event: end\ndata: null\n\n"));
					safeClose();
				} catch (error) {
					if (
						(error as NodeJS.ErrnoException).code !==
						"ERR_INVALID_STATE"
					) {
						console.error(
							`[UnifiedServer:${config.name}] Stream error:`,
							error,
						);
					}
					safeEnqueue(
						encoder.encode(
							`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" })}\n\n`,
						),
					);
					safeClose();
				}
			},
		});

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	};

	// POST /runs/stream - Stream a run (no thread)
	app.post("/runs/stream", async (c: Context) => {
		try {
			const body = await c.req.json();
			const input = body.input || {};
			const bodyConfig = body.config as
				| { configurable?: Record<string, unknown> }
				| undefined;
			// The raw request body can carry `properties.ai_token` /
			// `configurable.ai_token` — strip the value before it hits the
			// truncated debug dump below.
			const redactedBody = JSON.stringify(body).replace(
				/"(ai_token|aiToken|x-ai-token)"\s*:\s*"[^"]+"/gi,
				'"$1":"[redacted]"',
			);

			// Debug logging to trace AI config - log full body structure
			console.log(
				`[UnifiedServer:${config.name}] /runs/stream FULL REQUEST:`,
				JSON.stringify(
					{
						bodyKeys: Object.keys(body),
						inputKeys: Object.keys(input),
						configKeys: body.config ? Object.keys(body.config) : [],
						configurableKeys: bodyConfig?.configurable
							? Object.keys(bodyConfig.configurable)
							: [],
						contextKeys: body.context
							? Object.keys(body.context)
							: [],
						propertiesKeys: body.properties
							? Object.keys(body.properties)
							: [],
						// Check for CopilotKit actions/tools
						hasActions: !!(
							body.actions ||
							input.actions ||
							body.context?.actions
						),
						actionsCount:
							(
								body.actions ||
								input.actions ||
								body.context?.actions
							)?.length || 0,
						hasCopilotkit: !!(body.copilotkit || input.copilotkit),
						copilotKitKeys: body.copilotkit
							? Object.keys(body.copilotkit)
							: [],
						// Check ALL locations for ai_api_key
						inputAiApiKey: !!input.ai_api_key,
						configAiApiKey: !!bodyConfig?.configurable?.ai_api_key,
						contextAiApiKey: !!body.context?.ai_api_key,
						propertiesAiApiKey: !!body.properties?.ai_api_key,
						// Check top-level body (from @ag-ui/langgraph spreading forwardedProps)
						topLevelAiApiKey: !!body.ai_api_key,
						topLevelAiModel: body.ai_model,
						topLevelAiProvider: body.ai_provider,
						// Log the full body (truncated), with ai_token redacted
						fullBody: redactedBody.slice(0, 2000),
					},
					null,
					2,
				),
			);

			return createLangGraphStreamResponse(
				c,
				input,
				undefined,
				bodyConfig,
				body,
			);
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /runs/stream:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// POST /threads/:threadId/runs/stream - Stream a run on a thread
	app.post("/threads/:threadId/runs/stream", async (c: Context) => {
		try {
			const threadId = c.req.param("threadId")!;
			const body = await c.req.json();
			const input = body.input || {};
			const bodyConfig = body.config as
				| { configurable?: Record<string, unknown> }
				| undefined;

			// Debug logging to trace AI config
			console.log(
				`[UnifiedServer:${config.name}] /threads/${threadId}/runs/stream request body:`,
				{
					hasInput: !!body.input,
					hasConfig: !!body.config,
					hasConfigurable: !!bodyConfig?.configurable,
					hasContext: !!body.context,
					hasProperties: !!body.properties,
					configurableKeys: bodyConfig?.configurable
						? Object.keys(bodyConfig.configurable)
						: [],
					contextKeys: body.context ? Object.keys(body.context) : [],
					propertiesKeys: body.properties
						? Object.keys(body.properties)
						: [],
					hasAiApiKey: !!bodyConfig?.configurable?.ai_api_key,
					contextAiApiKey: !!body.context?.ai_api_key,
					propertiesAiApiKey: !!body.properties?.ai_api_key,
					// Check top-level body (from @ag-ui/langgraph spreading forwardedProps)
					topLevelAiApiKey: !!body.ai_api_key,
					topLevelAiModel: body.ai_model,
					topLevelAiProvider: body.ai_provider,
					aiModel:
						bodyConfig?.configurable?.ai_model ||
						body.context?.ai_model ||
						body.properties?.ai_model ||
						body.ai_model,
					aiProvider:
						bodyConfig?.configurable?.ai_provider ||
						body.context?.ai_provider ||
						body.properties?.ai_provider ||
						body.ai_provider,
					// Also check input for legacy support
					inputHasAiApiKey: !!input.ai_api_key,
				},
			);

			return createLangGraphStreamResponse(
				c,
				input,
				threadId,
				bodyConfig,
				body,
			);
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /threads/:threadId/runs/stream:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// POST /runs - Create a run (invoke without streaming)
	app.post("/runs", async (c: Context) => {
		try {
			const body = await c.req.json();
			const input = body.input || {};
			const messages = input.messages || [];

			console.log(
				`[UnifiedServer:${config.name}] LangGraph /runs with ${messages.length} messages`,
			);

			const result = await invokeAgent({
				messages,
				...input,
			});

			return c.json({
				run_id: `run_${Date.now()}`,
				status: "success",
				...result,
			});
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /runs:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// POST /threads/:threadId/runs - Create a run on a thread
	app.post("/threads/:threadId/runs", async (c: Context) => {
		try {
			const threadId = c.req.param("threadId")!;
			const body = await c.req.json();
			const input = body.input || {};
			const messages = input.messages || [];

			console.log(
				`[UnifiedServer:${config.name}] LangGraph /threads/${threadId}/runs with ${messages.length} messages`,
			);

			const result = await invokeAgent({
				messages,
				threadId,
				...input,
			});

			return c.json({
				run_id: `run_${Date.now()}`,
				thread_id: threadId,
				status: "success",
				...result,
			});
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /threads/:threadId/runs:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// ============================================
	// AG-UI Protocol Endpoints (legacy, for direct integration)
	// ============================================

	// Health check (AG-UI style)
	app.get("/ok", (c: Context) => c.json({ ok: true }));

	// Run endpoint (CopilotKit LangGraphHttpAgent uses this)
	// Alias for /invoke
	app.post("/run", async (c: Context) => {
		try {
			const body = await c.req.json();
			const messages = body.messages || [];

			console.log(
				`[UnifiedServer:${config.name}] CopilotKit /run with ${messages.length} messages`,
			);

			const result = await invokeAgent({
				messages,
				...body,
			});

			return c.json(result);
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /run:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// Invoke endpoint (AG-UI)
	app.post("/invoke", async (c: Context) => {
		try {
			const body = await c.req.json();
			const messages = body.messages || [];

			console.log(
				`[UnifiedServer:${config.name}] AG-UI /invoke with ${messages.length} messages`,
			);

			const result = await invokeAgent({
				messages,
				...body,
			});

			return c.json(result);
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /invoke:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// Stream endpoint (AG-UI)
	app.post("/stream", async (c: Context) => {
		try {
			const body = await c.req.json();
			const messages = body.messages || [];

			console.log(
				`[UnifiedServer:${config.name}] AG-UI /stream with ${messages.length} messages`,
			);

			if (!streamAgent) {
				// Fall back to non-streaming
				const result = await invokeAgent({
					messages,
					...body,
				});
				return c.json(result);
			}

			// Create SSE stream
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					let isControllerOpen = true;

					const safeEnqueue = (data: Uint8Array) => {
						if (!isControllerOpen) {
							return false;
						}
						try {
							controller.enqueue(data);
							return true;
						} catch (error) {
							if (
								(error as NodeJS.ErrnoException).code ===
								"ERR_INVALID_STATE"
							) {
								isControllerOpen = false;
								return false;
							}
							throw error;
						}
					};

					const safeClose = () => {
						if (isControllerOpen) {
							isControllerOpen = false;
							try {
								controller.close();
							} catch {
								/* ignore */
							}
						}
					};

					try {
						const generator = streamAgent({
							messages,
							...body,
						});

						for await (const chunk of generator) {
							const data = JSON.stringify(chunk);
							if (
								!safeEnqueue(
									encoder.encode(`data: ${data}\n\n`),
								)
							) {
								break;
							}
						}

						safeEnqueue(encoder.encode("data: [DONE]\n\n"));
						safeClose();
					} catch (error) {
						if (
							(error as NodeJS.ErrnoException).code !==
							"ERR_INVALID_STATE"
						) {
							console.error(
								`[UnifiedServer:${config.name}] Stream error:`,
								error,
							);
							controller.error(error);
						} else {
							safeClose();
						}
					}
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /stream:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// ============================================
	// A2A Protocol Endpoints (for orchestrator)
	// ============================================

	// Agent Card (v0.3.0 well-known URI)
	app.get("/.well-known/agent-card.json", (c: Context) => {
		return c.json(a2aServer.getAgentCard());
	});

	// Agent Card (legacy well-known URI)
	app.get("/.well-known/agent.json", (c: Context) => {
		return c.json(a2aServer.getAgentCard());
	});

	// A2A Send
	app.post("/a2a/send", async (c: Context) => {
		try {
			const body = await c.req.json();

			// Extract tenant context from headers
			const headerTenantUserId =
				c.req.header("X-Tenant-User-ID") ||
				c.req.header("x-tenant-user-id");
			const headerTenantOrgId =
				c.req.header("X-Tenant-Organization-ID") ||
				c.req.header("x-tenant-organization-id");

			// Extract AI config headers (non-sensitive hints)
			const headerAiModel =
				c.req.header("X-AI-Model") || c.req.header("x-ai-model");
			const headerAiProvider =
				c.req.header("X-AI-Provider") || c.req.header("x-ai-provider");
			const headerAiBaseUrl =
				c.req.header("X-AI-Base-URL") || c.req.header("x-ai-base-url");
			const headerAiDeploymentName =
				c.req.header("X-AI-Deployment-Name") ||
				c.req.header("x-ai-deployment-name");

			// Token-based AI config (secure) - exchange token for API key
			// Token is REQUIRED for system agents - no insecure fallback
			let exchangedCredentials: AICredentials | null = null;
			const aiToken = extractAIToken(c.req.raw.headers);
			if (aiToken) {
				try {
					exchangedCredentials = await getAICredentialsFromHeaders(
						c.req.raw.headers,
					);
					console.log(
						`[UnifiedServer:${config.name}] A2A token exchange successful:`,
						{
							provider: exchangedCredentials?.provider,
							model: exchangedCredentials?.model,
							deploymentName:
								exchangedCredentials?.deploymentName,
						},
					);
				} catch (error) {
					console.error(
						`[UnifiedServer:${config.name}] A2A token exchange failed:`,
						error,
					);
					return c.json(
						{
							error: "AI token exchange failed. Invalid or expired token.",
						},
						401,
					);
				}
			}

			console.log(
				`[UnifiedServer:${config.name}] A2A /a2a/send headers:`,
				{
					hasAiToken: !!aiToken,
					hasExchangedCredentials: !!exchangedCredentials,
					aiModel: headerAiModel,
					aiProvider: headerAiProvider,
					tenantUserId: headerTenantUserId,
					tenantOrgId: headerTenantOrgId,
				},
			);

			// Merge AI config into metadata so executor can access them
			// Priority: passed ai_api_key (override provider) > token exchange (default provider)
			const enrichedBody = {
				...body,
				metadata: {
					...body.metadata,
					// AI config - prefer passed value (override), fallback to token exchange
					ai_api_key:
						body.metadata?.ai_api_key ||
						exchangedCredentials?.apiKey,
					ai_model:
						exchangedCredentials?.model ||
						headerAiModel ||
						body.metadata?.ai_model,
					ai_provider:
						exchangedCredentials?.provider ||
						headerAiProvider ||
						body.metadata?.ai_provider,
					ai_base_url:
						exchangedCredentials?.baseUrl ||
						headerAiBaseUrl ||
						body.metadata?.ai_base_url,
					ai_deployment_name:
						exchangedCredentials?.deploymentName ||
						headerAiDeploymentName ||
						body.metadata?.ai_deployment_name,
					ai_billing_mode: exchangedCredentials?.billingMode,
					ai_billing_customer_id:
						exchangedCredentials?.billingCustomerId,
					tenant_user_id:
						headerTenantUserId || body.metadata?.tenant_user_id,
					tenant_organization_id:
						headerTenantOrgId ||
						body.metadata?.tenant_organization_id,
					// Pass AI token for MCP configs API access
					ai_token: aiToken || undefined,
				},
			};

			const response = await handlers.sendMessage(enrichedBody);
			const result = await response.json();
			return c.json(result, response.status as 200);
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /a2a/send:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// A2A Send Stream
	app.post("/a2a/send/stream", async (c: Context) => {
		try {
			const body = await c.req.json();

			// Extract tenant context from headers
			const headerTenantUserId =
				c.req.header("X-Tenant-User-ID") ||
				c.req.header("x-tenant-user-id");
			const headerTenantOrgId =
				c.req.header("X-Tenant-Organization-ID") ||
				c.req.header("x-tenant-organization-id");

			// Extract AI config headers (non-sensitive hints)
			const headerAiModel =
				c.req.header("X-AI-Model") || c.req.header("x-ai-model");
			const headerAiProvider =
				c.req.header("X-AI-Provider") || c.req.header("x-ai-provider");
			const headerAiBaseUrl =
				c.req.header("X-AI-Base-URL") || c.req.header("x-ai-base-url");
			const headerAiDeploymentName =
				c.req.header("X-AI-Deployment-Name") ||
				c.req.header("x-ai-deployment-name");

			// Token-based AI config (secure) - exchange token for API key
			// Token is REQUIRED for system agents - no insecure fallback
			let exchangedCredentials: AICredentials | null = null;
			const aiToken = extractAIToken(c.req.raw.headers);
			if (aiToken) {
				try {
					exchangedCredentials = await getAICredentialsFromHeaders(
						c.req.raw.headers,
					);
				} catch (error) {
					console.error(
						`[UnifiedServer:${config.name}] A2A stream token exchange failed:`,
						error,
					);
					return c.json(
						{
							error: "AI token exchange failed. Invalid or expired token.",
						},
						401,
					);
				}
			}

			// Merge AI config into metadata so executor can access them
			// Priority: passed ai_api_key (override provider) > token exchange (default provider)
			const enrichedBody = {
				...body,
				metadata: {
					...body.metadata,
					// AI config - prefer passed value (override), fallback to token exchange
					ai_api_key:
						body.metadata?.ai_api_key ||
						exchangedCredentials?.apiKey,
					ai_model:
						exchangedCredentials?.model ||
						headerAiModel ||
						body.metadata?.ai_model,
					ai_provider:
						exchangedCredentials?.provider ||
						headerAiProvider ||
						body.metadata?.ai_provider,
					ai_base_url:
						exchangedCredentials?.baseUrl ||
						headerAiBaseUrl ||
						body.metadata?.ai_base_url,
					ai_deployment_name:
						exchangedCredentials?.deploymentName ||
						headerAiDeploymentName ||
						body.metadata?.ai_deployment_name,
					ai_billing_mode: exchangedCredentials?.billingMode,
					ai_billing_customer_id:
						exchangedCredentials?.billingCustomerId,
					tenant_user_id:
						headerTenantUserId || body.metadata?.tenant_user_id,
					tenant_organization_id:
						headerTenantOrgId ||
						body.metadata?.tenant_organization_id,
					// Pass AI token for MCP configs API access
					ai_token: aiToken || undefined,
				},
			};

			const response = handlers.sendMessageStream(enrichedBody);
			return new Response(response.body, {
				status: 200,
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in /a2a/send/stream:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// A2A Get Task
	app.get("/a2a/tasks/:taskId", (c: Context) => {
		const taskId = c.req.param("taskId")!;
		const response = handlers.getTask(taskId);
		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	});

	// A2A Cancel Task
	app.post("/a2a/tasks/:taskId/cancel", async (c: Context) => {
		const taskId = c.req.param("taskId")!;
		const response = await handlers.cancelTask(taskId);
		return new Response(response.body, {
			status: response.status,
			headers: response.headers,
		});
	});

	// ============================================
	// Common Endpoints
	// ============================================

	// CopilotKit /info endpoint - required by LangGraphHttpAgent
	// Returns agent metadata in CopilotKit format
	app.post("/info", (c: Context) => {
		return c.json({
			actions: [],
			agents: [
				{
					name: config.name,
					description: config.description || `${config.name} agent`,
					type: "langgraph",
				},
			],
			sdkVersion: "0.1.32",
		});
	});

	// Also support /copilotkit/info path for namespaced access
	app.post("/copilotkit/info", (c: Context) => {
		return c.json({
			actions: [],
			agents: [
				{
					name: config.name,
					description: config.description || `${config.name} agent`,
					type: "langgraph",
				},
			],
			sdkVersion: "0.1.32",
		});
	});

	// ============================================
	// AG-UI Root Endpoint (for LangGraphHttpAgent)
	// ============================================
	// LangGraphHttpAgent from @ag-ui/client makes POST / requests
	// expecting AG-UI format SSE events
	app.post("/", async (c: Context) => {
		console.log(
			`[UnifiedServer:${config.name}] AG-UI root POST / handler called`,
		);

		try {
			const body = await c.req.json();
			const messages = stripEmptyResponseFallbacks(body.messages || []);
			const threadId = body.threadId || `thread_${Date.now()}`;
			const runId = body.runId || `run_${Date.now()}`;

			// Extract tenant context from headers (forwarded by LangGraphHttpAgent)
			const tenantUserId =
				c.req.header("X-Tenant-User-ID") ||
				c.req.header("x-tenant-user-id");
			const tenantOrgId =
				c.req.header("X-Tenant-Organization-ID") ||
				c.req.header("x-tenant-organization-id");

			// Extract AI config headers (non-sensitive hints)
			const headerAiModel =
				c.req.header("X-AI-Model") || c.req.header("x-ai-model");
			const headerAiBaseUrl =
				c.req.header("X-AI-Base-URL") ||
				c.req.header("X-AI-Base-Url") ||
				c.req.header("x-ai-base-url");
			const headerAiProvider =
				c.req.header("X-AI-Provider") || c.req.header("x-ai-provider");
			const headerAiDeploymentName =
				c.req.header("X-AI-Deployment-Name") ||
				c.req.header("x-ai-deployment-name");

			// Token-based AI config (secure) - exchange token for API key
			// Token is REQUIRED for AI operations - no insecure fallback
			let exchangedCredentials: AICredentials | null = null;
			const aiToken = extractAIToken(c.req.raw.headers);
			if (aiToken) {
				try {
					exchangedCredentials = await getAICredentialsFromHeaders(
						c.req.raw.headers,
					);
					console.log(
						`[UnifiedServer:${config.name}] AG-UI token exchange successful:`,
						{
							provider: exchangedCredentials?.provider,
							model: exchangedCredentials?.model,
							deploymentName:
								exchangedCredentials?.deploymentName,
						},
					);
				} catch (error) {
					console.error(
						`[UnifiedServer:${config.name}] AG-UI token exchange failed:`,
						error,
					);
					return c.json(
						{
							error: "AI token exchange failed. Please check your AI provider configuration.",
						},
						401,
					);
				}
			}

			// Check for CopilotKit actions in various locations
			// CopilotKit may send actions under 'tools', 'copilotkit.actions', 'context', or 'state.copilotkit'
			const bodyTools = body.tools as any[] | undefined;
			const bodyCopilotkit = body.copilotkit as
				| { actions?: any[] }
				| undefined;
			const _statecopilotkit = (body.state as any)?.copilotkit as
				| { actions?: any[] }
				| undefined;

			// Extract AI config from body (multiple possible locations)
			const bodyConfigurable = (body.config?.configurable ||
				{}) as Record<string, unknown>;
			const bodyContext = (body.context || {}) as Record<string, unknown>;
			const bodyForwardedProps = (body.forwardedProps || {}) as Record<
				string,
				unknown
			>;
			const bodyProperties = (body.properties || {}) as Record<
				string,
				unknown
			>;

			// Log context metadata only (no content to avoid data leaks)
			console.log(`[UnifiedServer:${config.name}] AG-UI / context:`, {
				hasContext: !!body.context,
				contextLength: Array.isArray(body.context)
					? body.context.length
					: 0,
			});

			console.log(`[UnifiedServer:${config.name}] AG-UI / request:`, {
				messagesCount: messages.length,
				threadId,
				runId,
				tenantUserId,
				hasTenantOrgId: !!tenantOrgId,
				bodyKeys: Object.keys(body),
				// CopilotKit frontend actions debugging
				hasBodyTools: !!bodyTools,
				bodyToolsCount: bodyTools?.length || 0,
				hasCopilotkit: !!bodyCopilotkit,
				// AI config debugging
				hasAiToken: !!aiToken,
				hasExchangedCredentials: !!exchangedCredentials,
				headerAiModel,
				headerAiProvider,
			});

			// Build runtime config
			// Priority: passed ai_api_key (override provider) > token exchange (default provider)
			const runtimeConfig: AgentRuntimeConfig = {
				configurable: {
					// AI provider configuration
					// When CopilotKit passes ai_api_key directly (override provider), use it
					// Otherwise fall back to token exchange (default provider)
					ai_api_key:
						(bodyConfigurable.ai_api_key as string | undefined) ||
						(bodyContext.ai_api_key as string | undefined) ||
						(bodyForwardedProps.ai_api_key as string | undefined) ||
						(bodyProperties.ai_api_key as string | undefined) ||
						(body.ai_api_key as string | undefined) ||
						exchangedCredentials?.apiKey,
					ai_model:
						exchangedCredentials?.model ||
						headerAiModel ||
						(bodyConfigurable.ai_model as string | undefined) ||
						(bodyContext.ai_model as string | undefined) ||
						(bodyForwardedProps.ai_model as string | undefined) ||
						(bodyProperties.ai_model as string | undefined) ||
						(body.ai_model as string | undefined),
					ai_gateway_url:
						exchangedCredentials?.baseUrl ||
						headerAiBaseUrl ||
						(bodyConfigurable.ai_gateway_url as
							| string
							| undefined) ||
						(bodyContext.ai_gateway_url as string | undefined) ||
						(bodyForwardedProps.ai_gateway_url as
							| string
							| undefined) ||
						(bodyProperties.ai_gateway_url as string | undefined) ||
						(body.ai_gateway_url as string | undefined),
					ai_provider:
						exchangedCredentials?.provider ||
						headerAiProvider ||
						(bodyConfigurable.ai_provider as string | undefined) ||
						(bodyContext.ai_provider as string | undefined) ||
						(bodyForwardedProps.ai_provider as
							| string
							| undefined) ||
						(bodyProperties.ai_provider as string | undefined) ||
						(body.ai_provider as string | undefined),
					ai_deployment_name:
						exchangedCredentials?.deploymentName ||
						headerAiDeploymentName ||
						(bodyConfigurable.ai_deployment_name as
							| string
							| undefined) ||
						(bodyContext.ai_deployment_name as
							| string
							| undefined) ||
						(bodyForwardedProps.ai_deployment_name as
							| string
							| undefined) ||
						(bodyProperties.ai_deployment_name as
							| string
							| undefined) ||
						(body.ai_deployment_name as string | undefined),
					ai_billing_mode: exchangedCredentials?.billingMode,
					ai_billing_customer_id:
						exchangedCredentials?.billingCustomerId,
					// Tenant context
					tenant_user_id: tenantUserId,
					tenant_organization_id: tenantOrgId,
					// Pass AI token for MCP configs API access
					ai_token: aiToken || undefined,
					// Spread any additional config
					...bodyConfigurable,
					...bodyContext,
					...bodyForwardedProps,
					...bodyProperties,
				},
			};

			// Log where AI config came from
			const passedApiKeyAGUI =
				(bodyConfigurable.ai_api_key as string | undefined) ||
				(bodyContext.ai_api_key as string | undefined) ||
				(bodyForwardedProps.ai_api_key as string | undefined) ||
				(bodyProperties.ai_api_key as string | undefined) ||
				(body.ai_api_key as string | undefined);
			const aiConfigSource = passedApiKeyAGUI
				? "direct-override"
				: exchangedCredentials
					? "token-exchange"
					: "none";

			console.log(`[UnifiedServer:${config.name}] AG-UI AI config:`, {
				aiConfigSource,
				hasAiApiKey: !!runtimeConfig.configurable?.ai_api_key,
				aiModel: runtimeConfig.configurable?.ai_model,
				aiProvider: runtimeConfig.configurable?.ai_provider,
				aiGatewayUrl: runtimeConfig.configurable?.ai_gateway_url,
			});

			// Shared state for the AG-UI ReadableStream — hoisted so the
			// cancel() handler can clear the keepalive when the client disconnects.
			let keepaliveInterval: ReturnType<typeof setInterval> | undefined;

			// Create SSE stream with AG-UI format events
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();

					// Track if controller is still open to avoid ERR_INVALID_STATE errors
					// This happens when client disconnects before stream completes
					let isControllerOpen = true;

					// Helper to safely enqueue raw bytes (used by keepalive)
					const safeEnqueue = (data: Uint8Array) => {
						if (!isControllerOpen) {
							return false;
						}
						try {
							controller.enqueue(data);
							return true;
						} catch (error) {
							if (
								(error as NodeJS.ErrnoException).code ===
								"ERR_INVALID_STATE"
							) {
								isControllerOpen = false;
								return false;
							}
							throw error;
						}
					};

					// Helper to send AG-UI events safely
					const sendEvent = (event: Record<string, unknown>) => {
						if (!isControllerOpen) {
							console.log(
								`[UnifiedServer:${config.name}] Skipping event (controller closed):`,
								event.type,
							);
							return;
						}
						try {
							const data = JSON.stringify(event);
							controller.enqueue(
								encoder.encode(`data: ${data}\n\n`),
							);
						} catch (error) {
							// Controller was closed (client disconnected)
							if (
								(error as NodeJS.ErrnoException).code ===
								"ERR_INVALID_STATE"
							) {
								console.log(
									`[UnifiedServer:${config.name}] Controller closed during sendEvent, stopping stream`,
								);
								isControllerOpen = false;
							} else {
								throw error;
							}
						}
					};

					// Helper to safely close the controller
					const safeClose = () => {
						if (isControllerOpen) {
							isControllerOpen = false;
							try {
								controller.close();
							} catch (_error) {
								// Already closed, ignore
								console.log(
									`[UnifiedServer:${config.name}] Controller already closed`,
								);
							}
						}
					};

					// Start SSE keepalive heartbeat to prevent proxy idle timeouts
					// during long LLM generations. SSE comments (lines starting
					// with ':') are ignored by AG-UI / CopilotKit clients.
					keepaliveInterval = setInterval(() => {
						if (!safeEnqueue(encoder.encode(":keepalive\n\n"))) {
							// Client disconnected — stop firing into the void
							clearInterval(keepaliveInterval);
							keepaliveInterval = undefined;
						}
					}, 15_000); // every 15s — aggressive to survive multi-layer proxies

					try {
						// Send RUN_STARTED
						sendEvent({
							type: "RUN_STARTED",
							threadId,
							runId,
						});

						// Generate a unique message ID for this response
						const messageId = `msg_${Date.now()}`;
						let hasStartedMessage = false;
						let hasEmittedToolCalls = false;
						// Names, not just the boolean: when a run ends having
						// emitted tool calls and no text, the names are the only
						// thing that distinguishes "CopilotKit is about to run
						// this" from "nobody on the client can run this". See the
						// warning at the end of this branch.
						const emittedToolCallNames = new Set<string>();
						// Track emitted text messages to avoid duplicates across STATE_SNAPSHOTs
						const emittedTextMessageKeys = new Set<string>();

						// Use platform streaming if available
						if (platformStreamAgent) {
							const generator = platformStreamAgent(
								{ messages, ...body },
								runtimeConfig,
							);

							// Track final state for final snapshot
							let finalState: Record<string, unknown> = {};

							// Coalesces interim STATE_SNAPSHOT events derived from a
							// `droppable` generator event (per-token predictive-state
							// previews) when the client isn't draining the stream. A
							// STATE_SNAPSHOT from a regular (non-droppable) node update,
							// and every other event type — TOOL_CALL, RUN_*, message,
							// interrupt — is never gated and must all be delivered.
							const snapshotGate = new CoalescingEventGate<
								Record<string, unknown>
							>({
								warn: (msg, meta) =>
									console.warn(
										`[UnifiedServer:${config.name}] ${msg}`,
										meta,
									),
							});

							// Every non-gated sendEvent call inside the streaming loop
							// below must route through this so a pending coalesced
							// snapshot is never delivered AFTER an event derived from
							// newer state (e.g. a STATE_SNAPSHOT held under backpressure
							// arriving after the TOOL_CALL events built from the state
							// that superseded it).
							const sendEventWithBarrier = (
								event: Record<string, unknown>,
							) => {
								const pending = snapshotGate.flush();
								if (pending !== null) {
									sendEvent(pending);
								}
								sendEvent(event);
							};

							let currentStep: string | null = null;

							// Helper to handle step transitions. Routed through
							// sendEventWithBarrier (not sendEvent) — a step boundary is
							// itself state-derived, so a pending droppable preview from
							// the step being closed must be flushed before STEP_FINISHED,
							// never delivered after STEP_STARTED for the next step.
							const transitionStep = (newStep: string | null) => {
								// Finish current step if one is active
								if (currentStep && currentStep !== newStep) {
									sendEventWithBarrier({
										type: "STEP_FINISHED",
										stepName: currentStep,
									});
								}
								// Start new step if provided and different from current
								if (
									newStep &&
									newStep !== currentStep &&
									newStep !== "__start__" &&
									newStep !== "__end__"
								) {
									sendEventWithBarrier({
										type: "STEP_STARTED",
										stepName: newStep,
									});
								}
								currentStep = newStep;
							};

							// Track emitted tool calls to avoid duplicates across STATE_SNAPSHOT events
							// Pre-populate with tool call IDs from INPUT messages to avoid re-emitting historical tool calls
							const emittedToolCalls = new Set<string>();

							// Also collect tool_call_ids from ToolMessages to mark those tool calls as already responded to
							const respondedToolCallIds = new Set<string>();

							// Extract tool call IDs from input messages (these are historical, don't re-emit)
							// CopilotKit uses camelCase (toolCalls), LangChain uses snake_case (tool_calls)
							for (const msg of messages as Array<
								Record<string, unknown>
							>) {
								// Check for tool messages (responses) - mark those tool calls as handled
								const msgType = (
									(msg.type as string) ||
									(msg.role as string) ||
									""
								).toLowerCase();
								if (msgType === "tool") {
									const toolCallId =
										(msg.tool_call_id as string) ||
										(msg.toolCallId as string);
									if (toolCallId) {
										respondedToolCallIds.add(toolCallId);
										// Also add to emittedToolCalls since it's already been handled
										emittedToolCalls.add(toolCallId);
									}
								}

								// Check both camelCase (toolCalls) and snake_case (tool_calls)
								const toolCalls = (msg.tool_calls ||
									msg.toolCalls) as
									| Array<Record<string, unknown>>
									| undefined;
								if (toolCalls && Array.isArray(toolCalls)) {
									for (const tc of toolCalls) {
										const tcId = tc.id as string;
										if (tcId) {
											emittedToolCalls.add(tcId);
										}
									}
								}
							}

							console.log(
								`[UnifiedServer:${config.name}] Pre-populated emittedToolCalls:`,
								{
									totalToolCallIds: emittedToolCalls.size,
									respondedToolCallIds:
										respondedToolCallIds.size,
									toolCallIds: Array.from(
										emittedToolCalls,
									).slice(0, 10), // Log first 10
								},
							);

							for await (const event of generator) {
								// Handle step transitions based on node name
								if (event.nodeName) {
									transitionStep(event.nodeName);
								}

								// Convert LangGraph platform events to AG-UI events
								if (event.state) {
									// Sanitize state for CopilotKit compatibility
									// This converts LangChain messages to the format CopilotKit expects
									// and preserves tool_calls for renderAndWaitForResponse actions
									const sanitizedState =
										sanitizeStateForCopilotKitWithLog(
											event.state,
										);

									// Update final state with sanitized version
									finalState = {
										...finalState,
										...sanitizedState,
									};

									// Log the state update being sent (verbose for debugging)
									console.log(
										`[UnifiedServer:${config.name}] Sending STATE_SNAPSHOT:`,
										{
											runId,
											threadId,
											nodeName: event.nodeName,
											hasDocument:
												!!sanitizedState.document,
											documentLength:
												(
													sanitizedState.document as string
												)?.length || 0,
											hasStreamingContent:
												!!sanitizedState.streamingContent,
											streamingContentLength:
												(
													sanitizedState.streamingContent as string
												)?.length || 0,
											stateKeys:
												Object.keys(sanitizedState),
										},
									);

									// State updates become STATE_SNAPSHOT
									// CopilotKit's useCoAgent uses this for document/state updates
									// Include nodeName for frontend node tracking (used by useCoAgent's nodeName)
									const snapshotEvent = {
										type: "STATE_SNAPSHOT",
										snapshot: sanitizedState,
										// Include node name for frontend tracking
										nodeName: event.nodeName,
									};
									if (event.droppable === true) {
										for (const ev of snapshotGate.offer(
											snapshotEvent,
											controller.desiredSize,
										)) {
											sendEvent(ev);
										}
									} else {
										// A snapshot derived from a regular (non-preview)
										// node update is a delta the frontend must see —
										// flush any pending preview first to preserve
										// ordering, then deliver this one directly.
										sendEventWithBarrier(snapshotEvent);
									}

									// Emit TOOL_CALL events for frontend actions to trigger useCopilotAction handlers
									// Backend tools (write_document_local, enhance_prompt_local, apply_document_patches)
									// use predict_state streaming or server-side assembly and must NOT be emitted to
									// the frontend — their results flow via state.document/STATE_SNAPSHOT instead.
									// Track emitted tool calls to avoid duplicates across multiple STATE_SNAPSHOTs
									const BACKEND_TOOLS = [
										// Document-editing tools whose results flow via state.document
										"write_document_local",
										"apply_document_patches",
										"enhance_prompt_local",
										// Server-side tools (executed by tool_node, not frontend).
										// Every server-side tool from project-document-generator's
										// tool-node.ts must appear here, otherwise the raw tool call
										// leaks to the frontend and confuses the CopilotKit runtime.
										"search_project_knowledge",
										// Microsoft Teams tools
										"search_teams_messages",
										"get_chat_messages",
										"get_full_message",
										"list_message_replies",
										"list_linked_chats",
										"list_linked_channels",
										"get_teams_channel_messages",
										"get_message_hosted_content",
										// Slack tools
										"search_slack_messages",
										"get_channel_messages",
										// Repository code search tools
										"search_repository_code",
										"get_repository_file",
										"list_repository_structure",
									];

									if (
										Array.isArray(sanitizedState.messages)
									) {
										const allMessages =
											sanitizedState.messages as Array<
												Record<string, unknown>
											>;

										// Find the LAST AI text message from the CURRENT turn only
										// We must not re-emit AI text from previous conversation turns.
										// To identify the current turn boundary, find the last human message
										// and only look for AI text AFTER it.
										// NOTE: We use emittedTextMessageKeys (not hasStartedMessage) to
										// de-duplicate, so that follow-up AI responses after tool execution
										// are emitted as new messages.
										{
											// Find the last human message index (current turn boundary)
											let lastHumanIndex = -1;
											for (
												let i = allMessages.length - 1;
												i >= 0;
												i--
											) {
												const mType =
													(allMessages[i]
														.type as string) || "";
												if (mType === "human") {
													lastHumanIndex = i;
													break;
												}
											}

											let lastAiContent: string | null =
												null;
											for (
												let i = allMessages.length - 1;
												i > lastHumanIndex;
												i--
											) {
												const m = allMessages[i];
												const mType =
													(m.type as string) || "";
												const mContent =
													extractStringContent(
														m.content,
													) || undefined;
												if (
													mType === "ai" &&
													mContent &&
													mContent.trim()
												) {
													lastAiContent = mContent;
													break;
												}
											}

											if (lastAiContent) {
												const msgKey = `${lastAiContent.slice(0, 50)}_${lastAiContent.length}`;
												if (
													!emittedTextMessageKeys.has(
														msgKey,
													)
												) {
													emittedTextMessageKeys.add(
														msgKey,
													);

													console.log(
														`[UnifiedServer:${config.name}] Emitting TEXT_MESSAGE events for AI text response:`,
														{
															contentLength:
																lastAiContent.length,
															contentPreview:
																lastAiContent.slice(
																	0,
																	100,
																),
															isFollowUp:
																hasStartedMessage,
														},
													);

													// Keep a single open message for the entire run.
													// Appending follow-up content (after tool execution)
													// to the same message keeps CopilotKit's isLoading=true
													// so users can't type while the agent is still working.
													if (!hasStartedMessage) {
														sendEventWithBarrier({
															type: "TEXT_MESSAGE_START",
															messageId,
															role: "assistant",
														});
													} else {
														// Visual separator between initial text and follow-up
														sendEventWithBarrier({
															type: "TEXT_MESSAGE_CONTENT",
															messageId,
															delta: "\n\n",
														});
													}

													sendEventWithBarrier({
														type: "TEXT_MESSAGE_CONTENT",
														messageId,
														delta: lastAiContent,
													});

													hasStartedMessage = true;
												}
											}
										}

										// Emit TOOL_CALL events for frontend actions
										for (const msg of allMessages) {
											const hasToolCalls =
												msg.tool_calls &&
												Array.isArray(msg.tool_calls) &&
												(msg.tool_calls as unknown[])
													.length > 0;
											if (hasToolCalls) {
												for (const toolCall of msg.tool_calls as Array<
													Record<string, unknown>
												>) {
													const toolName =
														(toolCall.name as string) ||
														((
															toolCall.function as Record<
																string,
																unknown
															>
														)?.name as string);
													const toolId =
														(toolCall.id as string) ||
														`tool_${Date.now()}`;
													const toolArgs =
														(toolCall.args as Record<
															string,
															unknown
														>) ||
														(
															toolCall.function as Record<
																string,
																unknown
															>
														)?.arguments;

													// Emit for frontend actions (anything that's not a backend streaming tool)
													if (
														toolName &&
														!BACKEND_TOOLS.includes(
															toolName,
														)
													) {
														// Use a module-level Set to track emitted tool calls per run
														if (
															!emittedToolCalls.has(
																toolId,
															)
														) {
															emittedToolCalls.add(
																toolId,
															);

															console.log(
																`[UnifiedServer:${config.name}] Emitting TOOL_CALL events for frontend action:`,
																{
																	toolId,
																	toolName,
																	hasArgs:
																		!!toolArgs,
																},
															);

															sendEventWithBarrier(
																{
																	type: "TOOL_CALL_START",
																	toolCallId:
																		toolId,
																	toolCallName:
																		toolName,
																},
															);

															// Send the actual tool arguments
															const argsString =
																typeof toolArgs ===
																"string"
																	? toolArgs
																	: JSON.stringify(
																			toolArgs ||
																				{},
																		);
															sendEventWithBarrier(
																{
																	type: "TOOL_CALL_ARGS",
																	toolCallId:
																		toolId,
																	delta: argsString,
																},
															);

															sendEventWithBarrier(
																{
																	type: "TOOL_CALL_END",
																	toolCallId:
																		toolId,
																},
															);

															hasEmittedToolCalls = true;
															emittedToolCallNames.add(
																toolName,
															);
														}
													}
												}
											}
										}
									}
								}

								// If this is the final event from a node, transition to null (close step)
								if (event.isFinal && event.nodeName) {
									transitionStep(null);
								}
							}

							// Flush any coalesced interim STATE_SNAPSHOT before the
							// terminal snapshot / run-finished events below.
							const pendingSnapshot = snapshotGate.flush();
							if (pendingSnapshot !== null) {
								sendEvent(pendingSnapshot);
							}

							// Make sure to close any remaining step
							transitionStep(null);

							// Always emit a terminal STATE_SNAPSHOT with nodeName "end".
							// useCoAgent uses this to detect run completion; skipping it on
							// turns without document payload (e.g. post-confirmation
							// acknowledgments) leaves the frontend waiting until the
							// browser times out.
							// Merge incoming body.state so client-managed fields
							// (projectId, organizationId, promptId, ...) survive the
							// snapshot — useCoAgent replaces state from this payload.
							const terminalSnapshot = buildTerminalSnapshot(
								body.state,
								finalState,
							);
							console.log(
								`[UnifiedServer:${config.name}] Sending final STATE_SNAPSHOT:`,
								{
									runId,
									threadId,
									documentLength:
										(terminalSnapshot.document as string)
											?.length ||
										(
											terminalSnapshot.streamingContent as string
										)?.length ||
										0,
									nodeName: "end",
									stateKeys: Object.keys(terminalSnapshot),
								},
							);
							sendEvent({
								type: "STATE_SNAPSHOT",
								snapshot: terminalSnapshot,
								nodeName: "end",
							});
							// A terminal graph error MUST reach the user, even mid
							// tool-loop. Graph nodes report fatal errors by
							// returning `goto: END` with `error` set rather than
							// throwing, so the RUN_ERROR catch below never fires
							// for them, and the generic fallback further down is
							// skipped whenever frontend tool calls were emitted.
							// Without this branch such a run ends as
							// STATE_SNAPSHOT + RUN_FINISHED with no assistant
							// turn at all: the spinner resolves, nothing is
							// rendered, and nothing is persisted to the
							// transcript. Nothing on the client reads `error` off
							// the state snapshot, so this event is the only thing
							// the user ever sees.
							//
							// PREFER `response` OVER `error`. Several agents
							// (data-analyst, api-agent) deliberately keep the raw
							// exception in `error` for logs and put the
							// user-safe explanation in `response`. Rendering
							// `error` unconditionally would publish internal
							// failure detail into durable chat history, so the
							// friendly copy wins whenever the graph supplied one.
							const rawTerminalError =
								typeof finalState.error === "string" &&
								finalState.error.trim()
									? finalState.error.trim()
									: null;
							const terminalResponse =
								typeof finalState.response === "string" &&
								finalState.response.trim()
									? finalState.response.trim()
									: null;
							const terminalError = rawTerminalError
								? (terminalResponse ?? rawTerminalError)
								: null;
							// Same key shape the streaming path uses, so an error
							// the graph already surfaced as AI text isn't shown
							// twice.
							const terminalErrorKey = terminalError
								? `${terminalError.slice(0, 50)}_${terminalError.length}`
								: null;

							if (
								terminalError &&
								terminalErrorKey &&
								!emittedTextMessageKeys.has(terminalErrorKey)
							) {
								emittedTextMessageKeys.add(terminalErrorKey);
								console.log(
									`[UnifiedServer:${config.name}] Emitting terminal error as TEXT_MESSAGE:`,
									{
										hasEmittedToolCalls,
										hasStartedMessage,
										usedFriendlyResponse:
											terminalError === terminalResponse,
										errorPreview: terminalError.slice(
											0,
											200,
										),
									},
								);
								// A graph can stream an assistant preamble and
								// THEN fail; append to that message rather than
								// dropping the error on the floor.
								if (!hasStartedMessage) {
									sendEvent({
										type: "TEXT_MESSAGE_START",
										messageId,
										role: "assistant",
									});
								} else {
									sendEvent({
										type: "TEXT_MESSAGE_CONTENT",
										messageId,
										delta: "\n\n",
									});
								}
								sendEvent({
									type: "TEXT_MESSAGE_CONTENT",
									messageId,
									delta: terminalError,
								});
								hasStartedMessage = true;
							} else if (
								// Fallback: if no TEXT_MESSAGE was emitted during streaming,
								// check finalState.messages one last time for AI text from the current turn.
								// This handles cases where the model was in a tool-calling loop and either:
								// (a) produced text on the very last state snapshot, or
								// (b) hit the recursion limit without producing text at all.
								// Skip fallback if tool calls were emitted — CopilotKit will handle
								// the tool execution and follow-up agent invocation.
								!hasStartedMessage &&
								!hasEmittedToolCalls &&
								finalState.messages &&
								Array.isArray(finalState.messages)
							) {
								const allMsgs = finalState.messages as Array<
									Record<string, unknown>
								>;

								// Find last human message (current turn boundary)
								let lastHumanIdx = -1;
								for (let i = allMsgs.length - 1; i >= 0; i--) {
									const mType =
										(allMsgs[i].type as string) || "";
									if (mType === "human") {
										lastHumanIdx = i;
										break;
									}
								}

								// Look for AI text after last human
								let fallbackContent: string | null = null;
								for (
									let i = allMsgs.length - 1;
									i > lastHumanIdx;
									i--
								) {
									const m = allMsgs[i];
									const mType = (m.type as string) || "";
									const mContent =
										extractStringContent(m.content) || "";
									if (mType === "ai" && mContent.trim()) {
										fallbackContent = mContent;
										break;
									}
								}

								if (fallbackContent) {
									console.log(
										`[UnifiedServer:${config.name}] Emitting fallback TEXT_MESSAGE from final state:`,
										{
											contentLength:
												fallbackContent.length,
											contentPreview:
												fallbackContent.slice(0, 100),
										},
									);
									sendEvent({
										type: "TEXT_MESSAGE_START",
										messageId,
										role: "assistant",
									});
									sendEvent({
										type: "TEXT_MESSAGE_CONTENT",
										messageId,
										delta: fallbackContent,
									});
									hasStartedMessage = true;
								} else {
									// No AI text at all - send a generic fallback
									console.log(
										`[UnifiedServer:${config.name}] No AI text response found, sending fallback message`,
									);
									sendEvent({
										type: "TEXT_MESSAGE_START",
										messageId,
										role: "assistant",
									});
									sendEvent({
										type: "TEXT_MESSAGE_CONTENT",
										messageId,
										delta: EMPTY_RESPONSE_FALLBACK,
									});
									hasStartedMessage = true;
								}
							}

							// The one way a run still ends with nothing on
							// screen. The fallback above is deliberately skipped
							// when tool calls were emitted, because CopilotKit is
							// expected to execute the tool and invoke us again —
							// and when it can, staying quiet is right. When it
							// cannot, because no handler for that tool is
							// registered on the surface that asked, there is no
							// follow-up, no text and no error: the user gets an
							// empty turn and we get a report saying the assistant
							// "returned nothing".
							//
							// Both cases look identical here, so this does not
							// guess between them — emitting the fallback text
							// unconditionally would put "I wasn't able to
							// generate a response" on top of every healthy
							// tool-calling turn. It records the tool names
							// instead, which is what tells the two apart after
							// the fact, and which the logs currently do not
							// contain at all.
							//
							// Logged at info, not warn, and worded neutrally:
							// this condition is the exact negation of the
							// fallback-skip above, so it is reached by the
							// ORDINARY tool-calling turn as well as the broken
							// one, on all eight servers built from here. A warn
							// on the healthy path is a false alarm — it would
							// burn an alerting budget and, worse, stop the line
							// meaning anything when it does matter.
							if (!hasStartedMessage && hasEmittedToolCalls) {
								console.log(
									`[UnifiedServer:${config.name}] Run finished with tool calls and no assistant text; the turn is empty unless CopilotKit executes one of these:`,
									{
										toolNames: [...emittedToolCallNames],
										messageId,
									},
								);
							}
						} else if (streamAgent) {
							// Use basic streaming
							const generator = streamAgent({
								messages,
								...body,
							});

							for await (const chunk of generator) {
								if (!hasStartedMessage) {
									sendEvent({
										type: "TEXT_MESSAGE_START",
										messageId,
										role: "assistant",
									});
									hasStartedMessage = true;
								}

								if (chunk.content) {
									sendEvent({
										type: "TEXT_MESSAGE_CONTENT",
										messageId,
										delta: chunk.content,
									});
								}
							}
						} else {
							// Non-streaming fallback
							const result = await invokeAgent({
								messages,
								...body,
							});

							sendEvent({
								type: "TEXT_MESSAGE_START",
								messageId,
								role: "assistant",
							});

							const content =
								result.document ||
								result.streamingContent ||
								result.response ||
								"";
							if (content) {
								sendEvent({
									type: "TEXT_MESSAGE_CONTENT",
									messageId,
									delta: content as string,
								});
							}
							hasStartedMessage = true;
						}

						// Send TEXT_MESSAGE_END if we started a message
						if (hasStartedMessage) {
							sendEvent({
								type: "TEXT_MESSAGE_END",
								messageId,
							});
						}

						// Send RUN_FINISHED
						sendEvent({
							type: "RUN_FINISHED",
							threadId,
							runId,
						});

						safeClose();
					} catch (error) {
						// Only log if it's not an expected controller closed error
						if (
							(error as NodeJS.ErrnoException).code !==
							"ERR_INVALID_STATE"
						) {
							console.error(
								`[UnifiedServer:${config.name}] AG-UI / stream error:`,
								error,
							);
						} else {
							console.log(
								`[UnifiedServer:${config.name}] Stream ended (client disconnected)`,
							);
						}
						sendEvent({
							type: "RUN_ERROR",
							message:
								error instanceof Error
									? error.message
									: "Unknown error",
						});
						safeClose();
					} finally {
						clearInterval(keepaliveInterval);
						keepaliveInterval = undefined;
					}
				},
				cancel() {
					// Called when the client disconnects — clears the heartbeat
					if (keepaliveInterval !== undefined) {
						clearInterval(keepaliveInterval);
						keepaliveInterval = undefined;
					}
				},
			});

			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		} catch (error) {
			console.error(
				`[UnifiedServer:${config.name}] Error in AG-UI / handler:`,
				error,
			);
			return c.json(
				{
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
				500,
			);
		}
	});

	// Health check (A2A style - also works for general health)
	app.get("/health", (c: Context) => {
		return c.json({
			status: "healthy",
			agent: config.name,
			protocols: ["ag-ui", "a2a"],
			version: config.protocolVersion || "0.3.0",
		});
	});

	// Prometheus scrape endpoint.
	// Ungated by app auth so the Prometheus scraper can reach it; production
	// access is restricted at the network layer via Bicep ingress rules.
	app.get("/metrics", async (c: Context) => {
		try {
			// Dynamic import — observability is already loaded as a dynamic
			// dep below; keep the metrics route resilient to OTEL bundling
			// issues by importing on first request.
			const { register } = await import("@repo/observability");
			const body = await register.metrics();
			c.header(
				"Content-Type",
				register.contentType ?? "text/plain; version=0.0.4",
			);
			return c.body(body);
		} catch (error) {
			return c.text(
				`failed to collect metrics: ${
					error instanceof Error ? error.message : "unknown"
				}`,
				500,
			);
		}
	});

	// Start function
	const start = async () => {
		// Initialize OpenTelemetry observability (traces, metrics, logs to Aspire Dashboard)
		// Dynamic import to avoid bundling issues with Turbopack
		try {
			const { initObservability } = await import("@repo/observability");
			initObservability({
				serviceName: config.name,
				serviceVersion: "1.0.0",
				environment: process.env.NODE_ENV,
			});
		} catch (error) {
			console.warn(
				"[UnifiedServer] Could not initialize observability:",
				error instanceof Error ? error.message : error,
			);
		}

		const host = config.host || "0.0.0.0";
		console.log(
			`[UnifiedServer] Starting ${config.name} on ${host}:${config.port}`,
		);
		console.log(
			"[UnifiedServer] LangGraph Platform API: /runs/stream, /threads/:threadId/runs/stream, /runs, /threads/:threadId/runs",
		);
		console.log(
			"[UnifiedServer] AG-UI endpoints: /, /invoke, /stream, /ok (root / is for LangGraphHttpAgent)",
		);
		console.log("[UnifiedServer] CopilotKit endpoints: /info, /run");
		console.log(
			"[UnifiedServer] A2A endpoints: /.well-known/agent.json, /a2a/send, /health",
		);

		serve({
			fetch: app.fetch,
			hostname: host,
			port: config.port,
		});
	};

	return { app, start };
}
