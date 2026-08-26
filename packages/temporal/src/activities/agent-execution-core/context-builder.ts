/**
 * Context Builder
 *
 * Utilities for building agent execution context including:
 * - System prompt composition
 * - Tool mapping from template configuration
 * - Knowledge source mapping
 */

import type {
	AgentExecutionContext,
	KnowledgeSourceConfig,
	ToolConfig,
} from "./types";

/**
 * Template configuration with instruction sections
 */
export interface TemplateConfig {
	id: string;
	name: string;
	displayName: string;
	description: string;
	instructions: string | null;
	knowledgeSources: string[];
	tools: string[];
	suggestedModel: string | null;
}

/**
 * Instance configuration with user customizations
 */
export interface InstanceConfig {
	id: string;
	name: string;
	description: string | null;
	customInstructions: Record<string, unknown> | null;
	modelOverride: string | null;
	modelConfig: Record<string, unknown> | null;
}

/**
 * Connection mappings from instance
 */
export interface ConnectionMappings {
	integrationConfigurations: Array<{
		integrationId: string;
		integrationType: string;
	}>;
	toolConnections: Record<string, Record<string, unknown>>;
	workspaceIds: string[];
}

import { getCurrentDateContext } from "@repo/ai";
import { DEFAULT_MODELS } from "@repo/database/prisma/ai-model-catalog";

/**
 * Default model if none specified (canonical name from catalog).
 * The actual provider-specific ID is resolved at runtime.
 */
const DEFAULT_MODEL = DEFAULT_MODELS.CHAT;

/**
 * Build execution context from template and instance configuration
 */
export function buildAgentExecutionContext(
	template: TemplateConfig,
	instance: InstanceConfig,
	connections: ConnectionMappings,
	userId: string,
	organizationId?: string,
): AgentExecutionContext {
	// Build system prompt
	const systemPrompt = buildSystemPrompt(template, instance);

	// Determine model
	const model =
		instance.modelOverride || template.suggestedModel || DEFAULT_MODEL;

	// Map tools from template with connections
	const tools = mapToolsFromTemplate(
		template.tools,
		connections.toolConnections,
	);

	// Map knowledge sources from integration configurations
	const knowledgeSources = mapKnowledgeSources(
		connections.integrationConfigurations,
	);

	return {
		systemPrompt,
		model,
		tools,
		knowledgeSources,
		workspaceIds: connections.workspaceIds,
		userId,
		organizationId,
	};
}

/**
 * Build system prompt from template and custom instructions
 */
export function buildSystemPrompt(
	template: TemplateConfig,
	instance: InstanceConfig,
): string {
	const parts: string[] = [];

	// Start with agent identity
	parts.push(`# ${template.displayName}`);
	parts.push(template.description);

	// Add reusable template instructions
	if (template.instructions?.trim()) {
		parts.push(template.instructions.trim());
	}

	// Apply custom instructions (user overrides)
	if (instance.customInstructions) {
		const custom = instance.customInstructions;

		if (custom.role) {
			parts.push(`## Custom Role Instructions\n${custom.role}`);
		}

		if (custom.additionalContext) {
			parts.push(`## Additional Context\n${custom.additionalContext}`);
		}

		if (custom.constraints) {
			parts.push(`## Constraints\n${custom.constraints}`);
		}
	}

	// Add instance-specific description if provided
	if (instance.description) {
		parts.push(`## Instance Notes\n${instance.description}`);
	}

	const enabledCapabilities = new Set(
		template.tools.map((tool) => tool.toLowerCase()),
	);

	if (enabledCapabilities.has("go-deep")) {
		parts.push(
			[
				"## Research Mode",
				"Use a deeper, research-oriented workflow for complex requests.",
				"Plan before acting, verify important claims, compare sources when possible, and prefer higher-confidence answers over speed.",
			].join("\n"),
		);
	}

	if (enabledCapabilities.has("discover-knowledge")) {
		parts.push(
			[
				"## Workspace Discovery",
				"Before answering from memory alone, search connected workspaces and knowledge sources when they could materially improve accuracy or completeness.",
			].join("\n"),
		);
	}

	if (enabledCapabilities.has("discover-tools")) {
		parts.push(
			[
				"## Tool Discovery",
				"When external actions may help, inspect the available tools first, choose the most appropriate one deliberately, and explain what you are doing when it matters.",
			].join("\n"),
		);
	}

	if (enabledCapabilities.has("mention-users")) {
		parts.push(
			[
				"## Team Notifications",
				"If the request calls for notifying teammates or escalating work, prefer connected collaboration tools such as Slack or Microsoft Teams when available.",
			].join("\n"),
		);
	}

	if (enabledCapabilities.has("create-frames")) {
		parts.push(
			[
				"## Frame Outputs",
				"You can create, update, retrieve, list, share, and publish first-class Fabric Frames and slideshows. When the user explicitly asks for a frame, slideshow, deck, presentation, visual artifact, dashboard, or wireframe, use the Frame tool family instead of returning the visual content as plain text. Reuse existing frames when that would help.",
			].join("\n"),
		);
	}

	// Date context last — keeps the (per-request-stable) template/instruction
	// text at position 0 so provider prompt caching can match on it; the
	// date only invalidates the prefix once a day instead of every turn.
	parts.push(getCurrentDateContext());

	return parts.join("\n\n");
}

