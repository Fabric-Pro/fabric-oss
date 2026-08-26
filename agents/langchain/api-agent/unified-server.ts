/**
 * Unified Server for API Agent
 *
 * Single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 * This replaces the need for separate AG-UI and A2A servers.
 *
 * Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 */

import {
	type AgentRuntimeConfig,
	type AgentSkill,
	createUnifiedServer,
	type LangGraphStreamEvent,
} from "@repo/agent-core";
import { v4 as uuidv4 } from "uuid";
import { apiAgentGraph } from "./agent.js";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8127", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "execute-openapi-tool",
		name: "Execute OpenAPI Tool",
		description:
			"Execute operations from registered OpenAPI specifications",
		parameters: {
			type: "object",
			properties: {
				taskDescription: {
					type: "string",
					description: "Description of the API operation to perform",
				},
				context: {
					type: "string",
					description: "Additional context for the API call",
				},
			},
			required: ["taskDescription"],
		},
		examples: [
			"Get the current weather for New York",
			"Create a new user in the CRM system",
			"Search for products matching 'laptop'",
		],
		tags: ["api", "openapi", "rest"],
	},
	{
		id: "call-external-api",
		name: "Call External API",
		description:
			"Make authenticated API calls to external services using OpenAPI specs",
		examples: [
			"Send a notification via Slack API",
			"Create a GitHub issue",
			"Update a Jira ticket",
		],
		tags: ["api", "http", "integration"],
	},
];

/**
 * Build the LangGraph `configurable` that carries tenant identity + AI provider
 * config into the api-agent nodes.
 *
 * Credentials reach this server two ways:
 *  - A2A / orchestrator path: flattened into the executor `input` (the unified
 *    server's /a2a/send merges them into the message metadata, using
 *    `ai_base_url` for the workspace host).
 *  - Direct CopilotKit path (/runs/stream): in the runtime `config.configurable`,
 *    where createUnifiedServer has already exchanged the X-AI-Token header into
 *    `ai_api_key`. This copy never appears in `input`, so the platform stream
 *    executor MUST forward it explicitly.
 *
 * Merging both lets getAgentModelAsync → createProviderModel resolve the
 * tenant's model for every provider, including Databricks (Unity AI Gateway).
 */
