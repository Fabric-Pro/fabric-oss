/**
 * Run Agent Iteration Activity
 *
 * Executes a single iteration of the agent loop in iterative mode.
 * The LLM decides what to do next: call tools or return a final response.
 *
 * This is the core of the iterative execution pattern - instead of planning
 * all steps upfront, the LLM sees the current conversation state and decides
 * the next action based on actual results from previous iterations.
 */

import { jsonSchema, stepCountIs, streamText, tool } from "@repo/ai";
import { getModelCapabilities } from "@repo/ai/capabilities";
import { classifyLimitError, type LimitSignal } from "@repo/ai/limits";
import {
	buildSkillsSystemBlock,
	createSkillTools,
	listAvailableSkills,
} from "@repo/ai/skills";
import { heartbeat } from "@temporalio/activity";
import { publishExecutionEvent } from "../../../lib/redis-publisher";
import type { IterativeMessage } from "../../../workflows/orchestrator/types";
import type { OrchestratorHeartbeatDetails } from "../types";
import { getAiModel } from "../utils";
import {
	resolveImageAttachments,
	spliceImagePartsIntoLastUserMessage,
} from "./vision-image-attachments";

function sanitizeProviderError(message: string): string {
	return message
		.replace(/https?:\/\/\S+/g, "[endpoint]")
		.replace(/sk-\S+/g, "[key]")
		.replace(/api-key:\s*\S+/gi, "api-key: [redacted]")
		.replace(/bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/authorization:\s*\S+/gi, "Authorization: [redacted]");
}

function detectRequestedFrameOutput(
	message: string,
): "frame" | "slideshow" | null {
	const lower = message.toLowerCase();
	const slideshowPatterns = [
		"slideshow",
		"slide deck",
		"slide-deck",
		"presentation",
		"presentation deck",
		"deck",
		"5-slide",
		"5 slide",
		"slides",
	];
	if (slideshowPatterns.some((pattern) => lower.includes(pattern))) {
		return "slideshow";
	}

	const framePatterns = [
		"create a frame",
		"make a frame",
		"build a frame",
		"interactive frame",
		"fabric frame",
		"wireframe",
		"dashboard",
		// Visualization / chart / dashboard
		"create a visualization",
		"make a visualization",
		"generate a visualization",
		"build a visualization",
		"data visualization",
		"interactive visualization",
		"visualize",
		"create a chart",
		"make a chart",
		"generate a chart",
		"build a chart",
		"interactive chart",
		"create a graph",
		"make a graph",
		"interactive graph",
		"create a dashboard",
		"make a dashboard",
		"build a dashboard",
		"interactive dashboard",
	];
	if (framePatterns.some((pattern) => lower.includes(pattern))) {
		return "frame";
	}

	return null;
}

/**
 * Tool call from LLM response
 */
export interface AgentToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** Provider-specific metadata (e.g. Gemini thoughtSignature) */
	providerMetadata?: Record<string, unknown>;
}

/**
 * Result of a single agent iteration
 */
export type AgentIterationResult =
	| {
			type: "response";
			content: string;
			usage: {
				inputTokens: number;
				outputTokens: number;
			};
			/**
			 * Populated when the LLM call aborted due to a provider-side limit
			 * (rate limit, quota, context length, overloaded). The iteration
			 * still returns a "response" so the workflow can soft-degrade, but
			 * the UI uses this to show a banner / toast.
			 */
			limitSignal?: LimitSignal;
	  }
	| {
			type: "tool_calls";
			toolCalls: AgentToolCall[];
			usage: {
				inputTokens: number;
				outputTokens: number;
			};
	  }
	/**
	 * The provider/gateway emitted a transient stream error (e.g. malformed
	 * tool_use, gateway 5xx) and the in-activity retry has already been spent.
	 * Callers MUST NOT persist `message` as an assistant turn — doing so
	 * poisons conversation history and re-feeds the error to the model on
	 * every subsequent turn. Surface it out-of-band (failed workflow status,
	 * SSE error event) and skip history mutation.
	 */
	| {
			type: "stream_error";
			message: string;
			partialResponse: string;
			usage: {
				inputTokens: number;
				outputTokens: number;
			};
	  };

/**
 * Input for the agent iteration activity
 */
export interface RunAgentIterationInput {
	/** Conversation history including user message and previous tool results */
	conversationHistory: IterativeMessage[];
	/** Available tools in AI SDK format */
	availableTools: Record<string, unknown>;
	/** System prompt with context */
	systemPrompt: string;
	/** User ID for model resolution */
	userId: string;
	/** Organization ID for tenant-aware model resolution */
	organizationId?: string;
	/** Execution ID for tracking */
	executionId: string;
	/** Current iteration number */
	iteration: number;
	/** Max steps within this iteration (for multi-tool scenarios) */
	maxStepsPerIteration?: number;
	/** Explicit model override - bypasses task-type model resolution */
	modelOverride?: string;
	/**
	 * Whether to auto-expose Anthropic Agent Skills (list_skills / load_skill /
	 * read_skill_file) on this iteration. Default: true. Callers that must
	 * force a pure text response (e.g. the synthesis phase that passes
	 * `availableTools: {}`) should set this to false — otherwise the skill
	 * tools would be bound anyway, the model might emit tool_calls, and the
	 * caller's `type === "response"` check would fall back to
	 * "Unable to generate synthesis."
	 */
	enableSkillTools?: boolean;
	/**
	 * Tool names to drop from the final `aiSdkTools` map handed to
	 * `streamText`. Defense in depth for surface-aware routing helpers
	 * (e.g. the default-MCP eager router) that already remove the names from
	 * `availableTools` at the workflow layer — this guarantees the LLM
	 * cannot call them even if a future caller forgets the workflow-side
	 * filter. Also forces `toolChoice` to back off to "auto" when the
	 * prompt-heuristic-derived `forcedFrameToolName` is in this set;
	 * forcing a name absent from the map throws a no-tool error.
	 *
	 * Default = no suppression (empty list). Non-Nexus paths see no
	 * change in behavior.
	 */
	suppressedToolNames?: string[];
	/**
	 * Chat-document IDs attached to the user's message. Image-typed documents
	 * among these are resolved to bytes and spliced onto the last user message
	 * for vision-capable models, so the model SEES the pixels. The orchestrator
	 * forwards these only on the first iteration; non-vision models fall back to
	 * the RAG-extracted image description.
	 */
	attachedDocumentIds?: string[];
}