/**
 * Map tool names to tool configs with connection info
 */
function mapToolsFromTemplate(
	templateTools: string[],
	toolConnections: Record<string, Record<string, unknown>>,
): ToolConfig[] {
	return templateTools.map((toolName) => {
		const connection = toolConnections[toolName] || {};

		return {
			name: toolName,
			type: determineToolType(toolName, connection),
			configId: connection.configId as string | undefined,
			config: connection,
		};
	});
}

/**
 * Determine tool type from name and config
 */
function determineToolType(
	toolName: string,
	connection: Record<string, unknown>,
): string {
	if (connection.type) {
		return connection.type as string;
	}

	// Infer type from tool name patterns
	const toolLower = toolName.toLowerCase();

	if (toolLower.includes("web-search") || toolLower.includes("web_search")) {
		return "builtin";
	}

	if (
		toolLower.includes("agent-memory") ||
		toolLower.includes("agent_memory") ||
		toolLower.includes("create-files") ||
		toolLower.includes("create_files") ||
		toolLower.includes("create-frames") ||
		toolLower.includes("create_frames") ||
		toolLower.includes("speech-generator") ||
		toolLower.includes("speech_generator") ||
		toolLower.includes("run-agent") ||
		toolLower.includes("run_agent")
	) {
		return "builtin";
	}

	if (
		toolLower.includes("image-generation") ||
		toolLower.includes("image_generation") ||
		toolLower.includes("create-images") ||
		toolLower.includes("create_images")
	) {
		return "builtin";
	}

	if (
		toolLower.includes("execute-sql") ||
		toolLower.includes("execute_sql")
	) {
		return "integration";
	}

	// Default to MCP
	return "mcp";
}

/**
 * Map integration configurations to knowledge source configs
 */
function mapKnowledgeSources(
	integrationConfigurations: Array<{
		integrationId: string;
		integrationType: string;
	}>,
): KnowledgeSourceConfig[] {
	return integrationConfigurations.map((config) => ({
		type: config.integrationType.toLowerCase(),
		integrationId: config.integrationId,
	}));
}

/**
 * Extract built-in tool names from tool configs
 */
export function extractBuiltInToolNames(tools: ToolConfig[]): string[] {
	const names: string[] = [];

	for (const tool of tools) {
		if (tool.type === "builtin") {
			if (!names.includes(tool.name)) {
				names.push(tool.name);
			}
		}
	}

	return names;
}

/**
 * Extract MCP config IDs from tool configs
 */
export function extractMcpConfigIds(tools: ToolConfig[]): string[] {
	const configIds: string[] = [];

	for (const tool of tools) {
		if (tool.type === "mcp" && tool.configId) {
			if (!configIds.includes(tool.configId)) {
				configIds.push(tool.configId);
			}
		}
	}

	return configIds;
}

/**
 * Build a simple context string from user input
 */
export function buildUserInputContext(input: Record<string, unknown>): string {
	const message =
		(input.message as string) ||
		(input.prompt as string) ||
		(input.query as string);

	if (message) {
		return message;
	}

	// Fallback to JSON representation
	return JSON.stringify(input, null, 2);
}
