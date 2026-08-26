/**
 * A2A Protocol Server for API Agent
 *
 * Exposes the LangGraph agent via A2A protocol endpoints so it can be
 * discovered and invoked by the orchestrator agent.
 */

import { serve } from "@hono/node-server";
import type { AgentSkill } from "@repo/agent-core";
import { A2AServer, createLangGraphA2AExecutor } from "@repo/agent-core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { apiAgentGraph } from "./agent.js";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8231", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const FABRIC_API_URL = process.env.FABRIC_API_URL || "http://localhost:3001";

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "execute-openapi-tool",
		name: "Execute OpenAPI Tool",
		description: "Execute an API call using registered OpenAPI services",
		parameters: {
			type: "object",
			properties: {
				request: {
					type: "string",
					description: "Description of the API call to make",
				},
				context: {
					type: "string",
					description: "Additional context for the API call",
				},
			},
			required: ["request"],
		},
		examples: [
			"Get the current weather in San Francisco",
			"Create a new user with email test@example.com",
			"Fetch the latest stock price for AAPL",
			"Search for products matching 'laptop'",
		],
		tags: ["api", "openapi", "http", "external"],
	},
	{
		id: "list-available-apis",
		name: "List Available APIs",
		description: "List all available OpenAPI services and their endpoints",
		examples: [
			"What APIs are available?",
			"Show me the available API endpoints",
		],
		tags: ["api", "discovery"],
	},
];

// Create A2A executor that wraps the LangGraph graph
const a2aExecutor = createLangGraphA2AExecutor(
	async (input) => {
		// Transform A2A input to LangGraph state
		const messages = input.messages as Array<{
			role: string;
			content: string;
		}>;
		const lastMessage = messages[messages.length - 1];
		const userMessage = lastMessage?.content || "";

		console.log("[A2A Server] Invoking API Agent graph with:", {
			messageLength: userMessage.length,
			fabricApiUrl: FABRIC_API_URL,
		});

		// Invoke the LangGraph graph with configuration
		const result = await apiAgentGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				taskDescription: userMessage,
				context: input.context as string | undefined,
			},
			{
				configurable: {
					fabric_api_url: FABRIC_API_URL,
					user_id: input.userId,
					organization_id: input.organizationId,
					openapi_tools: input.openapi_tools,
					// Tenant + AI provider config so nodes can resolve the
					// tenant's model via getAgentModelAsync (createProviderModel).
					tenant_user_id: input.tenant_user_id ?? input.userId,
					tenant_organization_id:
						input.tenant_organization_id ?? input.organizationId,
					ai_token: input.ai_token,
					ai_api_key: input.ai_api_key,
					ai_model: input.ai_model,
					ai_provider: input.ai_provider,
					ai_gateway_url: input.ai_gateway_url ?? input.ai_base_url,
					ai_deployment_name: input.ai_deployment_name,
				},
			},
		);

		console.log("[A2A Server] Graph result:", {
			hasResponse: !!result.response,
			stage: result.stage,
			hasError: !!result.error,
		});

		return {
			response: result.response || "",
			messages: result.messages,
			error: result.error,
			executionResult: result.executionResult,
		};
	},
	{
		responseField: "response",
		outputTransform: (output) => {
			const response = (output.response as string) || "";
			const executionResult = output.executionResult as
				| { data?: unknown; statusCode?: number; responseTime?: number }
				| undefined;

			const artifacts: Array<{
				id: string;
				name: string;
				description: string;
				mimeType: string;
				parts: Array<{ type: "text"; text: string }>;
			}> = [];

			// Include raw API response as artifact if available
			if (executionResult?.data) {
				artifacts.push({
					id: uuidv4(),
					name: "api-response",
					description: "Raw API response data",
					mimeType: "application/json",
					parts: [
						{
							type: "text" as const,
							text: JSON.stringify(executionResult.data, null, 2),
						},
					],
				});
			}

			return {
				response,
				artifacts,
				metadata: {
					error: output.error,
					statusCode: executionResult?.statusCode,
					responseTime: executionResult?.responseTime,
				},
			};
		},
	},
);

// Create A2A server
const a2aServer = new A2AServer(
	{
		name: "api_agent",
		description:
			"API Agent that executes OpenAPI tools registered in Fabric. Use this agent to make external API calls to services configured in OpenAPI Services settings (e.g., weather APIs, payment gateways, external services).",
		url: BASE_URL,
		skills: AGENT_SKILLS,
		protocolVersion: "0.3.0",
		supportsStreaming: false,
		tags: ["api", "openapi", "http", "external-services", "langgraph"],
	},
	a2aExecutor,
);

// Create Hono app with A2A endpoints
const app = new Hono();

// Enable CORS
app.use("*", cors());

// A2A Protocol Endpoints
const handlers = a2aServer.createHandlers();

// GET /.well-known/agent-card.json (v0.3.0)
app.get("/.well-known/agent-card.json", (c) => {
	return c.json(a2aServer.getAgentCard());
});

// GET /.well-known/agent.json (legacy)
app.get("/.well-known/agent.json", (c) => {
	return c.json(a2aServer.getAgentCard());
});

// POST /a2a/send
app.post("/a2a/send", async (c) => {
	try {
		const body = await c.req.json();
		const response = await handlers.sendMessage(body);
		const result = await response.json();
		return c.json(result, response.status as 200);
	} catch (error) {
		console.error("[A2A Server] Error in /a2a/send:", error);
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

// POST /a2a/send/stream
app.post("/a2a/send/stream", async (c) => {
	try {
		const body = await c.req.json();
		const response = handlers.sendMessageStream(body);
		return new Response(response.body, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("[A2A Server] Error in /a2a/send/stream:", error);
		return c.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			500,
		);
	}
});

// GET /a2a/tasks/:taskId
app.get("/a2a/tasks/:taskId", (c) => {
	const taskId = c.req.param("taskId");
	const response = handlers.getTask(taskId);
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
});

// POST /a2a/tasks/:taskId/cancel
app.post("/a2a/tasks/:taskId/cancel", async (c) => {
	const taskId = c.req.param("taskId");
	const response = await handlers.cancelTask(taskId);
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
});

// GET /health
app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		agent: "api_agent",
		protocol: "a2a",
		version: "0.3.0",
		fabricApiUrl: FABRIC_API_URL,
	});
});

// Start the server
console.log(`[A2A Server] Starting API Agent on ${HOST}:${PORT}`);
console.log(`[A2A Server] Agent Card: ${BASE_URL}/.well-known/agent.json`);
console.log(`[A2A Server] A2A Send: ${BASE_URL}/a2a/send`);
console.log(`[A2A Server] Health: ${BASE_URL}/health`);
console.log(`[A2A Server] Fabric API URL: ${FABRIC_API_URL}`);

serve({
	fetch: app.fetch,
	hostname: HOST,
	port: PORT,
});

export { app };
