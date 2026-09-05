/**
 * Unified Server for Project Document Generator
 *
 * Single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 * This replaces the need for separate AG-UI and A2A servers.
 *
 * Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - LangGraph Platform API: /runs/stream, /threads/:id/runs/stream (for CopilotKit LangGraphAgent)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 */

import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
} from "@langchain/core/messages";
import type { AgentSkill } from "@repo/agent-core";
import { PredictiveToolArgsAccumulator } from "@repo/agent-core/predictive-tool-args";
import {
	type AgentRuntimeConfig,
	createUnifiedServer,
	type LangGraphStreamEvent,
} from "@repo/agent-core/unified-server";
import type { DocumentType, ProjectContext } from "@repo/agent-types";
import { v4 as uuidv4 } from "uuid";
import { projectDocumentGeneratorGraph } from "./agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils/index.js";

/**
 * Normalize messages from CopilotKit format to LangChain BaseMessage format
 * CopilotKit uses camelCase (toolCallId) while LangChain expects snake_case (tool_call_id)
 * CopilotKit uses 'type' property while LangChain uses 'role'
 *
 * IMPORTANT: CopilotKit sometimes sends AI messages without tool_calls, followed by
 * ToolMessages that reference those calls. OpenAI requires ToolMessages to be preceded
 * by an AIMessage with matching tool_calls. This function reconstructs missing tool_calls.
 */

/**
 * Parse tool call arguments from various formats.
 * Handles OpenAI format (function.arguments as JSON string) and LangChain format (args as object).
 */
function parseToolCallArgs(
	tc: Record<string, unknown>,
): Record<string, unknown> {
	let args = tc.args;
	if (!args && tc.function) {
		args = (tc.function as Record<string, unknown>)?.arguments;
	}
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (
				parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed)
			) {
				return parsed as Record<string, unknown>;
			}
			return {};
		} catch {
			return {};
		}
	}
	if (args && typeof args === "object") {
		return args as Record<string, unknown>;
	}
	return {};
}