/**
 * Raw tool definition from preloaded resources
 */
interface RawToolDefinition {
	description: string;
	inputSchema: Record<string, unknown>;
}

/**
 * Convert raw tool definitions to AI SDK format
 *
 * Uses jsonSchema() from the AI SDK to accept raw JSON Schema directly.
 * This is more robust than Zod conversion and handles any valid JSON Schema,
 * including complex schemas with arrays, nested objects, anyOf, etc.
 */
function convertToolsToAiSdkFormat(
	rawTools: Record<string, unknown>,
): Record<string, unknown> {
	const aiSdkTools: Record<string, unknown> = {};

	for (const [toolName, rawTool] of Object.entries(rawTools)) {
		// Check if this is a raw tool definition or already an AI SDK tool
		const toolDef = rawTool as RawToolDefinition | { execute?: unknown };

		// If it already has an execute function, it's likely already in AI SDK format
		if ("execute" in toolDef && typeof toolDef.execute === "function") {
			aiSdkTools[toolName] = rawTool;
			continue;
		}

		// Convert raw definition to AI SDK tool using jsonSchema() for robustness
		// jsonSchema() accepts any valid JSON Schema without Zod conversion,
		// preventing silent tool drops when schemas are complex (arrays, anyOf, $ref, etc.)
		if ("description" in toolDef) {
			const rawSchema = (toolDef as RawToolDefinition).inputSchema || {};
			// Unwrap MCP protocol's jsonSchema wrapper if present
			const unwrapped =
				rawSchema.jsonSchema && typeof rawSchema.jsonSchema === "object"
					? (rawSchema.jsonSchema as Record<string, unknown>)
					: rawSchema;

			// Ensure OpenAI-compatible object schema: must have type="object" and properties
			// (OpenAI rejects schemas that are {} or { type: "object" } without properties)
			const schemaToUse: Record<string, unknown> = {
				type: "object",
				properties: {},
				...unwrapped,
			};
			if (!schemaToUse.properties) {
				schemaToUse.properties = {};
			}

			// Patch create_view: the MCP server schema may be missing entirely (when
			// discovered via vector search with no cached inputSchema) or may declare
			// elements as { type: "string" } which the AI SDK strips when the LLM
			// generates an array — resulting in args: {} reaching executeMcpTool.
			// Always inject elements as a required array; normalizeExcalidrawCreateViewArgs()
			// in execute-mcp-tool.ts converts it to a JSON string before the MCP call.
			if (toolName === "create_view") {
				const props = schemaToUse.properties as Record<
					string,
					Record<string, unknown>
				>;
				props.elements = {
					type: "array",
					items: { type: "object" },
					description:
						"Array of Excalidraw element objects. Each element MUST have: type, id (unique string), x, y, width, height. " +
						"To add text inside a shape: label: {text: 'My Label', fontSize: 16} — works on rectangle, ellipse, diamond, arrow. " +
						"Types: 'rectangle', 'ellipse', 'diamond', 'arrow' (needs points:[[0,0],[dx,dy]]), 'text' (needs text field, NOT label). " +
						"Optional: backgroundColor, strokeColor, strokeWidth, roughness (0=clean 1=hand-drawn), roundness:{type:3} for rounded corners. " +
						"Colors: '#dbe4ff'=blue '#d3f9d8'=green '#f3d9fa'=purple '#fff3bf'=yellow '#e7f5ff'=light-blue '#ebfbee'=light-green. " +
						"Always start with: {type:'cameraUpdate', width:800, height:600, x:0, y:0}.",
				};
				const req = schemaToUse.required as string[] | undefined;
				if (!req) {
					schemaToUse.required = ["elements"];
				} else if (!req.includes("elements")) {
					req.push("elements");
				}
			}

			const isCreateView = toolName === "create_view";
			const baseDescription =
				(toolDef as RawToolDefinition).description || toolName;
			const toolDescription = isCreateView
				? `${baseDescription}

CRITICAL QUALITY RULES:
1. Create 15-30+ elements. Never 3-5 bare unlabeled boxes.
2. NODE rectangles/ellipses/diamonds MUST use label:{text:"...",fontSize:16} for text inside them.
3. CONTAINER zones (large background rects) use a separate text element for their title at top-left — NOT label, because label centers and overlaps nodes inside the container.
4. Structure: CONTAINER rect (w:820 h:200, strokeWidth:1), TEXT title at top-left of container, NODE rects (w:160 h:60) with labels, ARROWs between tiers.
5. Colors: Tier1 container=#e7f5ff nodes=#dbe4ff stroke=#4263eb | Tier2 container=#f3f0ff nodes=#f3d9fa stroke=#ae3ec9 | Tier3 container=#ebfbee nodes=#d3f9d8 stroke=#2f9e44

EXAMPLE (container title as text, nodes use label):
{type:"cameraUpdate", width:1200, height:900, x:0, y:0}
{type:"rectangle", id:"c1", x:50, y:50, width:820, height:200, backgroundColor:"#e7f5ff", strokeColor:"#4263eb", strokeWidth:1, opacity:80}
{type:"text", id:"ct1", x:70, y:62, text:"Presentation Tier (Client)", fontSize:16, strokeColor:"#4263eb"}
{type:"rectangle", id:"n1", x:100, y:110, width:160, height:60, backgroundColor:"#dbe4ff", strokeColor:"#4263eb", label:{text:"Web Browser",fontSize:16}}
{type:"rectangle", id:"n2", x:310, y:110, width:160, height:60, backgroundColor:"#dbe4ff", strokeColor:"#4263eb", label:{text:"Mobile App",fontSize:16}}
{type:"rectangle", id:"n3", x:520, y:110, width:160, height:60, backgroundColor:"#dbe4ff", strokeColor:"#4263eb", label:{text:"Desktop App",fontSize:16}}
{type:"arrow", id:"a1", x:460, y:250, width:0, height:80, points:[[0,0],[0,80]], label:{text:"HTTP / REST",fontSize:14}}
— repeat for each tier below (y increments ~280px per tier)`
				: baseDescription;

			aiSdkTools[toolName] = tool({
				description: toolDescription,
				inputSchema: jsonSchema(schemaToUse),
			} as unknown as Parameters<typeof tool>[0]);
		}
	}

	return aiSdkTools;
}

