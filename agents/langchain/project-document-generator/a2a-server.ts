/**
 * A2A Protocol Server for Project Document Generator
 *
 * Exposes the LangGraph agent via A2A protocol endpoints so it can be
 * discovered and invoked by the orchestrator agent.
 *
 * Endpoints:
 * - GET /.well-known/agent.json - Agent card discovery
 * - POST /a2a/send - Send message (synchronous)
 * - POST /a2a/send/stream - Send message (streaming SSE)
 * - GET /a2a/tasks/:taskId - Get task status
 * - POST /a2a/tasks/:taskId/cancel - Cancel task
 * - GET /health - Health check
 */

import { serve } from "@hono/node-server";
import type { AgentSkill, Artifact } from "@repo/agent-core/a2a";
import {
	A2AServer,
	createLangGraphA2AExecutor,
} from "@repo/agent-core/a2a/server";
import type { DocumentType, ProjectContext } from "@repo/agent-types";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { projectDocumentGeneratorGraph } from "./agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils/index.js";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8125", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "generate-prd",
		name: "Generate PRD",
		description:
			"Generate a Product Requirements Document (PRD) for a software project",
		parameters: {
			type: "object",
			properties: {
				projectName: {
					type: "string",
					description: "Name of the project",
				},
				description: {
					type: "string",
					description: "Project description or requirements",
				},
				techStack: {
					type: "array",
					items: { type: "string" },
					description: "Technologies to use",
				},
				features: {
					type: "array",
					items: { type: "string" },
					description: "Key features to include",
				},
			},
			required: ["projectName", "description"],
		},
		examples: [
			"Generate a PRD for a task management application",
			"Create a product requirements document for an e-commerce platform",
		],
		tags: ["prd", "documentation", "requirements"],
	},
	{
		id: "generate-technical-spec",
		name: "Generate Technical Specification",
		description:
			"Generate a technical specification document for implementation",
		parameters: {
			type: "object",
			properties: {
				projectName: {
					type: "string",
					description: "Name of the project",
				},
				requirements: {
					type: "string",
					description: "Technical requirements",
				},
				architecture: {
					type: "string",
					description: "Architectural constraints or preferences",
				},
			},
			required: ["projectName", "requirements"],
		},
		examples: [
			"Create a technical spec for the authentication module",
			"Generate implementation details for the payment system",
		],
		tags: ["technical", "specification", "implementation"],
	},
	{
		id: "generate-funding-proposal",
		name: "Generate Funding Proposal",
		description:
			"Generate a funding proposal or grant application document",
		examples: [
			"Create a funding proposal for our AI startup",
			"Generate a grant application for the research project",
		],
		tags: ["funding", "proposal", "grant"],
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
			"PRD") as DocumentType;
		const projectContextInput =
			(input.projectContext as Record<string, unknown>) || {};
		const projectContext: ProjectContext = {
			name: (projectContextInput.name as string) || "Project",
			techStack: (projectContextInput.techStack as string[]) || [],
			features: (projectContextInput.features as string[]) || [],
		};
		const ragContexts = (input.ragContexts as string[]) || [];

		console.log("[A2A Server] Invoking graph with:", {
			messageLength: userMessage.length,
			documentType,
			projectName: projectContext.name,
			ragContextCount: ragContexts.length,
		});

		// Invoke the LangGraph graph
		const result = await projectDocumentGeneratorGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				documentType,
				projectContext,
				ragContexts,
				// A2A doesn't have frontend actions, so copilotkit is undefined
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
					description: "Generated project document",
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
		name: "project_document_generator",
		description:
			"Specialized agent for generating PRDs, technical specifications, and project documentation with RAG context support. Best for: PRD, product requirements, technical spec, project documentation, requirements document, funding proposal.",
		url: BASE_URL,
		skills: AGENT_SKILLS,
		protocolVersion: "0.3.0",
		supportsStreaming: false, // Will add streaming support later
		tags: ["documentation", "prd", "technical-spec", "langgraph"],
	},
	a2aExecutor,
);

// Create Hono app with A2A endpoints
const app = new Hono();

// Enable CORS for all origins (adjust in production)
app.use("*", cors());

// A2A Protocol Endpoints
const handlers = a2aServer.createHandlers();

// GET /.well-known/agent-card.json - Agent card discovery (v0.3.0)
app.get("/.well-known/agent-card.json", (c) => {
	return c.json(a2aServer.getAgentCard());
});

// GET /.well-known/agent.json - Agent card discovery (legacy)
app.get("/.well-known/agent.json", (c) => {
	return c.json(a2aServer.getAgentCard());
});

// POST /a2a/send - Send message (synchronous)
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

// POST /a2a/send/stream - Send message (streaming SSE)
app.post("/a2a/send/stream", async (c) => {
	try {
		const body = await c.req.json();
		const response = handlers.sendMessageStream(body);

		// Return SSE response
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

// GET /a2a/tasks/:taskId - Get task status
app.get("/a2a/tasks/:taskId", (c) => {
	const taskId = c.req.param("taskId");
	const response = handlers.getTask(taskId);
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
});

// POST /a2a/tasks/:taskId/cancel - Cancel task
app.post("/a2a/tasks/:taskId/cancel", async (c) => {
	const taskId = c.req.param("taskId");
	const response = await handlers.cancelTask(taskId);
	return new Response(response.body, {
		status: response.status,
		headers: response.headers,
	});
});

// GET /health - Health check (also used by orchestrator)
app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		agent: "project_document_generator",
		protocol: "a2a",
		version: "0.3.0",
	});
});

// Legacy LangGraph endpoints for backwards compatibility
// These will be deprecated once all clients migrate to A2A

app.get("/info", (c) => {
	return c.json({
		name: "project_document_generator",
		protocol: "langgraph",
		a2aEndpoint: `${BASE_URL}/.well-known/agent.json`,
		deprecationNotice: "Please migrate to A2A protocol endpoints",
	});
});

// Start the server
console.log(
	`[A2A Server] Starting Project Document Generator on ${HOST}:${PORT}`,
);
console.log(`[A2A Server] Agent Card: ${BASE_URL}/.well-known/agent.json`);
console.log(`[A2A Server] A2A Send: ${BASE_URL}/a2a/send`);
console.log(`[A2A Server] Health: ${BASE_URL}/health`);

serve({
	fetch: app.fetch,
	hostname: HOST,
	port: PORT,
});

export { app };
