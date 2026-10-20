/**
 * Unified Server for Backlog Updater
 *
 * Single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 *
 * Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 */

import {
	type AgentRuntimeConfig,
	type AgentSkill,
	createUnifiedServer,
	getUserFacingError,
	type LangGraphStreamEvent,
} from "@repo/agent-core";
import { backlogUpdaterGraph } from "./agent.js";
import { createInvokeAgent, extractState } from "./invoke-agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8135", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "analyze-backlog",
		name: "Analyze Backlog",
		description:
			"Analyze project context from Teams, meetings, and Notion to suggest backlog updates",
		parameters: {
			type: "object",
			properties: {
				projectId: {
					type: "string",
					description: "The project ID to analyze",
				},
				userPrompt: {
					type: "string",
					description: "What to analyze or update",
				},
			},
			required: ["projectId"],
		},
		examples: [
			"Analyze recent Teams messages and suggest backlog updates",
			"Review meetings and project-linked Teams conversations for new requirements",
		],
		tags: ["backlog", "analysis", "context"],
	},
	{
		id: "apply-changes",
		name: "Apply Backlog Changes",
		description:
			"Apply approved changes to the backlog (create/update epics, features, stories)",
		examples: [
			"Apply the approved changes to the backlog",
			"Create the new stories from the analysis",
		],
		tags: ["backlog", "update", "stories"],
	},
];

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "backlog_updater",
		description:
			"AI-powered backlog analysis and update from project context (Teams, meetings, Notion). Analyzes context and proposes create/update operations on epics, features, and stories.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: ["backlog", "kanban", "stories", "epics", "langgraph"],
		supportsStreaming: true,
	},
	// Invoke function - wraps the LangGraph graph (used for A2A and non-streaming)
	createInvokeAgent(backlogUpdaterGraph),
	// Transform output for A2A response
	(output) => {
		const lastMessage = (output.messages as Array<{ content: string }>)?.at(
			-1,
		);
		const response = lastMessage?.content || "";

		return {
			error: getUserFacingError(output.error),
			response,
			artifacts: [],
			metadata: {
				analysisStatus: output.analysisStatus,
				lastProposalSummary: output.lastProposalSummary,
				error: output.error,
			},
		};
	},
	// Stream agent (A2A streaming) - not used
	undefined,
	// Platform stream agent for CopilotKit AG-UI protocol
	async function* (
		input: { messages: Array<{ role: string; content: string }> } & Record<
			string,
			unknown
		>,
		config?: AgentRuntimeConfig,
	): AsyncGenerator<LangGraphStreamEvent> {
		const agentState = extractState(input);

		// Extract CopilotKit frontend action tools from the request body
		// These are registered via useCopilotAction in BacklogChat and need to be
		// bound to the model so it makes proper tool calls instead of text output
		const rawTools = (input.tools as any[]) || [];

		// Convert CopilotKit tools to the format LangChain's bindTools expects
		// CopilotKit may send tools in various formats - normalize to { name, description, parameters }
		const copilotKitTools = rawTools.map((tool: any) => {
			// Handle OpenAI-style { type: "function", function: { name, description, parameters } }
			if (tool.type === "function" && tool.function) {
				return {
					name: tool.function.name,
					description: tool.function.description || "",
					schema: tool.function.parameters || {
						type: "object",
						properties: {},
					},
				};
			}
			// Handle simple { name, description, parameters } format
			return {
				name: tool.name,
				description: tool.description || "",
				schema: tool.parameters || {
					type: "object",
					properties: {},
				},
			};
		});

		// Normalize CopilotKit messages to LangChain format
		// CopilotKit sends tool results as { type: "tool", toolCallId: "..." }
		// but LangGraph expects { role: "tool", tool_call_id: "..." }
		const normalizedMessages = input.messages.map((msg: any) => {
			// Tool result messages: CopilotKit uses type="tool", LangGraph needs role="tool"
			if (msg.type === "tool" || msg.role === "tool") {
				return {
					role: "tool" as const,
					content:
						typeof msg.content === "string"
							? msg.content
							: JSON.stringify(msg.content),
					tool_call_id: msg.toolCallId || msg.tool_call_id || msg.id,
				};
			}
			// AI messages with tool_calls: normalize tool_calls format
			if (
				msg.role === "assistant" &&
				msg.tool_calls &&
				Array.isArray(msg.tool_calls)
			) {
				return {
					role: "assistant" as const,
					content: msg.content || "",
					tool_calls: msg.tool_calls.map((tc: any) => ({
						id: tc.id,
						name: tc.name || tc.function?.name,
						args:
							tc.args ||
							(typeof tc.function?.arguments === "string"
								? JSON.parse(tc.function.arguments)
								: tc.function?.arguments) ||
							{},
						type: "tool_call" as const,
					})),
				};
			}
			// Human/user messages
			const role =
				msg.role ||
				(msg.type === "human"
					? "user"
					: msg.type === "ai"
						? "assistant"
						: "user");
			return { ...msg, role };
		});

		console.log("[UnifiedServer] Streaming backlog_updater with:", {
			projectId: agentState.projectId,
			projectName: agentState.projectName,
			messageCount: normalizedMessages.length,
			toolCount: copilotKitTools.length,
			hasAiConfig: !!config?.configurable?.ai_api_key,
			aiModel: config?.configurable?.ai_model,
			aiProvider: config?.configurable?.ai_provider,
			messageTypes: normalizedMessages.map((m: any) => ({
				role: m.role,
				hasToolCalls: !!m.tool_calls,
				hasToolCallId: !!m.tool_call_id,
			})),
		});

		// Stream from the LangGraph graph with AI config passed through
		const stream = await backlogUpdaterGraph.stream(
			{
				messages: normalizedMessages,
				...agentState,
				tools: copilotKitTools,
			},
			{
				streamMode: ["updates", "messages"] as const,
				configurable: config?.configurable,
				recursionLimit: DEFAULT_RECURSION_LIMIT,
			},
		);

		for await (const chunk of stream) {
			const [streamMode, data] = chunk as [string, unknown];

			if (streamMode === "updates") {
				for (const [nodeName, stateUpdate] of Object.entries(
					data as Record<string, unknown>,
				)) {
					yield {
						nodeName,
						state: stateUpdate as Record<string, unknown>,
					};
				}
			}
		}
	},
);

// Start the server
start();

export { app };
