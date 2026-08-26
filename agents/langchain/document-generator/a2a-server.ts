/**
 * A2A Protocol Server for Document Generator
 *
 * Exposes the LangGraph agent via A2A protocol endpoints so it can be
 * discovered and invoked by the orchestrator agent.
 */

import { serve } from "@hono/node-server";
import type { AgentSkill, Artifact } from "@repo/agent-core";
import { A2AServer, createLangGraphA2AExecutor } from "@repo/agent-core";
import type { DocumentType } from "@repo/agent-types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { predictiveStateUpdatesGraph } from "./agent.js";
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

		// Extract metadata from input
		const documentType = ((input.documentType as string) ||
			"general") as DocumentType;

		console.log("[A2A Server] Invoking graph with:", {
			messageLength: userMessage.length,
			documentType,
		});

		// Invoke the LangGraph graph
		const result = await predictiveStateUpdatesGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				documentType,
				tools: [],
			},
			{ recursionLimit: DEFAULT_RECURSION_LIMIT },
		);

		console.log("[A2A Server] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
			hasError: !!result.error,
		});

		return {
			document: result.document || "",
			messages: result.messages,
			error: result.error,
		};
	},
	{
		responseField: "document",
		outputTransform: (output) => {
			const document = (output.document as string) || "";
			const artifacts: Artifact[] = [];

			if (document) {
				artifacts.push({
					id: uuidv4(),
					name: "document",
					description: "Generated document",
					mimeType: "text/markdown",
					parts: [{ type: "text", text: document }],
				});
			}

			return {
				response: document,
				artifacts,
				metadata: {
					error: output.error,
				},
			};
		},
	},
);

// Create A2A server
const a2aServer = new A2AServer(
	{
		name: "document_generator",
		description:
			"General document generator agent for creating articles, summaries, API docs, README files, and other content. Best for: documentation, articles, summaries, API docs, README.",
		url: BASE_URL,
		skills: AGENT_SKILLS,
		protocolVersion: "0.3.0",
		supportsStreaming: false,
		tags: ["documentation", "content", "writing", "langgraph"],
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
		agent: "document_generator",
		protocol: "a2a",
		version: "0.3.0",
	});
});

// Start the server
console.log(`[A2A Server] Starting Document Generator on ${HOST}:${PORT}`);
console.log(`[A2A Server] Agent Card: ${BASE_URL}/.well-known/agent.json`);
console.log(`[A2A Server] A2A Send: ${BASE_URL}/a2a/send`);
console.log(`[A2A Server] Health: ${BASE_URL}/health`);

serve({
	fetch: app.fetch,
	hostname: HOST,
	port: PORT,
});

export { app };