function normalizeMessages(
	messages: Array<Record<string, unknown>>,
): BaseMessage[] {
	// Debug: Log raw messages to understand what CopilotKit sends
	console.log(
		"[UnifiedServer] Raw messages from CopilotKit:",
		messages.map((msg, i) => ({
			index: i,
			type: msg.type,
			role: msg.role,
			hasToolCalls: !!(msg.tool_calls || msg.toolCalls),
			toolCallsCount:
				((msg.tool_calls || msg.toolCalls) as Array<unknown>)?.length ||
				0,
			hasToolCallId: !!(msg.tool_call_id || msg.toolCallId),
			toolCallId: msg.tool_call_id || msg.toolCallId,
			contentPreview:
				typeof msg.content === "string"
					? msg.content.substring(0, 100)
					: JSON.stringify(msg.content)?.substring(0, 100),
		})),
	);

	// First pass: collect tool message IDs and their preceding AI message indices
	// This helps us reconstruct missing tool_calls on AI messages
	const toolMessagesByPrecedingAi = new Map<
		number,
		Array<{ id: string; name: string }>
	>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const msgType = (
			(msg.type as string) ||
			(msg.role as string) ||
			""
		).toLowerCase();

		if (msgType === "tool") {
			const toolCallId =
				(msg.tool_call_id as string) || (msg.toolCallId as string);
			const toolName = (msg.name as string) || "confirm_changes"; // Default for confirmation tools

			console.log(`[UnifiedServer] Tool message at index ${i}:`, {
				toolCallId,
				toolName,
			});

			if (toolCallId) {
				// Find the preceding AI message
				for (let j = i - 1; j >= 0; j--) {
					const prevMsg = messages[j];
					const prevType = (
						(prevMsg.type as string) ||
						(prevMsg.role as string) ||
						""
					).toLowerCase();
					if (prevType === "ai" || prevType === "assistant") {
						// Check if this AI message already has the tool_call
						// CopilotKit uses camelCase (toolCalls), LangChain uses snake_case (tool_calls)
						const existingToolCalls = (prevMsg.tool_calls ||
							prevMsg.toolCalls) as
							| Array<Record<string, unknown>>
							| undefined;
						console.log(
							`[UnifiedServer] Checking AI message at index ${j}:`,
							{
								hasExistingToolCalls: !!existingToolCalls,
								existingToolCallsCount:
									existingToolCalls?.length || 0,
								existingToolCalls: existingToolCalls?.map(
									(tc) => ({
										id: tc.id,
										name: tc.name,
										functionName: (
											tc.function as Record<
												string,
												unknown
											>
										)?.name,
									}),
								),
							},
						);

						const hasToolCall = existingToolCalls?.some(
							(tc) =>
								(tc.id as string) === toolCallId ||
								(tc.name as string) === toolName ||
								((tc.function as Record<string, unknown>)
									?.name as string) === toolName,
						);

						if (!hasToolCall) {
							// This AI message needs a reconstructed tool_call
							if (!toolMessagesByPrecedingAi.has(j)) {
								toolMessagesByPrecedingAi.set(j, []);
							}
							toolMessagesByPrecedingAi
								.get(j)
								?.push({ id: toolCallId, name: toolName });
							console.log(
								`[UnifiedServer] Will reconstruct tool_call for AI at index ${j}:`,
								{ toolCallId, toolName },
							);
						} else {
							console.log(
								`[UnifiedServer] AI at index ${j} already has matching tool_call`,
							);
						}
						break;
					}
				}
			}
		}
	}

	if (toolMessagesByPrecedingAi.size > 0) {
		console.log(
			"[UnifiedServer] Reconstructing tool_calls for AI messages:",
			Array.from(toolMessagesByPrecedingAi.entries()).map(
				([idx, calls]) => ({
					aiMessageIndex: idx,
					toolCalls: calls,
				}),
			),
		);
	} else {
		console.log("[UnifiedServer] No tool_calls need reconstruction");
	}

	// Second pass: convert messages, adding reconstructed tool_calls where needed
	return messages.map((msg, index) => {
		const content =
			typeof msg.content === "string"
				? msg.content
				: String(msg.content || "");

		// Determine message type from 'type' or 'role'
		const msgType = (msg.type as string) || (msg.role as string) || "user";

		// Convert toolCallId (camelCase) to tool_call_id (snake_case)
		const toolCallId =
			(msg.tool_call_id as string) || (msg.toolCallId as string);

		// Create appropriate LangChain message type
		switch (msgType.toLowerCase()) {
			case "human":
			case "user":
				return new HumanMessage({ content });

			case "ai":
			case "assistant": {
				// AI messages may have tool_calls
				// CopilotKit uses camelCase (toolCalls), LangChain uses snake_case (tool_calls)
				const toolCalls = (msg.tool_calls || msg.toolCalls) as
					| Array<Record<string, unknown>>
					| undefined;

				// Check if we need to reconstruct tool_calls for this AI message
				const reconstructedCalls = toolMessagesByPrecedingAi.get(index);
				if (reconstructedCalls && reconstructedCalls.length > 0) {
					// Merge existing tool_calls with reconstructed ones
					const existingCalls =
						toolCalls?.map((tc) => ({
							id: (tc.id as string) || "",
							name:
								(tc.name as string) ||
								((tc.function as Record<string, unknown>)
									?.name as string) ||
								"",
							args: parseToolCallArgs(tc),
							type: "tool_call" as const,
						})) || [];

					const newCalls = reconstructedCalls.map((rc) => ({
						id: rc.id,
						name: rc.name,
						args: {},
						type: "tool_call" as const,
					}));

					return new AIMessage({
						content,
						tool_calls: [...existingCalls, ...newCalls],
					});
				}

				if (toolCalls && toolCalls.length > 0) {
					return new AIMessage({
						content,
						tool_calls: toolCalls.map((tc) => ({
							id: (tc.id as string) || "",
							name:
								(tc.name as string) ||
								((tc.function as Record<string, unknown>)
									?.name as string) ||
								"",
							args: parseToolCallArgs(tc),
							type: "tool_call" as const,
						})),
					});
				}
				return new AIMessage({ content });
			}

			case "system":
				return new SystemMessage({ content });

			case "tool":
				if (!toolCallId) {
					console.warn(
						"[UnifiedServer] Tool message missing tool_call_id, using placeholder",
					);
				}
				return new ToolMessage({
					content,
					tool_call_id: toolCallId || "unknown",
				});

			default:
				console.warn(
					`[UnifiedServer] Unknown message type: ${msgType}, treating as human`,
				);
				return new HumanMessage({ content });
		}
	});
}

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8129", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "generate-prd",
		name: "Generate PRD",
		description:
			"Create a Product Requirements Document with features and acceptance criteria",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"Description of the product/feature to document",
				},
				projectContext: {
					type: "object",
					description:
						"Project context including name, tech stack, and features",
					properties: {
						name: { type: "string" },
						techStack: { type: "array", items: { type: "string" } },
						features: { type: "array", items: { type: "string" } },
					},
				},
			},
			required: ["prompt"],
		},
		examples: [
			"Create a PRD for user authentication feature",
			"Write product requirements for the payment system",
		],
		tags: ["prd", "product", "requirements"],
	},
	{
		id: "generate-tech-spec",
		name: "Generate Technical Spec",
		description:
			"Create a Technical Specification with architecture, APIs, and implementation details",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "Technical feature or system to document",
				},
				documentType: { type: "string", enum: ["tech-spec"] },
			},
			required: ["prompt"],
		},
		examples: [
			"Create technical specification for the API gateway",
			"Write architecture documentation for microservices",
		],
		tags: ["technical", "spec", "architecture"],
	},
	{
		id: "generate-project-doc",
		name: "Generate Project Documentation",
		description:
			"Create general project documentation with customizable structure",
		examples: [
			"Create project overview documentation",
			"Generate onboarding documentation for new developers",
		],
		tags: ["documentation", "project"],
	},
];

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "project_document_generator",
		description:
			"Specialized agent for generating PRDs, technical specs, and project documentation with RAG context. Best for creating comprehensive project documents with proper structure and formatting.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: [
			"documentation",
			"prd",
			"technical-spec",
			"project",
			"langgraph",
		],
		supportsStreaming: true, // Enable streaming for CopilotKit
	},
	// Invoke function - wraps the LangGraph graph
	async (input) => {
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);
		const documentType = ((input.documentType as string) ||
			"general") as DocumentType;

		// CRITICAL: CopilotKit sends agent state via input.state (from useCoAgent)
		// BUT ragContexts and projectContext are now sent via useCopilotReadable (one-way)
		// because useCoAgent state gets replaced by agent response (losing these fields)
		// PRIORITY ORDER:
		// 1. CopilotKit readable context (from useCopilotReadable - one-way, never lost)
		// 2. CopilotKit state (for backwards compatibility)
		// 3. Direct input (for Temporal workflows / A2A calls)
		const copilotKitState = input.state as
			| Record<string, unknown>
			| undefined;

		// Extract CopilotKit readable context EARLY (needed for ragContexts and projectContext)
		// AG-UI protocol sends context directly in input.context, NOT input.copilotkit.context
		const readableContexts = (input.context as any[] | undefined) || [];

		// Log readable context metadata only (no content to avoid data leaks)
		console.log("[UnifiedServer] Readable contexts received:", {
			count: readableContexts.length,
			descriptions: readableContexts.map((r: any) =>
				r.description?.substring(0, 50),
			),
		});

		// Helper to extract value from readable contexts by description pattern
		// NOTE: AG-UI protocol sends value as a stringified JSON, so we need to parse it
		const findReadableValue = (pattern: string): any => {
			const readable = readableContexts.find((r: any) =>
				r.description?.toLowerCase().includes(pattern.toLowerCase()),
			);
			if (!readable?.value) {
				return undefined;
			}
			// Value might be a string (JSON) or already an object
			if (typeof readable.value === "string") {
				try {
					return JSON.parse(readable.value);
				} catch {
					return readable.value;
				}
			}
			return readable.value;
		};

		// Extract ragContexts from readable context first (Fix 1.5d)
		// useCopilotReadable sends: { ragContexts: string[], ragContextsCount: number }
		const readableRagData = findReadableValue("rag context");
		const ragContextsFromReadable = readableRagData?.ragContexts as
			| string[]
			| undefined;

		// Extract projectContext from readable context (Fix 1.5d)
		// useCopilotReadable sends: { projectContext: ProjectContext }
		const readableProjectData = findReadableValue("project context");
		const projectContextFromReadable = readableProjectData?.projectContext;

		// Extract projectContext - PRIORITY: readable > state > direct input
		const projectContext =
			projectContextFromReadable ||
			(copilotKitState?.projectContext as {
				name?: string;
				description?: string;
				goals?: string;
				techStack?: string[];
				features?: string[];
				projectTypes?: string[];
			}) ||
			(input.projectContext as {
				name?: string;
				techStack?: string[];
				features?: string[];
			}) ||
			{};

		// Extract ragContexts - PRIORITY: readable (if non-empty) > state > direct input
		// This includes both document contexts AND Teams messages (from Fix 1.5)
		// Note: Check for non-empty array since empty array is truthy and would skip fallbacks
		const baseRagContexts =
			(ragContextsFromReadable && ragContextsFromReadable.length > 0
				? ragContextsFromReadable
				: null) ||
			(copilotKitState?.ragContexts as string[]) ||
			(input.ragContexts as string[]) ||
			[];

		// Connected project context (meeting transcripts, docs, team
		// messages) the web client pre-fetched for an "Update Clean Spec" refresh
		// and pushed on a DEDICATED state field via flushSync, so it survives the
		// `readable non-empty > state` short-circuit above (which would drop it
		// whenever the user has an attached file). Merge it in so the model folds
		// it into the spec — it never appears in the visible chat. State-only.
		const refreshSpecContexts =
			(copilotKitState?.refreshSpecContexts as string[]) ||
			(input.refreshSpecContexts as string[]) ||
			[];
		const ragContexts = [...baseRagContexts, ...refreshSpecContexts];

		// Story-media images for the AI Feature Assistant are now resolved
		// **on the web client** (StoryWorkspace) via the
		// `projects.stories.resolveMediaForAgent` oRPC procedure. The web tier
		// pushes the resolved base64-data-URL markdown into the `rag context`
		// readable, so by the time we land here, `ragContexts` already includes
		// them — there is nothing for the agent to do. The earlier shape that
		// imported a helper directly from `@repo/api/modules/projects/lib/...`
		// here broke the agent's tsup build (no `exports` field on `@repo/api`
		// for deep paths) and crossed the stateless-agent boundary (`@repo/database`
		// / `@repo/storage` are intentionally NOT in this agent's package.json).

		// Log RAG context metadata only (no content to avoid data leaks)
		console.log("[UnifiedServer] RAG contexts:", {
			count: ragContexts.length,
			source: ragContextsFromReadable?.length
				? "READABLE"
				: copilotKitState?.ragContexts
					? "STATE"
					: "DIRECT",
			// How many entries came from the Clean Spec refresh field.
			refreshSpecCount: refreshSpecContexts.length,
			hasTeamsMessages: ragContexts.some((ctx) =>
				ctx.startsWith("[Teams"),
			),
		});

		// Extract custom system prompt - from CopilotKit state first, then direct input
		const systemPrompt =
			(copilotKitState?.systemPrompt as string) ||
			(input.systemPrompt as string) ||
			undefined;

		// Extract current document for editing/regeneration context
		// PRIORITY: state > readable context > direct input
		// IMPORTANT: CopilotKit bidirectional state sync can lose the document field
		// when the agent responds without it (e.g., during tool-call rounds like
		// select_meetings → fetchMeetingNotes). The readable context fallback
		// ensures the agent always has the current document content.
		const readableDocData = findReadableValue("current document");
		const documentFromReadable = readableDocData?.content as
			| string
			| undefined;
		const currentDocument =
			(copilotKitState?.document as string) ||
			(documentFromReadable && documentFromReadable.trim().length > 0
				? documentFromReadable
				: null) ||
			(input.document as string) ||
			"";

		// Extract CopilotKit frontend actions from various locations
		// CopilotKit sends actions in different locations depending on the protocol version:
		// - AG-UI protocol: body.tools (array of actions)
		// - CopilotKit SDK: body.state.copilotkit.actions
		const bodyTools = input.tools as any[] | undefined;
		const stateCopilotkit = (input.state as any)?.copilotkit as
			| { actions?: any[] }
			| undefined;

		// Build copilotkit object from whichever source has actions
		// Filter out MCP server tools - they typically have patterns like "server-id_tool_name"
		// Keep only CopilotKit frontend actions which use simple names like "confirm_changes", "regenerate_document"
		const allActions = stateCopilotkit?.actions || bodyTools || [];
		const actions = allActions.filter((a: any) => {
			const name = a.name || "";
			// MCP tools have patterns like "fizzy-mcp-xxx_tool_name" or "firecrawl_tool_name"
			// They typically contain both dashes and underscores, or multiple underscores
			// CopilotKit actions are simple: "confirm_changes", "regenerate_document"
			const hasDashAndUnderscore =
				name.includes("-") && name.includes("_");
			const hasMultipleUnderscores = (name.match(/_/g) || []).length > 1;
			const isMcpTool = hasDashAndUnderscore || hasMultipleUnderscores;
			return !isMcpTool;
		});
		const copilotkit =
			actions.length > 0
				? {
						actions,
						context: readableContexts,
						// CopilotKit's LangGraph middleware owns these two fields: it
						// sets them after a model turn that intercepted frontend tool
						// calls and clears them before the next one. Its runtime guard
						// treats an empty array / empty id as "not set".
						interceptedToolCalls: [],
						originalAIMessageId: "",
					}
				: undefined;

		// Extract AI config from input (passed via A2A metadata or CopilotKit configurable)
		// This is needed for orchestrator delegation to system agents
		const aiApiKey = input.ai_api_key as string | undefined;
		const aiModel = input.ai_model as string | undefined;
		const aiProvider = input.ai_provider as string | undefined;
		const aiBaseUrl = input.ai_base_url as string | undefined;
		const tenantUserId = input.tenant_user_id as string | undefined;
		const tenantOrgId = input.tenant_organization_id as string | undefined;

		console.log(
			"[UnifiedServer] Invoking project_document_generator with:",
			{
				messageCount: messages.length,
				documentType,
				projectName: projectContext.name || "unnamed",
				ragContextCount: ragContexts.length,
				hasSystemPrompt: !!systemPrompt,
				systemPromptLength: systemPrompt?.length || 0,
				hasCurrentDocument: !!currentDocument,
				currentDocumentLength: currentDocument?.length || 0,
				currentDocumentPreview:
					currentDocument?.substring(0, 100) || "(empty)",
				// Debug: What state did CopilotKit send?
				hasCopilotKitState: !!copilotKitState,
				copilotKitStateKeys: copilotKitState
					? Object.keys(copilotKitState)
					: [],
				copilotKitStateDocLength:
					(copilotKitState?.document as string)?.length || 0,
				// Debug: show MCP filtering
				totalActionsReceived: allActions.length,
				filteredActionsCount: actions.length,
				filteredActionNames: actions.map((a: any) => a.name),
				// AI config debugging
				hasAiApiKey: !!aiApiKey,
				aiModel,
				aiProvider,
				tenantUserId,
				// Log normalized messages for debugging - use _getType() for LangChain message types
				normalizedMessages: messages.map((m) => ({
					messageType: m._getType(),
					hasToolCalls:
						"tool_calls" in m &&
						!!(m as AIMessage).tool_calls?.length,
					hasToolCallId: "tool_call_id" in m,
					contentPreview:
						typeof m.content === "string"
							? m.content.substring(0, 50)
							: String(m.content).substring(0, 50),
				})),
			},
		);

		// Build configurable for graph invocation
		// This passes AI config to the graph so nodes can access it via config.configurable
		const configurable: Record<string, unknown> = {};
		if (aiApiKey) {
			configurable.ai_api_key = aiApiKey;
		}
		if (aiModel) {
			configurable.ai_model = aiModel;
		}
		if (aiProvider) {
			configurable.ai_provider = aiProvider;
		}
		if (aiBaseUrl) {
			configurable.ai_gateway_url = aiBaseUrl;
		}
		if (tenantUserId) {
			configurable.tenant_user_id = tenantUserId;
		}
		if (tenantOrgId) {
			configurable.tenant_organization_id = tenantOrgId;
		}

		// Invoke the LangGraph graph with FULL message history
		// This is critical for maintaining conversation context across tool calls
		const result = await projectDocumentGeneratorGraph.invoke(
			{
				messages,
				documentType,
				projectContext: {
					name: projectContext.name || "",
					techStack: projectContext.techStack || [],
					features: projectContext.features || [],
				} as ProjectContext,
				ragContexts: ragContexts,
				systemPrompt, // Pass custom system prompt from Temporal workflow or Prompt Library
				document: currentDocument, // Pass current document for regeneration context
				copilotkit, // Pass CopilotKit state (frontend actions) to the graph
				// Teams integration state for server-side tool execution
				// Priority: readable context > CopilotKit state > direct input
				hasTeamsIntegration:
					(readableProjectData?.hasTeamsIntegration as boolean) ??
					(input.hasTeamsIntegration as boolean) ??
					false,
				hasSlackIntegration:
					(readableProjectData?.hasSlackIntegration as boolean) ??
					(input.hasSlackIntegration as boolean) ??
					false,
				hasGitHubIntegration:
					(readableProjectData?.hasGitHubIntegration as boolean) ??
					(input.hasGitHubIntegration as boolean) ??
					false,
				hasRepoIntegration:
					(readableProjectData?.hasRepoIntegration as boolean) ??
					(input.hasRepoIntegration as boolean) ??
					false,
				projectId:
					(readableProjectData?.projectId as string) ||
					(input.projectId as string) ||
					"",
				userId: (input.userId as string) || tenantUserId || "",
				organizationId:
					(input.organizationId as string) ||
					tenantOrgId ||
					undefined,
			},
			// Pass AI config in configurable so graph nodes can access it
			{
				recursionLimit: DEFAULT_RECURSION_LIMIT,
				...(Object.keys(configurable).length > 0
					? { configurable }
					: {}),
			},
		);

		console.log("[UnifiedServer] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
		});

		// If no document was generated (model didn't call the tool),
		// extract text response from the last assistant message as fallback
		let responseText = result.document || "";
		if (!responseText && result.messages && result.messages.length > 0) {
			// Find the last AI/assistant message
			for (let i = result.messages.length - 1; i >= 0; i--) {
				const msg = result.messages[i];
				const msgAny = msg as any;
				const role = msgAny.role || msgAny._getType?.();
				if (role === "ai" || role === "assistant") {
					const content = msgAny.content;
					if (typeof content === "string" && content.length > 0) {
						responseText = content;
						console.log(
							"[UnifiedServer] Using text response as fallback (model didn't use write_document_local tool)",
							{
								responseLength: responseText.length,
							},
						);
						break;
					}
				}
			}
		}

		return {
			document: result.document || "",
			streamingContent: result.document || "",
			// Include text response for A2A even when document is empty
			textResponse: responseText,
			error: result.error,
		};
	},
	// Transform output for A2A response
	(output) => {
		// Prefer document, but fall back to textResponse if available
		const document = (output.document as string) || "";
		const textResponse = (output.textResponse as string) || "";
		const response = document || textResponse;

		return {
			response, // Use combined response (document OR text fallback)
			artifacts: document
				? [
						{
							id: uuidv4(),
							name: "document",
							description: "Generated project document",
							mimeType: "text/markdown",
							parts: [{ type: "text", text: document }],
						},
					]
				: [],
			metadata: {
				error: output.error,
				// Flag if we used text fallback (helpful for debugging)
				usedTextFallback: !document && !!textResponse,
			},
		};
	},
	// A2A streaming executor (not used for now)
	undefined,
	// Platform streaming executor for CopilotKit LangGraphAgent
	// Uses streamMode: ["updates", "messages"] to get both node updates AND LLM token streaming
	async function* (
		input,
		config?: AgentRuntimeConfig,
	): AsyncGenerator<LangGraphStreamEvent> {
		// Debug: Log all input keys to understand what CopilotKit sends
		console.log("[UnifiedServer] Streaming input received:", {
			inputKeys: Object.keys(input),
			hasState: !!input.state,
			stateKeys: input.state ? Object.keys(input.state as object) : [],
			stateDocument: (input.state as any)?.document
				? `${String((input.state as any).document).length} chars`
				: "none",
			stateStreamingContent: (input.state as any)?.streamingContent
				? `${String((input.state as any).streamingContent).length} chars`
				: "none",
		});

		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);
		const documentType = ((input.documentType as string) ||
			"general") as DocumentType;

		// CRITICAL: CopilotKit sends agent state via input.state (from useCoAgent)
		// BUT ragContexts and projectContext are now sent via useCopilotReadable (one-way)
		// because useCoAgent state gets replaced by agent response (losing these fields)
		// PRIORITY ORDER:
		// 1. CopilotKit readable context (from useCopilotReadable - one-way, never lost)
		// 2. CopilotKit state (for backwards compatibility)
		// 3. Direct input (for Temporal workflows / A2A calls)
		const copilotKitState = input.state as
			| Record<string, unknown>
			| undefined;

		// Extract CopilotKit readable context EARLY (needed for ragContexts and projectContext)
		// AG-UI protocol sends context directly in input.context, NOT input.copilotkit.context
		const readableContexts = (input.context as any[] | undefined) || [];

		// Log readable context metadata only (no content to avoid data leaks)
		console.log("[UnifiedServer] Readable contexts received:", {
			count: readableContexts.length,
			descriptions: readableContexts.map((r: any) =>
				r.description?.substring(0, 50),
			),
		});

		// Helper to extract value from readable contexts by description pattern
		// NOTE: AG-UI protocol sends value as a stringified JSON, so we need to parse it
		const findReadableValue = (pattern: string): any => {
			const readable = readableContexts.find((r: any) =>
				r.description?.toLowerCase().includes(pattern.toLowerCase()),
			);
			if (!readable?.value) {
				return undefined;
			}
			// Value might be a string (JSON) or already an object
			if (typeof readable.value === "string") {
				try {
					return JSON.parse(readable.value);
				} catch {
					return readable.value;
				}
			}
			return readable.value;
		};

		// Extract ragContexts from readable context first (Fix 1.5d)
		// useCopilotReadable sends: { ragContexts: string[], ragContextsCount: number }
		const readableRagData = findReadableValue("rag context");
		const ragContextsFromReadable = readableRagData?.ragContexts as
			| string[]
			| undefined;

		// Extract projectContext from readable context (Fix 1.5d)
		// useCopilotReadable sends: { projectContext: ProjectContext }
		const readableProjectData = findReadableValue("project context");
		const projectContextFromReadable = readableProjectData?.projectContext;

		// Extract projectContext - PRIORITY: readable > state > direct input
		const projectContext =
			projectContextFromReadable ||
			(copilotKitState?.projectContext as {
				name?: string;
				description?: string;
				goals?: string;
				techStack?: string[];
				features?: string[];
				projectTypes?: string[];
			}) ||
			(input.projectContext as {
				name?: string;
				techStack?: string[];
				features?: string[];
			}) ||
			{};

		// Extract ragContexts - PRIORITY: readable (if non-empty) > state > direct input
		// This includes both document contexts AND Teams messages (from Fix 1.5)
		// Note: Check for non-empty array since empty array is truthy and would skip fallbacks
		const baseRagContexts =
			(ragContextsFromReadable && ragContextsFromReadable.length > 0
				? ragContextsFromReadable
				: null) ||
			(copilotKitState?.ragContexts as string[]) ||
			(input.ragContexts as string[]) ||
			[];

		// Connected project context (meeting transcripts, docs, team
		// messages) the web client pre-fetched for an "Update Clean Spec" refresh
		// and pushed on a DEDICATED state field via flushSync, so it survives the
		// `readable non-empty > state` short-circuit above (which would drop it
		// whenever the user has an attached file). Merge it in so the model folds
		// it into the spec — it never appears in the visible chat. State-only.
		const refreshSpecContexts =
			(copilotKitState?.refreshSpecContexts as string[]) ||
			(input.refreshSpecContexts as string[]) ||
			[];
		const ragContexts = [...baseRagContexts, ...refreshSpecContexts];

		// Story-media images for the AI Feature Assistant are resolved on the
		// web client (StoryWorkspace) via `projects.stories.resolveMediaForAgent`
		// and pushed into the `rag context` readable. By the time we land
		// here, `ragContexts` already includes the synthetic base64 markdown
		// entries — the agent does NOT make any DB / storage calls itself.

		// Log RAG context metadata only (no content to avoid data leaks)
		console.log("[UnifiedServer] RAG contexts:", {
			count: ragContexts.length,
			source: ragContextsFromReadable?.length
				? "READABLE"
				: copilotKitState?.ragContexts
					? "STATE"
					: "DIRECT",
			// How many entries came from the Clean Spec refresh field.
			refreshSpecCount: refreshSpecContexts.length,
			hasTeamsMessages: ragContexts.some((ctx) =>
				ctx.startsWith("[Teams"),
			),
		});

		// Extract custom system prompt - from CopilotKit state first, then direct input
		const systemPrompt =
			(copilotKitState?.systemPrompt as string) ||
			(input.systemPrompt as string) ||
			undefined;

		// Extract current document for editing/regeneration context
		// PRIORITY: state > readable context > direct input
		// IMPORTANT: CopilotKit bidirectional state sync can lose the document field
		// when the agent responds without it (e.g., during tool-call rounds like
		// select_meetings → fetchMeetingNotes). The readable context fallback
		// ensures the agent always has the current document content.
		const readableDocData = findReadableValue("current document");
		const documentFromReadable = readableDocData?.content as
			| string
			| undefined;
		const currentDocument =
			(copilotKitState?.document as string) ||
			(documentFromReadable && documentFromReadable.trim().length > 0
				? documentFromReadable
				: null) ||
			(input.document as string) ||
			"";

		// Extract CopilotKit frontend actions from various locations
		// CopilotKit sends actions in different locations depending on the protocol version:
		// - AG-UI protocol: body.tools (array of actions)
		// - CopilotKit SDK: body.state.copilotkit.actions
		const bodyTools = input.tools as any[] | undefined;
		const stateCopilotkit = (input.state as any)?.copilotkit as
			| { actions?: any[] }
			| undefined;

		// Build copilotkit object from whichever source has actions
		// Filter out MCP server tools - they typically have patterns like "server-id_tool_name"
		// Keep only CopilotKit frontend actions which use simple names like "confirm_changes", "regenerate_document"
		const allActions = stateCopilotkit?.actions || bodyTools || [];
		const actions = allActions.filter((a: any) => {
			const name = a.name || "";
			// MCP tools have patterns like "fizzy-mcp-xxx_tool_name" or "firecrawl_tool_name"
			// They typically contain both dashes and underscores, or multiple underscores
			// CopilotKit actions are simple: "confirm_changes", "regenerate_document"
			const hasDashAndUnderscore =
				name.includes("-") && name.includes("_");
			const hasMultipleUnderscores = (name.match(/_/g) || []).length > 1;
			const isMcpTool = hasDashAndUnderscore || hasMultipleUnderscores;
			return !isMcpTool;
		});
		const copilotkit =
			actions.length > 0
				? {
						actions,
						context: readableContexts,
						// CopilotKit's LangGraph middleware owns these two fields: it
						// sets them after a model turn that intercepted frontend tool
						// calls and clears them before the next one. Its runtime guard
						// treats an empty array / empty id as "not set".
						interceptedToolCalls: [],
						originalAIMessageId: "",
					}
				: undefined;

		console.log(
			"[UnifiedServer] Streaming project_document_generator with:",
			{
				messageCount: messages.length,
				documentType,
				projectName: projectContext.name || "unnamed",
				ragContextCount: ragContexts.length,
				hasSystemPrompt: !!systemPrompt,
				systemPromptLength: systemPrompt?.length || 0,
				hasCurrentDocument: !!currentDocument,
				currentDocumentLength: currentDocument?.length || 0,
				currentDocumentPreview:
					currentDocument?.substring(0, 100) || "(empty)",
				// Debug: What state did CopilotKit send? (prioritized over input.document)
				hasCopilotKitState: !!copilotKitState,
				copilotKitStateKeys: copilotKitState
					? Object.keys(copilotKitState)
					: [],
				copilotKitStateDocLength:
					(copilotKitState?.document as string)?.length || 0,
				// Debug: show MCP filtering
				totalActionsReceived: allActions.length,
				filteredActionsCount: actions.length,
				filteredActionNames: actions.map((a: any) => a.name),
				hasConfig: !!config,
				hasConfigurable: !!config?.configurable,
				configurableKeys: config?.configurable
					? Object.keys(config.configurable)
					: [],
				hasAiConfig: !!config?.configurable?.ai_api_key,
				aiModel: config?.configurable?.ai_model,
				aiProvider: config?.configurable?.ai_provider,
				aiGatewayUrl: config?.configurable?.ai_gateway_url,
				// Log normalized message types to debug conversation flow - use _getType() for LangChain message types
				normalizedMessages: messages.map((m) => ({
					messageType: m._getType(),
					hasToolCalls:
						"tool_calls" in m &&
						!!(m as AIMessage).tool_calls?.length,
					hasToolCallId: "tool_call_id" in m,
					contentPreview:
						typeof m.content === "string"
							? m.content.substring(0, 50)
							: String(m.content).substring(0, 50),
				})),
			},
		);

		// Stream from the LangGraph graph with both updates and messages
		// IMPORTANT: Pass FULL message history to maintain conversation context
		// This is critical for the agent to know if it's after a confirmation
		const stream = await projectDocumentGeneratorGraph.stream(
			{
				messages,
				documentType,
				projectContext: {
					name: projectContext.name || "",
					techStack: projectContext.techStack || [],
					features: projectContext.features || [],
				} as ProjectContext,
				ragContexts: ragContexts,
				systemPrompt, // Pass custom system prompt from Temporal workflow or Prompt Library
				document: currentDocument, // Pass current document for regeneration context
				copilotkit, // Pass CopilotKit state (frontend actions) to the graph
				// Teams integration state for server-side tool execution
				// Priority: readable context > CopilotKit state > direct input > configurable
				hasTeamsIntegration:
					(readableProjectData?.hasTeamsIntegration as boolean) ??
					(copilotKitState?.hasTeamsIntegration as boolean) ??
					(input.hasTeamsIntegration as boolean) ??
					false,
				hasSlackIntegration:
					(readableProjectData?.hasSlackIntegration as boolean) ??
					(copilotKitState?.hasSlackIntegration as boolean) ??
					(input.hasSlackIntegration as boolean) ??
					false,
				hasRepoIntegration:
					(readableProjectData?.hasRepoIntegration as boolean) ??
					(copilotKitState?.hasRepoIntegration as boolean) ??
					(input.hasRepoIntegration as boolean) ??
					false,
				projectId:
					(readableProjectData?.projectId as string) ||
					(copilotKitState?.projectId as string) ||
					(input.projectId as string) ||
					"",
				userId:
					(copilotKitState?.userId as string) ||
					(input.userId as string) ||
					(config?.configurable?.tenant_user_id as string) ||
					"",
				organizationId:
					(copilotKitState?.organizationId as string) ||
					(input.organizationId as string) ||
					(config?.configurable?.tenant_organization_id as string) ||
					undefined,
				documentId:
					(copilotKitState?.documentId as string) ||
					(input.documentId as string) ||
					undefined,
				activeSkill: ((copilotKitState?.activeSkill ||
					input.activeSkill) ??
					undefined) as
					| {
							slug: string;
							skillMd: string;
							files: Array<{
								path: string;
								contentType: string;
								body: string;
							}>;
					  }
					| undefined,
			},
			{
				// Use both "updates" and "messages" to get node updates AND LLM token streaming
				streamMode: ["updates", "messages"] as const,
				// Pass AI provider configuration from CopilotKit
				configurable: config?.configurable,
				recursionLimit: DEFAULT_RECURSION_LIMIT,
			},
		);

		// Track state for streaming content
		let lastNodeName = "chat_node";
		let finalDocument = "";

		// Accumulates streamed write_document_local tool-call args for
		// predictive state updates, resetting on every new tool call so a
		// retried generation within this stream doesn't leak the previous
		// attempt's partial content (see PredictiveToolArgsAccumulator).
		const predictiveArgs = new PredictiveToolArgsAccumulator({
			toolName: "write_document_local",
			argKey: "document",
		});
		let streamUpdateCount = 0;

		// Iterate over stream and yield events
		for await (const chunk of stream) {
			// With streamMode: ["updates", "messages"], chunks can be:
			// 1. Node updates: [streamMode, { nodeName: stateUpdate }]
			// 2. Message chunks: [streamMode, messageChunk]
			const [streamMode, data] = chunk as [string, unknown];

			if (streamMode === "updates") {
				// Node update - chunk is in format { nodeName: stateUpdate }
				for (const [nodeName, stateUpdate] of Object.entries(
					data as Record<string, unknown>,
				)) {
					const state = stateUpdate as Record<string, unknown>;
					lastNodeName = nodeName;

					console.log(
						`[Project Document Generator] Stream update from node: ${nodeName}`,
						{
							hasDocument: !!state.document,
							hasStreamingContent: !!state.streamingContent,
							documentLength:
								(state.document as string)?.length || 0,
						},
					);

					// Update final document if we have one
					if (state.document) {
						finalDocument = state.document as string;
					}

					// Yield the update event with proper state
					yield {
						nodeName,
						state: {
							...state,
							// Ensure streamingContent is set for the UI
							streamingContent:
								state.streamingContent ||
								state.document ||
								finalDocument ||
								"",
						},
					};
				}
			} else if (streamMode === "messages") {
				// Message chunk - extract tool call arguments for predictive state updates
				// This enables real-time streaming of document content as it's being generated
				const messageChunk = data as [unknown, unknown];
				const [message] = messageChunk;

				// Debug: Log what we receive (first few chunks only)
				if (streamUpdateCount < 5) {
					console.log(
						`[Project Document Generator] Messages chunk #${streamUpdateCount}:`,
						{
							hasMessage: !!message,
							messageType: typeof message,
							hasToolCallChunks: !!(message as any)
								?.tool_call_chunks,
							toolCallChunksCount:
								(message as any)?.tool_call_chunks?.length || 0,
						},
					);
				}
				streamUpdateCount++;

				// Check if this is a tool call chunk with document content
				const msgAny = message as any;
				if (
					msgAny?.tool_call_chunks &&
					msgAny.tool_call_chunks.length > 0
				) {
					for (const toolChunk of msgAny.tool_call_chunks) {
						const partialDoc = predictiveArgs.push(
							toolChunk,
							Date.now(),
						);
						if (partialDoc !== null) {
							// Emit intermediate streaming update for predictive state
							console.log(
								"[Project Document Generator] Predictive state update:",
								{
									partialDocLength: partialDoc.length,
									preview: `${partialDoc.substring(0, 50)}...`,
								},
							);

							yield {
								nodeName: lastNodeName,
								state: {
									streamingContent: partialDoc,
									document: partialDoc, // Also update document for UI consistency
								},
								// Preview-only: each partial supersedes the last, and the
								// authoritative content arrives via the node "updates"
								// event — safe for the server to coalesce under backpressure.
								droppable: true,
							};
						}
					}
				}
			}
		}
	},
);

// Start the server
start();

export { app };
