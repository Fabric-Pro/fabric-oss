/**
 * Unified Server for Document Generator
 *
 * Single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 * This replaces the need for separate AG-UI and A2A servers.
 *
 * Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - LangGraph Platform API: /runs/stream, /threads/:id/runs/stream (for CopilotKit LangGraphAgent)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 */

import type { AIMessage } from "@langchain/core/messages";
import {
	type AgentRuntimeConfig,
	type AgentSkill,
	createUnifiedServer,
	getUserFacingError,
	type LangGraphStreamEvent,
	PredictiveToolArgsAccumulator,
} from "@repo/agent-core";
import type { DocumentType, ProjectContext } from "@repo/agent-types";
import { v4 as uuidv4 } from "uuid";
import { predictiveStateUpdatesGraph } from "./agent.js";
import { createInvokeAgent, normalizeMessages } from "./invoke-agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8124", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "generate-document",
		name: "Generate Document",
		description: "Generate a document based on a prompt and document type",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "What to write about" },
				documentType: {
					type: "string",
					description: "Type of document to generate",
					enum: [
						"general",
						"article",
						"summary",
						"api-docs",
						"readme",
					],
				},
			},
			required: ["prompt"],
		},
		examples: [
			"Write an article about machine learning",
			"Generate API documentation for the user service",
			"Create a README for my project",
		],
		tags: ["documentation", "content", "writing"],
	},
	{
		id: "generate-summary",
		name: "Generate Summary",
		description: "Generate a summary of content or topic",
		examples: [
			"Summarize the key features of React",
			"Create a summary of the meeting notes",
		],
		tags: ["summary", "content"],
	},
	{
		id: "generate-readme",
		name: "Generate README",
		description: "Generate a README file for a project",
		examples: [
			"Create a README for my Node.js project",
			"Generate project documentation",
		],
		tags: ["readme", "documentation", "project"],
	},
];

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "document_generator",
		description:
			"General document generator agent for creating articles, summaries, API docs, README files, and other content.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: ["documentation", "content", "writing", "langgraph"],
		supportsStreaming: true, // Enable streaming for CopilotKit
	},
	// Invoke function - wraps the LangGraph graph
	createInvokeAgent(predictiveStateUpdatesGraph),
	// Transform output for A2A response
	(output) => {
		const document = (output.document as string) || "";

		return {
			error: getUserFacingError(output.error),
			response: document,
			artifacts: document
				? [
						{
							id: uuidv4(),
							name: "document",
							description: "Generated document",
							mimeType: "text/markdown",
							parts: [{ type: "text", text: document }],
						},
					]
				: [],
			metadata: {
				error: output.error,
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
		const rawMessages = input.messages as Array<Record<string, unknown>>;
		// Normalize messages from CopilotKit format to LangChain format
		const messages = normalizeMessages(rawMessages);
		const documentType = ((input.documentType as string) ||
			"general") as DocumentType;
		// CRITICAL: Extract document from CopilotKit state
		// CopilotKit sends agent state in body.state, which gets spread into input
		// This is the current document content that should be preserved during follow-up edits
		const copilotKitState = input.state as
			| Record<string, unknown>
			| undefined;
		const document =
			(copilotKitState?.document as string) ||
			(input.document as string) ||
			"";

		// Extract project context and RAG contexts if available
		const projectContext = (input.projectContext ||
			copilotKitState?.projectContext) as ProjectContext | undefined;
		const ragContexts = (input.ragContexts ||
			copilotKitState?.ragContexts ||
			[]) as string[];

		console.log("[UnifiedServer] Streaming document_generator with:", {
			messageCount: messages.length,
			documentType,
			// Log document state to debug content preservation
			hasDocument: !!document,
			documentLength: document.length,
			documentPreview: document.substring(0, 100),
			hasProjectContext: !!projectContext,
			hasRagContexts: ragContexts.length > 0,
			ragContextCount: ragContexts.length,
			// Debug: What state did CopilotKit send?
			hasCopilotKitState: !!copilotKitState,
			copilotKitStateKeys: copilotKitState
				? Object.keys(copilotKitState)
				: [],
			copilotKitStateDocLength:
				(copilotKitState?.document as string)?.length || 0,
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
					"tool_calls" in m && !!(m as AIMessage).tool_calls?.length,
				hasToolCallId: "tool_call_id" in m,
				contentPreview:
					typeof m.content === "string"
						? m.content.substring(0, 50)
						: String(m.content).substring(0, 50),
			})),
		});

		// Stream from the LangGraph graph with both updates and messages
		// IMPORTANT: Pass FULL message history AND document state to maintain context
		// The document is critical for the agent to know what content to preserve
		// Include project context and RAG contexts if available for improved document quality
		const stream = await predictiveStateUpdatesGraph.stream(
			{
				messages,
				documentType,
				document, // Pass the current document for content preservation
				projectContext, // Optional project context for context-aware generation
				ragContexts, // Optional RAG contexts for improved accuracy
				tools: [],
			},
			{
				// Use both "updates" and "messages" to get node updates AND LLM token streaming
				streamMode: ["updates", "messages"] as const,
				// Pass AI provider configuration from CopilotKit
				configurable: config?.configurable,
				recursionLimit: DEFAULT_RECURSION_LIMIT,
			},
		);

		// Track accumulated tool call arguments for streaming content
		let accumulatedDocument = "";
		let lastNodeName = "chat_node";

		// Accumulates streamed write_document_local tool-call args for
		// predictive state updates, resetting on every new tool call so a
		// retried generation within this stream doesn't leak the previous
		// attempt's partial content (see PredictiveToolArgsAccumulator).
		const predictiveArgs = new PredictiveToolArgsAccumulator({
			toolName: "write_document_local",
			argKey: "document",
		});

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

					// Check for tool_calls in messages
					const messagesWithToolCalls = Array.isArray(state.messages)
						? (
								state.messages as Array<Record<string, unknown>>
							).filter(
								(m) =>
									m &&
									typeof m === "object" &&
									"tool_calls" in m,
							)
						: [];
					console.log(
						`[UnifiedServer] Stream update from node: ${nodeName}`,
						{
							hasDocument: !!state.document,
							documentLength:
								(state.document as string)?.length || 0,
							messageCount: Array.isArray(state.messages)
								? state.messages.length
								: 0,
							messagesWithToolCalls: messagesWithToolCalls.length,
							toolCallsDetails: messagesWithToolCalls.map(
								(m) => ({
									role: m.role,
									toolCalls: m.tool_calls,
								}),
							),
						},
					);

					// Update accumulated document if we have a final document
					if (state.document) {
						accumulatedDocument = state.document as string;
					}

					// Yield the update event
					// Use document as streamingContent since this agent doesn't have streamingContent
					yield {
						nodeName,
						state: {
							...state,
							streamingContent:
								state.document || accumulatedDocument || "",
						},
					};
				}
			} else if (streamMode === "messages") {
				// Message chunk - extract tool call arguments for streaming
				const messageChunk = data as [unknown, unknown];
				const [message] = messageChunk;

				// Check if this is a tool call chunk with document content
				const msgAny = message as any;
				if (msgAny?.tool_call_chunks) {
					for (const toolChunk of msgAny.tool_call_chunks) {
						const partialDoc = predictiveArgs.push(
							toolChunk,
							Date.now(),
						);
						if (partialDoc !== null) {
							// Emit intermediate streaming update
							yield {
								nodeName: lastNodeName,
								state: {
									streamingContent: partialDoc,
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
