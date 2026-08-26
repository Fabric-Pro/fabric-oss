/**
 * Agent Execution Activities
 *
 * Handles the core agent turn execution with LLM calls.
 * Uses Anthropic SDK directly (like Weft) to avoid AI Gateway schema issues.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
	MessageParam,
	TextBlock,
	Tool,
	ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages";
import {
	getAIModelWithMetadata,
	getCurrentDateContext,
	logModelUsageAsync,
} from "@repo/ai";
import { getAiProviderApiKeyByProvider } from "@repo/database";
import {
	GITHUB_WORKFLOW_GUIDANCE,
	getAlwaysEnabledWorkflowGuidance,
	MICROSOFT_TEAMS_WORKFLOW_GUIDANCE,
} from "@repo/mcp-registry";
import { withProviderBreaker } from "@repo/observability";
import { decryptApiKey } from "@repo/utils";
import { publishAgentThinking } from "./partykit-publisher";
import type { ExecuteAgentTurnInput, ExecuteAgentTurnOutput } from "./types";

/**
 * Execute a single agent turn (LLM call)
 * Uses Anthropic SDK directly to avoid AI Gateway schema transformation issues
 */
export async function executeAgentTurn(
	input: ExecuteAgentTurnInput,
): Promise<ExecuteAgentTurnOutput> {
	const { messages, mcpConfig, userId, organizationId, projectId } = input;

	// Get Anthropic API key directly (this agent uses Anthropic SDK directly)
	const anthropicConfig = await getAiProviderApiKeyByProvider({
		provider: "ANTHROPIC_DIRECT",
		userId,
		organizationId,
	});

	if (!anthropicConfig?.apiKey) {
		throw new Error(
			"Anthropic API key not configured. Please add your Anthropic API key in Settings > AI Configuration.",
		);
	}

	const apiKey = decryptApiKey(anthropicConfig.apiKey);
	const client = new Anthropic({ apiKey });

	// Get model from centralized entry point for TOOL_CALLING task type
	const { metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "TOOL_CALLING" },
		{ userId, organizationId },
	);

	// Track usage (fire-and-forget)
	trackUsage();

	// Extract base model name (strip provider prefix if present)
	const modelName = metadata.modelString.includes("/")
		? metadata.modelString.split("/").pop()
		: metadata.modelString;

	if (!modelName) {
		throw new Error(
			"No AI model configured for tool calling. Please configure a model in Settings → AI Models.",
		);
	}

	// Build Claude tools from MCP config (like Weft does)
	const tools: Tool[] = [];

	for (const mcpTool of mcpConfig.tools) {
		// Get base schema from MCP tool, ensure it has proper type: "object"
		const baseSchema = mcpTool.inputSchema || {};

		// Build a valid JSON Schema - always ensure type: "object" is set
		const inputSchema: Tool["input_schema"] = {
			type: "object",
			properties: baseSchema.properties || {},
		};

		// Add required fields if present
		if (
			Array.isArray(baseSchema.required) &&
			baseSchema.required.length > 0
		) {
			inputSchema.required = baseSchema.required;
		}

		tools.push({
			name: mcpTool.name,
			description: `[${mcpTool.serverName}] ${mcpTool.description}`,
			input_schema: inputSchema,
		});
	}

	// Add request_approval tool
	tools.push({
		name: "request_approval",
		description:
			"Pause execution and ask user for approval before proceeding. Use this before sending emails, creating documents, or any irreversible action.",
		input_schema: {
			type: "object",
			properties: {
				tool: {
					type: "string",
					description: "The MCP tool that will be called if approved",
				},
				action: {
					type: "string",
					description: "Short human-readable action label",
				},
				data: {
					type: "object",
					description: "The data that will be passed to the tool",
				},
			},
			required: ["tool", "action", "data"],
		},
	});

	// Check if GitHub tools are connected (look for github-connected: prefix in configIds)
	const hasGitHubConnected = mcpConfig.tools.some((t) =>
		t.configId.startsWith("github-connected:"),
	);

	// Check if Microsoft Teams tools are connected (look for microsoft-teams-connected: prefix in configIds)
	const hasMicrosoftTeamsConnected = mcpConfig.tools.some((t) =>
		t.configId.startsWith("microsoft-teams-connected:"),
	);

	// Build system prompt
	const systemPrompt = buildAgentSystemPrompt(
		mcpConfig.tools,
		hasGitHubConnected,
		hasMicrosoftTeamsConnected,
	);

	// Convert messages to Anthropic format
	const anthropicMessages: MessageParam[] = messages.map((m) => {
		if (m.role === "tool") {
			// Tool result message - Anthropic expects this as a user message with tool_result
			return {
				role: "user" as const,
				content: [
					{
						type: "tool_result" as const,
						tool_use_id: m.tool_call_id,
						content:
							typeof m.content === "string"
								? m.content
								: JSON.stringify(m.content),
					},
				],
			};
		}
		if (m.role === "assistant" && Array.isArray(m.content)) {
			// Assistant message with tool calls - convert to Anthropic format
			return {
				role: "assistant" as const,
				content: m.content.map((block: any) => {
					if (block.type === "tool-call") {
						return {
							type: "tool_use" as const,
							id: block.toolCallId,
							name: block.toolName,
							input: block.input || block.args || {},
						};
					}
					if (block.type === "text") {
						return {
							type: "text" as const,
							text: block.text,
						};
					}
					// Pass through other types
					return block;
				}),
			};
		}
		// Regular text message
		return {
			role: m.role as "user" | "assistant",
			content:
				typeof m.content === "string"
					? m.content
					: JSON.stringify(m.content),
		};
	});

	// Use streaming to publish partial responses in real-time
	const { planId, turnIndex } = input;
	let fullText = "";
	let lastPublishTime = 0;
	const PUBLISH_INTERVAL_MS = 200; // Throttle updates to every 200ms
	const generationStart = Date.now();

	console.log(`[DEBUG] Calling Anthropic with ${tools.length} tools`);

	// Wrap the entire Anthropic streaming round-trip with the
	// Cockatiel breaker so consecutive failures trip the circuit and
	// every attempt increments `provider_request_total`.
	const finalMessage = await withProviderBreaker(
		"anthropic",
		"messages_stream",
		async () => {
			// Use Anthropic SDK streaming (like Weft does)
			const stream = client.messages.stream({
				model: modelName,
				max_tokens: 8192,
				system: systemPrompt,
				messages: anthropicMessages,
				tools,
			});

			// Handle streaming text events
			stream.on("text", (text) => {
				fullText += text;

				// Throttle PartyKit updates
				const now = Date.now();
				if (now - lastPublishTime > PUBLISH_INTERVAL_MS) {
					lastPublishTime = now;
					// Non-blocking publish
					publishAgentThinking(planId, turnIndex, fullText).catch(
						() => {
							// Ignore publish errors
						},
					);
				}
			});

			// Wait for the final message
			return stream.finalMessage();
		},
	);
	logModelUsageAsync({
		context: { userId, organizationId },
		metadata,
		taskType: "TOOL_CALLING",
		usage: {
			inputTokens: finalMessage.usage?.input_tokens ?? 0,
			outputTokens: finalMessage.usage?.output_tokens ?? 0,
			totalTokens:
				(finalMessage.usage?.input_tokens ?? 0) +
				(finalMessage.usage?.output_tokens ?? 0),
		},
		latencyMs: Date.now() - generationStart,
		projectId,
	});

	// Final publish with complete text
	if (fullText) {
		publishAgentThinking(planId, turnIndex, fullText).catch(() => {});
	}

	// Extract text content from response
	const responseText = finalMessage.content
		.filter((block): block is TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("\n");

	// Extract tool calls if any
	const toolUses = finalMessage.content.filter(
		(block): block is ToolUseBlock => block.type === "tool_use",
	);

	const toolCalls = toolUses.map((tc) => ({
		id: tc.id,
		name: tc.name,
		args: tc.input as Record<string, unknown>,
	}));

	// Get summary from response
	const summary =
		responseText.length > 100
			? `${responseText.substring(0, 100)}...`
			: responseText || "Thinking...";

	// Map Anthropic stop_reason to our format
	const stopReason =
		finalMessage.stop_reason === "tool_use"
			? "tool-calls"
			: finalMessage.stop_reason || "unknown";

	return {
		response: responseText,
		summary,
		toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
		stopReason,
	};
}

