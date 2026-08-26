/**
 * Unified Proxy Server for Project Document Generator
 *
 * Single server that supports both protocols:
 * - A2A endpoints: Handled directly for orchestrator communication
 * - AG-UI endpoints: Proxied to internal langgraph dev for predictive state updates
 *
 * Architecture:
 * ┌──────────────────────────────────────────┐
 * │        External Port (e.g., 8125)        │
 * │                                          │
 * │  A2A Requests          AG-UI Requests    │
 * │  /.well-known/*        /runs/*           │
 * │  /a2a/*                /assistants/*     │
 * │  /health               /threads/*        │
 * │       │                     │            │
 * │       ▼                     ▼            │
 * │  Handle directly      Proxy to internal  │
 * │                       langgraph dev      │
 * │                       (port 8000)        │
 * └──────────────────────────────────────────┘
 */

import { type ChildProcess, spawn } from "node:child_process";
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
const LANGGRAPH_INTERNAL_PORT = 8000; // Internal port for langgraph dev

// Track the langgraph dev process
let langgraphProcess: ChildProcess | null = null;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "generate-prd",
		name: "Generate PRD",
		description:
			"Generate a Product Requirements Document with features and acceptance criteria",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "What to create a PRD for",
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
			"Create a PRD for a task management app",
			"Generate product requirements for an e-commerce platform",
		],
		tags: ["prd", "product", "requirements", "documentation"],
	},
	{
		id: "generate-tech-spec",
		name: "Generate Technical Specification",
		description:
			"Generate a Technical Specification with architecture, APIs, and implementation details",
		examples: [
			"Create a technical spec for the authentication system",
			"Generate architecture documentation for the API layer",
		],
		tags: ["technical", "specification", "architecture", "documentation"],
	},
	{
		id: "generate-project-doc",
		name: "Generate Project Documentation",
		description:
			"Generate general project documentation with customizable structure",
		examples: [
			"Create documentation for the project setup",
			"Generate a project overview document",
		],
		tags: ["documentation", "project", "overview"],
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

		// Extract orchestrator context if present (contains workflow context, previous step results, etc.)
		// The orchestrator passes context with keys: previousStepResults, variables, stepInputs, stepIndex, totalSteps
		// Context can be in input.orchestratorContext (from options.metadata) or directly on input (from message.metadata spread)
		const orchestratorContext = (input.orchestratorContext ||
			input) as Record<string, unknown>;

		// Debug: log what context keys we received
		console.log(
			"[Proxy Server] Context keys received:",
			Object.keys(input).filter(
				(k) => !["messages", "contextId"].includes(k),
			),
		);

		// Build enhanced message with context
		let enhancedMessage = userMessage;
		if (orchestratorContext) {
			const contextParts: string[] = [];

			// Include previous step results (most important for context)
			if (orchestratorContext.previousStepResults) {
				const prevResults =
					orchestratorContext.previousStepResults as Array<{
						stepDescription: string;
						result: string;
					}>;
				if (prevResults.length > 0) {
					const resultsText = prevResults
						.map(
							(r, i) =>
								`Step ${i + 1}: ${r.stepDescription}\nResult: ${r.result}`,
						)
						.join("\n\n");
					contextParts.push(`Previous step results:\n${resultsText}`);
				}
			}

			// Include step inputs (direct inputs to this step)
			if (orchestratorContext.stepInputs) {
				const inputs = orchestratorContext.stepInputs as Record<
					string,
					unknown
				>;
				if (Object.keys(inputs).length > 0) {
					contextParts.push(
						`Step inputs:\n${JSON.stringify(inputs, null, 2)}`,
					);
				}
			}

			// Include variables (workflow-level variables)
			if (orchestratorContext.variables) {
				const vars = orchestratorContext.variables as Record<
					string,
					unknown
				>;
				if (Object.keys(vars).length > 0) {
					contextParts.push(
						`Workflow variables:\n${JSON.stringify(vars, null, 2)}`,
					);
				}
			}

			// If there's context, prepend it to the message
			if (contextParts.length > 0) {
				enhancedMessage = `${contextParts.join("\n\n")}\n\n---\n\nTask: ${userMessage}`;
			}
		}

		console.log("[Proxy Server] A2A invoking graph with:", {
			messageLength: enhancedMessage.length,
			originalMessageLength: userMessage.length,
			hasOrchestratorContext: !!orchestratorContext,
			documentType,
			projectName: projectContext.name,
			hasRagContext: ragContexts.length > 0,
		});

		// Invoke the LangGraph graph directly for A2A (no predictive state needed)
		const result = await projectDocumentGeneratorGraph.invoke(
			{
				messages: [{ role: "user", content: enhancedMessage }],
				documentType,
				projectContext,
				ragContexts,
				// Proxy server doesn't have frontend actions, so copilotkit is undefined
			},
			{ recursionLimit: DEFAULT_RECURSION_LIMIT },
		);

		console.log("[Proxy Server] A2A graph result:", {
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
			"Specialized agent for generating PRDs, technical specs, and project documentation with RAG context. Best for: PRD creation, technical specifications, project documentation.",
		url: BASE_URL,
		skills: AGENT_SKILLS,
		protocolVersion: "0.3.0",
		supportsStreaming: false,
		tags: [
			"documentation",
			"prd",
			"technical-spec",
			"project",
			"langgraph",
		],
	},
	a2aExecutor,
);

// Create Hono app
const app = new Hono();

// Enable CORS
app.use("*", cors());

// ============================================================================
// A2A Protocol Endpoints (handled directly)
// ============================================================================

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
		console.error("[Proxy Server] Error in /a2a/send:", error);
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
		console.error("[Proxy Server] Error in /a2a/send/stream:", error);
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

// GET /health - unified health check
app.get("/health", (c) => {
	return c.json({
		status: "healthy",
		agent: "project_document_generator",
		protocols: ["a2a", "ag-ui"],
		version: "0.3.0",
		langgraphRunning: langgraphProcess !== null && !langgraphProcess.killed,
	});
});

// ============================================================================
// AG-UI Protocol Endpoints (proxied to langgraph dev)
// ============================================================================

// Proxy function to forward requests to langgraph dev
async function proxyToLanggraph(c: any): Promise<Response> {
	const url = new URL(c.req.url);
	const targetUrl = `http://localhost:${LANGGRAPH_INTERNAL_PORT}${url.pathname}${url.search}`;

	try {
		const headers: Record<string, string> = {};
		c.req.raw.headers.forEach((value: string, key: string) => {
			// Skip host header
			if (key.toLowerCase() !== "host") {
				headers[key] = value;
			}
		});

		const response = await fetch(targetUrl, {
			method: c.req.method,
			headers,
			body:
				c.req.method !== "GET" && c.req.method !== "HEAD"
					? await c.req.raw.clone().text()
					: undefined,
		});

		// Stream the response back
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		return new Response(response.body, {
			status: response.status,
			headers: responseHeaders,
		});
	} catch (error) {
		console.error("[Proxy Server] Error proxying to langgraph:", error);
		return c.json(
			{
				error: "Failed to proxy to langgraph dev",
				details: error instanceof Error ? error.message : "Unknown",
			},
			502,
		);
	}
}

// LangGraph Platform API endpoints - proxy to langgraph dev
app.all("/runs/*", proxyToLanggraph);
app.all("/assistants/*", proxyToLanggraph);
app.all("/threads/*", proxyToLanggraph);
app.all("/store/*", proxyToLanggraph);
app.all("/meta", proxyToLanggraph);
app.get("/ok", proxyToLanggraph);
app.get("/info", proxyToLanggraph);

// ============================================================================
// Start servers
// ============================================================================

async function waitForLanggraphHealth(
	maxWaitMs = 60000,
	intervalMs = 1000,
): Promise<boolean> {
	const startTime = Date.now();
	while (Date.now() - startTime < maxWaitMs) {
		try {
			const response = await fetch(
				`http://localhost:${LANGGRAPH_INTERNAL_PORT}/ok`,
			);
			if (response.ok) {
				return true;
			}
		} catch {
			// Server not ready yet
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
}

async function startLanggraphDev(): Promise<void> {
	return new Promise((resolve, reject) => {
		console.log(
			`[Proxy Server] Starting internal langgraph dev on port ${LANGGRAPH_INTERNAL_PORT}...`,
		);

		langgraphProcess = spawn(
			"npx",
			[
				"-y",
				"@langchain/langgraph-cli@1.0.3",
				"dev",
				"--host",
				"0.0.0.0",
				"--port",
				String(LANGGRAPH_INTERNAL_PORT),
			],
			{
				cwd: process.cwd(),
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let started = false;

		langgraphProcess.stdout?.on("data", (data) => {
			const output = data.toString();
			console.log(`[langgraph dev] ${output.trim()}`);
			// Check if server started - look for the actual "Server running" message
			if (!started && output.includes("Server running")) {
				started = true;
				console.log(
					"[Proxy Server] Detected langgraph dev startup, verifying health...",
				);
				// Verify with health check before resolving
				waitForLanggraphHealth(10000, 500).then((healthy) => {
					if (healthy) {
						console.log(
							"[Proxy Server] Langgraph dev is healthy and ready",
						);
						resolve();
					} else {
						console.warn(
							"[Proxy Server] Langgraph health check failed, proceeding anyway",
						);
						resolve();
					}
				});
			}
		});

		langgraphProcess.stderr?.on("data", (data) => {
			console.error(`[langgraph dev] ${data.toString().trim()}`);
		});

		langgraphProcess.on("error", (error) => {
			console.error(
				"[Proxy Server] Failed to start langgraph dev:",
				error,
			);
			reject(error);
		});

		langgraphProcess.on("exit", (code) => {
			console.log(
				`[Proxy Server] langgraph dev exited with code ${code}`,
			);
			langgraphProcess = null;
		});

		// Extended timeout with health check fallback
		setTimeout(async () => {
			if (!started) {
				console.log(
					"[Proxy Server] Langgraph dev startup timeout, checking health...",
				);
				const healthy = await waitForLanggraphHealth(5000, 500);
				if (healthy) {
					console.log(
						"[Proxy Server] Langgraph dev is healthy after timeout",
					);
				} else {
					console.warn(
						"[Proxy Server] Langgraph dev not responding, AG-UI endpoints may fail",
					);
				}
				resolve();
			}
		}, 60000); // Increased to 60 seconds
	});
}

async function main() {
	try {
		// Start langgraph dev first (for AG-UI with predictive state)
		await startLanggraphDev();

		// Start the unified proxy server
		console.log(
			`\n[Proxy Server] Starting unified server on ${HOST}:${PORT}`,
		);
		console.log(
			`[Proxy Server] A2A endpoints: ${BASE_URL}/.well-known/agent.json, ${BASE_URL}/a2a/send`,
		);
		console.log(
			"[Proxy Server] AG-UI endpoints: proxied to internal langgraph dev",
		);
		console.log(`[Proxy Server] Health: ${BASE_URL}/health`);

		serve({
			fetch: app.fetch,
			hostname: HOST,
			port: PORT,
		});
	} catch (error) {
		console.error("[Proxy Server] Failed to start:", error);
		process.exit(1);
	}
}

// Handle shutdown
process.on("SIGINT", () => {
	console.log("\n[Proxy Server] Shutting down...");
	if (langgraphProcess) {
		langgraphProcess.kill();
	}
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("\n[Proxy Server] Shutting down...");
	if (langgraphProcess) {
		langgraphProcess.kill();
	}
	process.exit(0);
});

main();

export { app };