function buildAgentConfigurable(
	input: Record<string, unknown>,
	runtimeConfigurable: Record<string, unknown> = {},
): Record<string, unknown> {
	const str = (v: unknown): string | undefined =>
		typeof v === "string" && v.length > 0 ? v : undefined;
	// Prefer the token-exchanged runtime config (CopilotKit) over raw input (A2A).
	const pick = (key: string): string | undefined =>
		str(runtimeConfigurable[key]) ?? str(input[key]);

	const tenantUserId = pick("tenant_user_id") ?? str(input.userId);
	const tenantOrgId =
		pick("tenant_organization_id") ?? str(input.organizationId);

	return {
		// Context the nodes use for OpenAPI tool loading. On the CopilotKit
		// /runs/stream path the app route supplies this via
		// runtimeConfigurable.fabric_api_url (snake_case, from forwarded
		// properties); the sync/A2A path supplies input.fabricApiUrl
		// (camelCase). Fall back to env last — docker-compose sets only
		// RUNTIME_API_URL (same web target), not FABRIC_API_URL, so accept it.
		fabric_api_url:
			str(runtimeConfigurable.fabric_api_url) ??
			str(input.fabric_api_url) ??
			str(input.fabricApiUrl) ??
			process.env.FABRIC_API_URL ??
			process.env.RUNTIME_API_URL,
		user_id: str(input.userId) ?? tenantUserId,
		organization_id: str(input.organizationId) ?? tenantOrgId,
		openapi_tools: input.openapi_tools ?? runtimeConfigurable.openapi_tools,
		// Tenant + AI provider config consumed by getAgentModelAsync.
		tenant_user_id: tenantUserId,
		tenant_organization_id: tenantOrgId,
		ai_token: pick("ai_token"),
		ai_api_key: pick("ai_api_key"),
		ai_model: pick("ai_model"),
		ai_provider: pick("ai_provider"),
		// A2A sends the workspace host as `ai_base_url`; the platform/CopilotKit
		// path sends it as `ai_gateway_url`. extractProviderConfig reads
		// `ai_gateway_url`, so normalize to that.
		ai_gateway_url: pick("ai_gateway_url") ?? str(input.ai_base_url),
		ai_deployment_name: pick("ai_deployment_name"),
	};
}

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "api_agent",
		description:
			"Executes external API calls based on registered OpenAPI specifications. Best for calling REST APIs, integrating with third-party services, and data retrieval using OpenAPI Services.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: ["api", "openapi", "integration", "rest", "langgraph"],
		supportsStreaming: false,
	},
	// Invoke function - wraps the LangGraph graph
	async (input) => {
		const messages = input.messages as Array<{
			role: string;
			content: string;
		}>;
		const lastMessage = messages[messages.length - 1];
		const userMessage = lastMessage?.content || "";
		const taskDescription =
			(input.taskDescription as string) || userMessage;
		const context = input.context as string | undefined;
		// Tenant + AI provider config, forwarded into the graph so nodes can
		// resolve the tenant's model via getAgentModelAsync → createProviderModel.
		// On this synchronous path (used by A2A) the credentials arrive flattened
		// into `input`; see buildAgentConfigurable.
		const configurable = buildAgentConfigurable(input);

		console.log("[UnifiedServer] Invoking api_agent with:", {
			taskDescriptionLength: taskDescription.length,
			hasContext: !!context,
			hasFabricApiUrl: !!configurable.fabric_api_url,
			tenantUserId: configurable.tenant_user_id || "NOT SET",
			aiProvider: configurable.ai_provider || "NOT SET",
			hasAiApiKey: !!configurable.ai_api_key,
		});

		// Invoke the LangGraph graph
		const graphResult = await apiAgentGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				taskDescription,
				context,
				fabricApiUrl: configurable.fabric_api_url as string | undefined,
				userId: configurable.user_id as string | undefined,
				organizationId: configurable.organization_id as
					| string
					| undefined,
				availableTools: [],
			},
			{ configurable },
		);

		// Cast to access properties
		const result = graphResult as unknown as {
			response?: string;
			messages: unknown[];
			executionResult?: unknown;
			selectedTool?: unknown;
			error?: string;
		};

		console.log("[UnifiedServer] Graph result:", {
			hasResponse: !!result.response,
			responseLength: result.response?.length || 0,
			hasExecutionResult: !!result.executionResult,
		});

		// Convert BaseMessage[] to simple message format
		const outputMessages = (result.messages || []).map((msg) => ({
			role:
				typeof msg === "object" && msg !== null && "role" in msg
					? String((msg as Record<string, unknown>).role)
					: "assistant",
			content:
				typeof msg === "object" && msg !== null && "content" in msg
					? String((msg as Record<string, unknown>).content)
					: String(msg),
		}));

		return {
			response: result.response || "",
			messages: outputMessages,
			executionResult: result.executionResult,
			selectedTool: result.selectedTool,
			error: result.error,
		};
	},
	// Transform output for A2A response
	(output) => {
		const response = (output.response as string) || "";

		return {
			response,
			artifacts: response
				? [
						{
							id: uuidv4(),
							name: "api-response",
							description: "API execution result",
							mimeType: "application/json",
							parts: [{ type: "text", text: response }],
						},
					]
				: [],
			metadata: {
				executionResult: output.executionResult,
				selectedTool: output.selectedTool,
				error: output.error,
			},
		};
	},
	// A2A streaming executor — unused (this agent is non-streaming).
	undefined,
	// Platform streaming executor for CopilotKit's LangGraph agent (/runs/stream).
	// REQUIRED: it is the only executor createUnifiedServer hands the runtime
	// `config`, which carries the token-exchanged AI credentials on the CopilotKit
	// path. Without it, that path falls back to the synchronous invoke (which only
	// sees `input`, never the credentials) and model resolution fails.
	async function* (
		input,
		config?: AgentRuntimeConfig,
	): AsyncGenerator<LangGraphStreamEvent> {
		const messages = input.messages as Array<{
			role: string;
			content: string;
		}>;
		const lastMessage = messages[messages.length - 1];
		const userMessage = lastMessage?.content || "";
		const taskDescription =
			(input.taskDescription as string) || userMessage;
		const context = input.context as string | undefined;

		const configurable = buildAgentConfigurable(
			input,
			config?.configurable,
		);

		console.log("[UnifiedServer] Streaming api_agent with:", {
			taskDescriptionLength: taskDescription.length,
			tenantUserId: configurable.tenant_user_id || "NOT SET",
			aiProvider: configurable.ai_provider || "NOT SET",
			hasAiApiKey: !!configurable.ai_api_key,
		});

		// api_agent is a non-streaming pipeline (analyze → execute → format);
		// run it to completion and emit a single final state event.
		const result = (await apiAgentGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				taskDescription,
				context,
				fabricApiUrl: configurable.fabric_api_url as string | undefined,
				userId: configurable.user_id as string | undefined,
				organizationId: configurable.organization_id as
					| string
					| undefined,
				availableTools: [],
			},
			{ configurable },
		)) as Record<string, unknown>;

		yield {
			nodeName: "api_agent",
			state: result,
			isFinal: true,
		};
	},
);

// Start the server
start();

export { app };