/**
 * AI SDK message content part types
 *
 * Based on AI SDK foundations/prompts.mdx example:
 * - Tool calls use: { type: 'tool-call', toolCallId, toolName, input }
 * - Tool results use: { type: 'tool-result', toolCallId, toolName, output }
 *
 * The output field uses LanguageModelV2ToolResultOutput discriminated union:
 * - { type: 'text', value: string }
 * - { type: 'json', value: JSONValue }
 *
 * See: https://github.com/vercel/ai/blob/main/content/docs/02-foundations/03-prompts.mdx
 */
interface ToolCallPart {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	input: unknown; // AI SDK prompts example uses "input"
	/** Provider-specific options (e.g. Gemini thoughtSignature for thinking models).
	 *  Must be `providerOptions` (not providerMetadata) — the AI SDK reads this field
	 *  from content parts and passes it through to the language model provider. */
	providerOptions?: Record<string, unknown>;
}

/**
 * LanguageModelV2ToolResultOutput type
 */
type ToolResultOutput =
	| { type: "text"; value: string }
	| { type: "json"; value: unknown };

interface ToolResultPart {
	type: "tool-result";
	toolCallId: string;
	toolName: string;
	output: ToolResultOutput;
}

interface TextPart {
	type: "text";
	text: string;
}

type AssistantContent = string | Array<TextPart | ToolCallPart>;
type ToolContent = Array<ToolResultPart>;

interface AiSdkMessage {
	role: "user" | "assistant" | "tool";
	content: string | AssistantContent | ToolContent;
}

/**
 * Build a lookup map from toolCallId to toolName from all assistant messages
 */
function buildToolCallIdToNameMap(
	messages: IterativeMessage[],
): Map<string, string> {
	const map = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role === "assistant" && msg.toolCalls) {
			for (const tc of msg.toolCalls) {
				map.set(tc.id, tc.name);
			}
		}
	}
	return map;
}

/**
 * Convert iterative messages to AI SDK CoreMessage format
 *
 * The AI SDK expects a specific format for messages:
 * - Assistant messages with tool calls: content is an array of { type: 'tool-call', toolCallId, toolName, input }
 * - Tool result messages: content is an array of { type: 'tool-result', toolCallId, toolName, output }
 *   where output is { type: 'json' | 'text', value: ... }
 * - User/text messages: content is a string
 *
 * See: https://github.com/vercel/ai/blob/main/content/docs/02-foundations/03-prompts.mdx
 */
