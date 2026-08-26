/**
 * A2A Protocol Server for Story Breakdown Agent
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
import { storyBreakdownGraph } from "./agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8227", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "create-features",
		name: "Create Features",
		description:
			"Convert requirements into well-structured features with acceptance criteria",
		parameters: {
			type: "object",
			properties: {
				requirement: {
					type: "string",
					description: "The requirement or feature to convert",
				},
				context: {
					type: "string",
					description:
						"Additional context about the product or users",
				},
			},
			required: ["requirement"],
		},
		examples: [
			"Create features for a shopping cart",
			"Break down the login functionality into features",
			"Generate features for implementing notifications",
		],
		tags: ["features", "agile", "requirements"],
	},
	{
		id: "estimate-stories",
		name: "Estimate Stories",
		description: "Provide story point estimates based on complexity",
		examples: [
			"Estimate the complexity of these features",
			"How many story points for this feature?",
		],
		tags: ["estimation", "agile", "planning"],
	},
];

// Define the result type from the graph
interface StoryBreakdownGraphResult {
	document?: string;
	focusAnchor?: string;
	error?: string;
	messages: unknown[]; // BaseMessage[] from LangGraph
}

// Create A2A executor that wraps the LangGraph graph
const a2aExecutor = createLangGraphA2AExecutor(
	async (input: Record<string, unknown>) => {
		const messages = input.messages as Array<{
			role: string;
			content: string;
		}>;
		const lastMessage = messages[messages.length - 1];
		const userMessage = lastMessage?.content || "";

		console.log("[A2A Server] Invoking Story Breakdown graph with:", {
			messageLength: userMessage.length,
		});

		// The graph expects prdContent, not requirement
		const graphResult = await storyBreakdownGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				prdContent: userMessage, // Use prdContent as that's what the graph expects
				projectName: (input.projectName as string) || "Project",
				projectDescription: input.projectDescription as
					| string
					| undefined,
			},
			{ recursionLimit: DEFAULT_RECURSION_LIMIT },
		);

		// Cast to our result type
		const result = graphResult as unknown as StoryBreakdownGraphResult;

		console.log("[A2A Server] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
			hasError: !!result.error,
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
			response: result.document || "",
			document: result.document,
			messages: outputMessages,
			error: result.error,
		};
	},
	{
		responseField: "response",
		outputTransform: (output) => {
			const response = (output.response as string) || "";
			const document = output.document as string | undefined;

			// Create artifact from the document if available
			const artifacts: Array<{
				id: string;
				name: string;
				description: string;
				mimeType: string;
				parts: Array<{ type: "text"; text: string }>;
			}> = [];

			if (document) {
				artifacts.push({
					id: uuidv4(),
					name: "features",
					description: "Features document with acceptance criteria",
					mimeType: "text/markdown",
					parts: [
						{
							type: "text" as const,
							text: document,
						},
					],
				});
			}

			return {
				response,
				artifacts,
				metadata: {
					error: output.error,
					documentLength: document?.length || 0,
				},
			};
		},
	},
);

// Create A2A server
const a2aServer = new A2AServer(
	{
		name: "story_breakdown",
		description:
			"Story Breakdown agent that converts requirements into well-structured features with acceptance criteria and estimates. Best for: agile teams, sprint planning, requirements analysis.",
		url: BASE_URL,
		skills: AGENT_SKILLS,
		protocolVersion: "0.3.0",
		supportsStreaming: false,
		tags: ["agile", "user-stories", "requirements", "langgraph"],
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
		agent: "story_breakdown",
		protocol: "a2a",
		version: "0.3.0",
	});
});

// Start the server
console.log(`[A2A Server] Starting Story Breakdown on ${HOST}:${PORT}`);
console.log(`[A2A Server] Agent Card: ${BASE_URL}/.well-known/agent.json`);
console.log(`[A2A Server] A2A Send: ${BASE_URL}/a2a/send`);
console.log(`[A2A Server] Health: ${BASE_URL}/health`);

serve({
	fetch: app.fetch,
	hostname: HOST,
	port: PORT,
});

export { app };