/**
 * Build the system prompt for the agent
 */
function buildAgentSystemPrompt(
	tools: Array<{ name: string; serverName: string }>,
	hasGitHubConnected = false,
	hasMicrosoftTeamsConnected = false,
): string {
	const toolsList = tools
		.reduce((acc: Array<{ server: string; tools: string[] }>, mcpTool) => {
			const existing = acc.find((g) => g.server === mcpTool.serverName);
			if (existing) {
				existing.tools.push(
					mcpTool.name.split("__")[1] || mcpTool.name,
				);
			} else {
				acc.push({
					server: mcpTool.serverName,
					tools: [mcpTool.name.split("__")[1] || mcpTool.name],
				});
			}
			return acc;
		}, [])
		.map((g) => `- **${g.server}**: ${g.tools.join(", ")}`)
		.join("\n");

	// Get workflow guidance for always-enabled MCPs
	let workflowGuidance = getAlwaysEnabledWorkflowGuidance();

	// Add GitHub guidance if connected
	if (hasGitHubConnected && GITHUB_WORKFLOW_GUIDANCE) {
		workflowGuidance = workflowGuidance
			? `${workflowGuidance}\n\n${GITHUB_WORKFLOW_GUIDANCE}`
			: GITHUB_WORKFLOW_GUIDANCE;
	}

	// Add Microsoft Teams guidance if connected
	if (hasMicrosoftTeamsConnected && MICROSOFT_TEAMS_WORKFLOW_GUIDANCE) {
		workflowGuidance = workflowGuidance
			? `${workflowGuidance}\n\n${MICROSOFT_TEAMS_WORKFLOW_GUIDANCE}`
			: MICROSOFT_TEAMS_WORKFLOW_GUIDANCE;
	}

	return `You are a helpful AI assistant that accomplishes tasks using available tools.

## Available Tools
${toolsList}
- **request_approval**: Pause and ask user for approval

## Guidelines
1. **Think step by step** - Break down complex tasks into smaller steps
2. **Use tools effectively** - Call tools to gather information and take actions
3. **Request approval before irreversible actions** - Use request_approval before sending emails, creating documents, making commits, etc.
4. **Be concise** - Keep responses focused and to the point
5. **Handle errors gracefully** - If a tool fails, try to recover or explain what went wrong

## Approval Guidelines
Always request approval before:
- Sending emails or messages
- Creating or modifying documents or spreadsheets
- Making commits or pushing code
- Any action that modifies external systems

When requesting approval, include:
- Clear description of what you want to do
- Preview of the content (email body, document content, etc.)
- Any relevant context the user needs to make a decision

**CRITICAL: Handling user edits in approval responses**
When the approval result contains a \`userData\` field, the user has edited the data during approval.
You MUST use the values from \`userData\` to override your original data when calling the actual tool.

${workflowGuidance ? `## Tool-Specific Workflow Guidance\n\n${workflowGuidance}` : ""}

${getCurrentDateContext()}`;
}