function convertToAiSdkMessages(messages: IterativeMessage[]): AiSdkMessage[] {
	// Build lookup map for tool names (tool messages don't store the tool name)
	const toolCallIdToName = buildToolCallIdToNameMap(messages);

	return messages.map((msg) => {
		// Tool result messages - must use array format with tool-result type
		if (msg.role === "tool") {
			// Parse the content if it's a JSON string, otherwise use as-is
			let resultValue: unknown;
			let isJson = false;
			try {
				resultValue = JSON.parse(msg.content);
				isJson = true;
			} catch {
				resultValue = msg.content;
			}

			// Look up tool name from preceding assistant message
			const toolName =
				toolCallIdToName.get(msg.toolCallId || "") || "unknown";

			// AI SDK expects output with LanguageModelV2ToolResultOutput format
			// See: https://github.com/vercel/ai/issues/8028
			const output: ToolResultOutput = isJson
				? { type: "json", value: resultValue }
				: { type: "text", value: resultValue as string };

			return {
				role: "tool" as const,
				content: [
					{
						type: "tool-result" as const,
						toolCallId: msg.toolCallId || "unknown",
						toolName,
						output,
					},
				],
			};
		}

		// Assistant messages with tool calls - must use array format with tool-call type
		if (
			msg.role === "assistant" &&
			msg.toolCalls &&
			msg.toolCalls.length > 0
		) {
			const contentParts: Array<TextPart | ToolCallPart> = [];

			// Add text content if present
			if (msg.content && msg.content.trim().length > 0) {
				contentParts.push({
					type: "text" as const,
					text: msg.content,
				});
			}

			// Add tool calls
			for (const tc of msg.toolCalls) {
				// Ensure input is always a valid object — the API rejects non-dict values
				let sanitizedArgs: unknown = tc.args;
				if (
					tc.args === null ||
					tc.args === undefined ||
					typeof tc.args !== "object" ||
					Array.isArray(tc.args)
				) {
					try {
						const parsed =
							typeof tc.args === "string"
								? JSON.parse(tc.args)
								: null;
						sanitizedArgs =
							parsed &&
							typeof parsed === "object" &&
							!Array.isArray(parsed)
								? parsed
								: {};
					} catch {
						sanitizedArgs = {};
					}
				}
				contentParts.push({
					type: "tool-call" as const,
					toolCallId: tc.id,
					toolName: tc.name,
					input: sanitizedArgs,
					// Pass through provider options (e.g. Gemini thoughtSignature).
					// The AI SDK reads `providerOptions` from content parts and forwards
					// them to the language model provider (gateway/google/vertex).
					...(tc.providerMetadata && {
						providerOptions: tc.providerMetadata,
					}),
				});
			}

			return {
				role: "assistant" as const,
				content: contentParts,
			};
		}

		// Regular user or assistant text messages
		return {
			role: msg.role as "user" | "assistant",
			content: msg.content,
		};
	});
}

/**
 * Runs a single iteration of the agent loop.
 *
 * The LLM receives:
 * - System prompt with available tools
 * - Conversation history (user message + previous tool calls/results)
 *
 * And returns either:
 * - A final text response (task complete)
 * - Tool calls to execute (task continues)
 *
 * This is the fundamental building block of the iterative execution pattern.
 */
export async function runAgentIteration(
	input: RunAgentIterationInput,
): Promise<AgentIterationResult> {
	const {
		conversationHistory,
		availableTools,
		systemPrompt,
		userId,
		organizationId,
		iteration,
		maxStepsPerIteration = 3,
		modelOverride,
		enableSkillTools = true,
		suppressedToolNames = [],
		attachedDocumentIds = [],
	} = input;

	// Set used by the AI SDK tool-map filter and the toolChoice degrade
	// check below. Empty by default — non-Nexus paths see no behavior
	// change. Locked by `run-agent-iteration.suppression.test.ts`.
	const suppressedToolNameSet = new Set(suppressedToolNames);

	console.log(
		`[AgentIteration] Starting iteration ${iteration}, history length: ${conversationHistory.length}, systemPromptLength: ${systemPrompt.length}`,
	);

	// Send heartbeat to keep workflow alive
	const heartbeatDetails: OrchestratorHeartbeatDetails = {
		stepId: `iteration-${iteration}`,
		stepDescription: `Agent iteration ${iteration}`,
		phase: "executing",
		toolCalls: [],
		timestamp: Date.now(),
	};
	heartbeat(heartbeatDetails);

	// Background heartbeat ticker — defends against pre-stream idle time (LLM
	// first-token latency, gateway cold starts) when chunk-based heartbeats
	// inside the streamText loop haven't fired yet. Fires every 15 s.
	// Declared here, started inside the try block so a setup-phase throw
	// (e.g. model resolution failing) never leaks an interval into the worker.
	const BACKGROUND_HEARTBEAT_INTERVAL_MS = 15_000;
	let backgroundHeartbeatId: ReturnType<typeof setInterval> | undefined;

	// Convert raw tool definitions to AI SDK format up-front so the
	// effective tool count (including any bound skill tools) can drive
	// model resolution below.
	const hasCallerTools = Object.keys(availableTools).length > 0;
	const aiSdkTools: Record<string, unknown> = hasCallerTools
		? convertToolsToAiSdkFormat(availableTools)
		: {};

	// Anthropic Agent Skills: progressive-disclosure registry + read tools.
	// Orchestrator agents (including @mentioned custom agents) can list,
	// load, and read assets from any skill in scope. No write tools here —
	// asset persistence is handled per-surface (doc-gen binds
	// write_document_asset; orchestrator uses fabric_create_frame).
	//
	// Skipped when `enableSkillTools === false`, e.g. the synthesis phase
	// which passes `availableTools: {}` to force a pure text response.
	let skillsSystemBlock: string | null = null;
	if (enableSkillTools) {
		try {
			const availableSkills = await listAvailableSkills({
				userId,
				organizationId,
			});
			if (availableSkills.length > 0) {
				// withExecute: false — tool execution in this surface is
				// deferred to the workflow dispatcher
				// (executeSkillToolActivity). Binding an inline execute
				// handler would cause the AI SDK to auto-run the tool
				// inside streamText AND the workflow to run it again, and
				// would also discard any final text from this same stream.
				Object.assign(
					aiSdkTools,
					createSkillTools(
						{ userId, organizationId },
						{ withExecute: false },
					),
				);
				skillsSystemBlock = buildSkillsSystemBlock(availableSkills);
				console.log(
					`[AgentIteration] ${availableSkills.length} skill(s) in scope`,
				);
			}
		} catch (error) {
			console.warn("[AgentIteration] Skill registry load failed:", error);
		}
	}

	// Defense-in-depth suppression: drop names the workflow phase asked us
	// to keep out of the LLM's tool map. Applied AFTER both caller-supplied
	// tools and inline skill tools have been merged into `aiSdkTools` so
	// the filter catches every source. Locked by
	// `run-agent-iteration.suppression.test.ts`.
	if (suppressedToolNameSet.size > 0) {
		for (const name of suppressedToolNameSet) {
			if (name in aiSdkTools) {
				delete aiSdkTools[name];
			}
		}
		console.log(
			`[AgentIteration] Suppressed ${suppressedToolNameSet.size} tool name(s) from aiSdkTools`,
			{ suppressed: [...suppressedToolNameSet] },
		);
	}

	const aiSdkToolCount = Object.keys(aiSdkTools).length;
	// Resolve the model AFTER the effective tool set is known so a
	// tool-capable model is chosen whenever any tool (caller-supplied or
	// skill) is bound on this call.
	const hasTools = aiSdkToolCount > 0;
	const model = await getAiModel(
		userId,
		organizationId,
		hasTools,
		modelOverride,
	);

	// Convert conversation history to AI SDK format
	const messages = convertToAiSdkMessages(conversationHistory);

	// Vision: when the user attached image documents this turn, show the pixels
	// to vision-capable models by splicing them onto the last user message — so
	// the model SEES the image rather than relying only on its RAG-extracted
	// description. Non-vision models skip this and keep the description fallback.
	// Best-effort: any failure logs and proceeds text-only.
	if (attachedDocumentIds.length > 0) {
		const modelId =
			(model as { modelId?: string }).modelId ?? modelOverride ?? "";
		if (getModelCapabilities(modelId).vision) {
			try {
				const images = await resolveImageAttachments(
					attachedDocumentIds,
					userId,
					organizationId,
				);
				const attached = spliceImagePartsIntoLastUserMessage(
					messages as Array<{ role?: string; content?: unknown }>,
					images,
				);
				if (attached > 0) {
					console.log(
						`[AgentIteration] Attached ${attached} image(s) as vision input for model ${modelId}`,
					);
				}
			} catch (err) {
				console.warn(
					"[AgentIteration] Vision image splice failed — proceeding with RAG description only",
					err,
				);
			}
		} else {
			console.log(
				`[AgentIteration] Model ${modelId} is not vision-capable — using RAG image description`,
			);
		}
	}

	// Debug: Log the last few messages to verify tool results are included
	const lastMessages = messages.slice(-4);
	console.log(
		`[AgentIteration] Last ${lastMessages.length} messages being sent to LLM:`,
		JSON.stringify(lastMessages, null, 2),
	);

	console.log(
		`[AgentIteration] Calling LLM with ${aiSdkToolCount} tools, ${messages.length} messages`,
	);

	try {
		backgroundHeartbeatId = setInterval(() => {
			try {
				heartbeat({
					stepId: `iteration-${iteration}`,
					stepDescription: `Agent iteration ${iteration}`,
					phase: "executing",
					toolCalls: [],
					timestamp: Date.now(),
				});
			} catch {
				// Heartbeat throws outside an activity context; safe to swallow.
			}
		}, BACKGROUND_HEARTBEAT_INTERVAL_MS);

		const latestUserMessage = [...conversationHistory]
			.reverse()
			.find((message) => message.role === "user")?.content;
		const requestedFrameOutput = latestUserMessage
			? detectRequestedFrameOutput(latestUserMessage)
			: null;
		const forcedFrameToolName =
			requestedFrameOutput === "slideshow"
				? "fabric_create_slideshow"
				: requestedFrameOutput === "frame"
					? "fabric_create_frame"
					: undefined;
		// Only force the frame tool on the FIRST call — if a frame was already
		// created successfully in this conversation, revert to "auto" so the LLM
		// can return a final response instead of creating duplicate frames.
		// IterativeMessage stores tool results as JSON-stringified content strings.
		const frameAlreadyCreated = conversationHistory.some((msg) => {
			if (msg.role !== "tool") {
				return false;
			}
			try {
				const parsed = JSON.parse(msg.content);
				return (
					parsed && typeof parsed === "object" && "frameId" in parsed
				);
			} catch {
				return false;
			}
		});
		// If the prompt-heuristic-derived forced tool is in the suppressed
		// set, NEVER force it via toolChoice: the AI SDK throws a no-tool
		// error if `toolChoice.toolName` doesn't exist in `tools`. Fall
		// back to "auto" so the model can use the surface-routed
		// alternative (e.g. Excalidraw `create_view` instead of
		// `fabric_create_frame`). Locked by
		// `run-agent-iteration.suppression.test.ts`.
		//
		// FORWARD GUARD — Anthropic thinking + tool_choice incompat: this
		// orchestrator path currently does NOT pass `providerOptions` to
		// `streamText` below (line ~789), so Anthropic extended thinking
		// is never enabled here and the forced-tool path is safe. If a
		// future commit wires `providerOptions` through (mirroring
		// `direct-chat/ai-execution.ts`), it MUST also route the choice
		// through `decideForcedToolChoice({ thinkingEnabled, ... })` from
		// `packages/temporal/src/activities/direct-chat/decide-forced-tool-choice.ts`
		// — Anthropic rejects `thinking: enabled` paired with
		// `tool_choice: {type:"tool"}` with HTTP 400 (same root cause as
		// PR #1177 chat-node.ts fix).
		const forcedFrameToolNameIsSuppressed =
			forcedFrameToolName !== undefined &&
			suppressedToolNameSet.has(forcedFrameToolName);
		const toolChoice =
			forcedFrameToolName &&
			forcedFrameToolName in aiSdkTools &&
			!forcedFrameToolNameIsSuppressed &&
			!frameAlreadyCreated
				? ({
						type: "tool",
						toolName: forcedFrameToolName,
					} as const)
				: aiSdkToolCount > 0
					? ("auto" as const)
					: undefined;

		// Use streamText to enable real-time text delta publishing via Redis
		// maxTokens set high to allow long outputs (e.g. full HTML pages).
		// Without this the provider default may silently truncate responses.
		const effectiveSystemPrompt = skillsSystemBlock
			? `${systemPrompt}\n\n${skillsSystemBlock}`
			: systemPrompt;

		// Collect response text, tool calls, and errors from the stream.
		// Declared outside the retry loop so the post-loop handlers see the
		// final attempt's state.
		let responseText = "";
		let toolCallsToExecute: AgentToolCall[] = [];
		// Counts provider-reported tool-call defects within a single attempt:
		// an unparsable/unknown tool call (AI SDK marks it `invalid`) or a
		// `tool-error` part. Either means the turn's tool-calling output is
		// corrupted — see the attempt-failure classification below.
		let invalidToolCallCount = 0;
		let toolErrorCount = 0;
		let streamError: string | null = null;
		let resolveError: string | null = null;
		let resolvedUsage:
			| { inputTokens?: number; outputTokens?: number }
			| undefined;
		let finishReason: string | undefined;
		let elapsed = 0;

		// Heartbeat helper - sends progress updates every 2 seconds
		let lastHeartbeatTime = Date.now();
		const HEARTBEAT_INTERVAL_MS = 2000;

		const sendPeriodicHeartbeat = () => {
			const now = Date.now();
			if (now - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
				const hb: OrchestratorHeartbeatDetails = {
					stepId: `iteration-${iteration}`,
					stepDescription: `Agent iteration ${iteration}`,
					phase: "executing",
					toolCalls: [],
					partialResponse: responseText.slice(-500),
					timestamp: now,
				};
				heartbeat(hb);
				lastHeartbeatTime = now;
			}
		};

		// One retry on transient stream errors. Provider/gateway glitches
		// (malformed tool_use, intermittent 5xx, dropped connections) usually
		// self-heal on a re-roll. Limit signals (rate/quota/context) are
		// deterministic and skip retry — they surface as a `response` with a
		// `limitSignal` so the existing soft-degradation path handles them.
		const MAX_STREAM_ATTEMPTS = 2;

		// Aggregates usage across ALL attempts, not just the last one. A
		// defective attempt that gets retried still burned real provider
		// tokens (staging: 13,210 input tokens on the failed attempt before
		// the retry) — the per-attempt reset below discards `resolvedUsage`
		// on retry, so this running total is the only place that cost isn't
		// silently lost. Declared outside the loop; never reset per attempt.
		const aggregatedUsage = { inputTokens: 0, outputTokens: 0 };

		for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
			// Reset per-attempt state
			responseText = "";
			toolCallsToExecute = [];
			invalidToolCallCount = 0;
			toolErrorCount = 0;
			streamError = null;
			resolveError = null;
			resolvedUsage = undefined;
			finishReason = undefined;

			const attemptStartTime = Date.now();

			// Signal iteration start so the frontend can clear previous text.
			// Re-fired on retry so any partially streamed text from the failed
			// attempt is replaced rather than appended to in the UI.
			if (input.executionId) {
				publishExecutionEvent(input.executionId, {
					event: "execution.iteration_start",
					data:
						attempt > 1
							? { iteration, retryAttempt: attempt }
							: { iteration },
				});
			}

			const stream = streamText({
				model,
				system: effectiveSystemPrompt,
				messages: messages as any,
				tools: aiSdkToolCount > 0 ? (aiSdkTools as any) : undefined,
				toolChoice,
				stopWhen: stepCountIs(maxStepsPerIteration),
				maxOutputTokens: 16384,
			});

			// Process the full stream for text deltas, tool calls, and errors
			for await (const part of stream.fullStream) {
				if (part.type === "text-delta") {
					responseText += part.text || "";

					// Publish text delta via Redis pub/sub for real-time streaming
					if (input.executionId && part.text) {
						publishExecutionEvent(input.executionId, {
							event: "execution.text_delta",
							data: { text: part.text },
						});
					}

					// Send heartbeat periodically during text streaming
					sendPeriodicHeartbeat();
				} else if (part.type === "tool-call") {
					// AI SDK 6.0.116 marks an unparsable tool call or a call
					// to a tool that doesn't exist with `invalid: true` +
					// `error` on the part instead of throwing (DynamicToolCall).
					// Count it and skip execution — it is NOT a real request.
					const toolCallDefect = part as {
						invalid?: boolean;
						error?: unknown;
					};
					if (toolCallDefect.invalid === true) {
						invalidToolCallCount++;
						console.error(
							`[AgentIteration] Invalid tool call from provider: ${part.toolName}: ${String(toolCallDefect.error)}`,
						);
					} else {
						// Collect tool calls - these tools have no execute function,
						// so they are "pending" and will be executed by the workflow
						toolCallsToExecute.push({
							id: part.toolCallId,
							name: part.toolName,
							args: (part.input as Record<string, unknown>) || {},
							// Preserve provider metadata (e.g. Gemini thoughtSignature)
							...((part as any).providerMetadata && {
								providerMetadata: (part as any)
									.providerMetadata,
							}),
						});

						console.log(
							`[AgentIteration] LLM requested tool: ${part.toolName}`,
						);

						// Force heartbeat on tool call
						lastHeartbeatTime = 0;
						sendPeriodicHeartbeat();
					}
				} else if (part.type === "tool-error") {
					// Provider reported a tool call it couldn't execute/parse
					// via a dedicated error part rather than the `invalid`
					// flag above. Same classification: fail the whole turn.
					toolErrorCount++;
					console.error(
						`[AgentIteration] Tool error from provider: ${(part as any).toolName}: ${String((part as any).error)}`,
					);
				} else if (part.type === "error") {
					const errorMsg =
						part.error instanceof Error
							? part.error.message
							: String(part.error);
					console.error(`[AgentIteration] Stream error: ${errorMsg}`);
					streamError = errorMsg;
				}
			}

			elapsed = Date.now() - attemptStartTime;

			// Resolve usage and finish reason from the stream. When the
			// provider returns an empty response (no text, no tool calls),
			// the AI SDK rejects these promises with NoOutputGeneratedError —
			// and can reject BOTH promises for the same empty turn. Awaiting
			// them sequentially in one try/catch would leave the second
			// promise unhandled if the first throws; Promise.allSettled
			// attaches handlers to both up front regardless of which (or
			// both) reject. (Mirrors the spirit of consumeStream() in
			// report-agent-loop.ts, which settles the equivalent promises
			// for the same reason.)
			const [usageSettled, finishReasonSettled] =
				await Promise.allSettled([stream.usage, stream.finishReason]);

			if (usageSettled.status === "fulfilled") {
				resolvedUsage = usageSettled.value;
				// Failed attempts still burn real provider tokens (staging:
				// 13,210 input tokens on the failed attempt before the
				// retry) — aggregate every attempt's usage into the running
				// total so budget/cost accounting isn't lost when the
				// per-attempt reset above discards `resolvedUsage` on retry.
				aggregatedUsage.inputTokens += resolvedUsage?.inputTokens || 0;
				aggregatedUsage.outputTokens +=
					resolvedUsage?.outputTokens || 0;
			}
			if (finishReasonSettled.status === "fulfilled") {
				finishReason = finishReasonSettled.value as string | undefined;
			}
			if (
				usageSettled.status === "rejected" ||
				finishReasonSettled.status === "rejected"
			) {
				const firstRejection =
					usageSettled.status === "rejected"
						? usageSettled.reason
						: (finishReasonSettled as PromiseRejectedResult).reason;
				resolveError =
					firstRejection instanceof Error
						? firstRejection.message
						: String(firstRejection);
				console.error(
					`[AgentIteration] Stream produced no output after ${elapsed}ms: ${resolveError}`,
					`(streamError: ${streamError}, text: ${responseText.length} chars, toolCalls: ${toolCallsToExecute.length})`,
				);
			}

			// Attempt-failure classification: provider/protocol defects that
			// never throw yet must not fall through to a fabricated success.
			// Applies regardless of how many tools were bound — with none
			// bound, a finishReason=tool-calls response is an even stronger
			// protocol inconsistency, not permission to fabricate one.
			// Classified as transient: the retry above re-rolls it, and if it
			// persists Path B surfaces it as `stream_error` instead of a fake
			// success.
			if (!streamError && !resolveError) {
				if (invalidToolCallCount > 0 || toolErrorCount > 0) {
					// A mixed turn (valid + invalid calls) fails whole —
					// executing only the valid subset of a corrupted turn
					// would act on a half-parsed plan.
					streamError = `provider emitted ${invalidToolCallCount} invalid tool call(s) and ${toolErrorCount} tool error(s)`;
				} else if (
					finishReason === "tool-calls" &&
					toolCallsToExecute.length === 0
				) {
					// The finish reason says the model stopped to call
					// tools, yet no tool-call part surfaced through
					// fullStream (observed on the Databricks provider
					// dropping tool_use blocks — staging orch-9294c339,
					// 2026-07-27). The collected text is a preamble stub,
					// not an answer.
					streamError = `provider signalled finishReason=tool-calls but streamed no tool-call parts (text: ${responseText.length} chars)`;
				} else if (finishReason === "error") {
					streamError =
						"provider reported finishReason=error without an error part";
				}
			}

			// Decide whether to retry. Only retry transient errors — limit
			// signals are deterministic and skip the retry. A clean attempt
			// (no stream/resolve error and no classified defect above) breaks
			// out even when it produced only partial text: the stream
			// delivered usable output. Defective turns retry even when they
			// carried partial text or a mix of valid and invalid tool calls —
			// that output is corrupted, not usable.
			const errorMsg = streamError || resolveError;
			if (!errorMsg) {
				break;
			}

			const limitSignal = classifyLimitError(errorMsg) || undefined;
			if (limitSignal) {
				break;
			}

			if (attempt >= MAX_STREAM_ATTEMPTS) {
				break;
			}

			console.warn(
				`[AgentIteration] Transient stream error on attempt ${attempt}/${MAX_STREAM_ATTEMPTS}, retrying once: ${errorMsg}`,
			);
		}

		// The aggregate across all attempts, not just the last one — see the
		// `aggregatedUsage` declaration above the retry loop.
		const usage = aggregatedUsage;

		// Path A: usage/finishReason rejected — provider returned no usable output.
		if (resolveError) {
			const rawError = streamError || resolveError;
			const sanitizedError = sanitizeProviderError(rawError);
			const limitSignal =
				classifyLimitError(resolveError) ||
				classifyLimitError(streamError || resolveError) ||
				undefined;
			if (limitSignal && input.executionId) {
				publishExecutionEvent(input.executionId, {
					event: "execution.limit_signal",
					data: limitSignal as unknown as Record<string, unknown>,
				});
			}
			// Limit signals stay as `response` so the workflow soft-degrades
			// with the existing UI banner. Non-limit transient errors are
			// surfaced as `stream_error` so the workflow does NOT persist the
			// error text as an assistant turn.
			if (limitSignal) {
				return {
					type: "response" as const,
					content: `AI response was cut short (${limitSignal.kind.replace(/_/g, " ")}): ${limitSignal.message}`,
					usage,
					limitSignal,
				};
			}
			return {
				type: "stream_error",
				message: sanitizedError,
				partialResponse: responseText,
				usage,
			};
		}

		console.log(
			`[AgentIteration] LLM call completed in ${elapsed}ms, ${toolCallsToExecute.length} tool calls, finishReason=${finishReason}, inputTokens=${usage.inputTokens}, outputTokens=${usage.outputTokens}, totalTokens=${usage.inputTokens + usage.outputTokens}`,
		);
		if (finishReason === "length") {
			console.warn(
				`[AgentIteration] Response was truncated by token limit (${usage.outputTokens} output tokens). Consider increasing maxTokens.`,
			);
		}

		// Path B: the attempt failed — an error part from the stream, or a
		// defect synthesized by the classification above (invalid/errored
		// tool calls, finishReason=tool-calls with no parts, finishReason=
		// error). Even if partial text or tool calls were collected, the
		// output is incomplete or corrupted.
		if (streamError) {
			console.error(
				`[AgentIteration] Stream failed after ${MAX_STREAM_ATTEMPTS} attempt(s): ${streamError} (partial text: ${responseText.length} chars, tool calls: ${toolCallsToExecute.length})`,
			);
			const limitSignal = classifyLimitError(streamError) || undefined;
			if (limitSignal && input.executionId) {
				publishExecutionEvent(input.executionId, {
					event: "execution.limit_signal",
					data: limitSignal as unknown as Record<string, unknown>,
				});
			}
			if (limitSignal) {
				const partialContext = responseText.trim()
					? `\n\nPartial response before error:\n${responseText.trim()}`
					: "";
				return {
					type: "response",
					content: `AI response was cut short (${limitSignal.kind.replace(/_/g, " ")}): ${limitSignal.message}${partialContext}`,
					usage,
					limitSignal,
				};
			}
			return {
				type: "stream_error",
				message: sanitizeProviderError(streamError),
				partialResponse: responseText,
				usage,
			};
		}

		// If there are tool calls, return them for execution
		if (toolCallsToExecute.length > 0) {
			console.log(
				"[AgentIteration] Tool calls to execute:",
				JSON.stringify(toolCallsToExecute, null, 2),
			);
			return {
				type: "tool_calls",
				toolCalls: toolCallsToExecute,
				usage,
			};
		}

		// No tool calls - this is the final response
		const finalText = responseText || "Task completed.";
		console.log(
			`[AgentIteration] Returning final response (${finalText.length} chars)`,
		);

		return {
			type: "response",
			content: finalText,
			usage,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		console.error(`[AgentIteration] LLM call failed: ${errorMessage}`);

		// Classify known limit errors so the workflow and UI can surface a
		// specific banner (rate limit / quota / context length) instead of a
		// generic "something went wrong."
		const limitSignal = classifyLimitError(error) || undefined;
		if (limitSignal && input.executionId) {
			publishExecutionEvent(input.executionId, {
				event: "execution.limit_signal",
				data: limitSignal as unknown as Record<string, unknown>,
			});
		}

		// Limit signals stay as `response` so the existing soft-degrade path
		// (banner + finalResponse) keeps working. Anything else is surfaced
		// as `stream_error` so the workflow does NOT persist the error text
		// as an assistant turn — that would poison conversation history for
		// every subsequent turn in the same chat thread.
		if (limitSignal) {
			return {
				type: "response",
				content: `AI response was cut short (${limitSignal.kind.replace(/_/g, " ")}): ${limitSignal.message}`,
				usage: { inputTokens: 0, outputTokens: 0 },
				limitSignal,
			};
		}
		return {
			type: "stream_error",
			message: sanitizeProviderError(errorMessage),
			partialResponse: "",
			usage: { inputTokens: 0, outputTokens: 0 },
		};
	} finally {
		if (backgroundHeartbeatId !== undefined) {
			clearInterval(backgroundHeartbeatId);
		}
	}
}
