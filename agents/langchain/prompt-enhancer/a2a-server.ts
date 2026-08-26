/**
 * A2A Protocol Server for Prompt Enhancer
 *
 * Exposes the LangGraph agent via A2A protocol endpoints so it can be
 * discovered and invoked by the orchestrator agent.
 */

import { serve } from "@hono/node-server";
import type { AgentSkill, Artifact } from "@repo/agent-core";
import { A2AServer, createLangGraphA2AExecutor } from "@repo/agent-core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { promptEnhancerGraph } from "./agent.js";
import type { EnhancementType } from "./types.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8134", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "enhance-prompt",
		name: "Enhance Prompt",
		description:
			"Enhance and improve a prompt for better AI interactions. Preserves template variables and improves clarity, structure, and effectiveness.",
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: "The prompt content to enhance",
				},
				enhancementType: {
					type: "string",
					description: "Type of enhancement to apply",
					enum: [
						"general",
						"rewrite",
						"expand",
						"restructure",
						"add_variables",
						"apply_best_practices",
						"optimize",
					],
				},
				instructions: {
					type: "string",
					description: "Additional instructions for the enhancement",
				},
			},
			required: ["prompt"],
		},
		examples: [
			"Improve this prompt for clarity",
			"Rewrite this prompt to be more professional",
			"Add template variables to this prompt",
			"Optimize this prompt for better AI responses",
		],
		tags: ["prompt", "enhancement", "ai", "optimization"],
	},
	{
		id: "rewrite-prompt",
		name: "Rewrite Prompt",
		description: "Rewrite a prompt for clarity and professionalism",
		examples: [
			"Rewrite this prompt to be clearer",
			"Make this prompt more professional",
		],
		tags: ["prompt", "rewrite", "clarity"],
	},
	{
		id: "expand-prompt",
		name: "Expand Prompt",
		description: "Expand a prompt with more detail and examples",
		examples: [
			"Add more detail to this prompt",
			"Expand this prompt with examples",
		],
		tags: ["prompt", "expand", "detail"],
	},
	{
		id: "add-variables",
		name: "Add Template Variables",
		description: "Add template variables to make a prompt reusable",
		examples: [
			"Add variables to this prompt template",
			"Make this prompt into a reusable template",
		],
		tags: ["prompt", "template", "variables"],
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
		const currentContent = (input.prompt as string) || userMessage;
		const enhancementType = ((input.enhancementType as string) ||
			"general") as EnhancementType;
		const userInstructions = input.instructions as string | undefined;
		const promptId = (input.promptId as string) || uuidv4();
		const promptName = (input.promptName as string) || "Untitled Prompt";

		console.log("[A2A Server] Invoking graph with:", {
			contentLength: currentContent.length,
			enhancementType,
			hasInstructions: !!userInstructions,
		});

		// Invoke the LangGraph graph
		const result = await promptEnhancerGraph.invoke(
			{
				promptId,
				promptName,
				currentContent,
				enhancementType,
				userInstructions,
				messages: [{ role: "user", content: userMessage }],
			},
			{ recursionLimit: DEFAULT_RECURSION_LIMIT },
		);

		console.log("[A2A Server] Graph result:", {
			hasEnhancedContent: !!result.enhancedContent,
			enhancedContentLength: result.enhancedContent?.length || 0,
		});

		return {
			enhancedContent: result.enhancedContent || "",
			streamingContent: result.streamingContent || "",
			focusAnchor: result.focusAnchor,
			explanation: result.explanation || "",
			messages: result.messages,
		};
	},
	{
		responseField: "enhancedContent",
		outputTransform: (output) => {
			const enhancedContent = (output.enhancedContent as string) || "";
			const artifacts: Artifact[] = [];

			if (enhancedContent) {
				artifacts.push({
					id: uuidv4(),
					name: "enhanced_prompt",
					description: "Enhanced prompt content",
					mimeType: "text/markdown",
					parts: [{ type: "text", text: enhancedContent }],
				});
			}

			return {
				response: enhancedContent,
				artifacts,
				metadata: {
					focusAnchor: output.focusAnchor,
					explanation: output.explanation,
				},
			};
		},
	},
);

// Create A2A server
const a2aServer = new A2AServer(
	{
		name: "prompt_enhancer",
		description:
			"AI-powered prompt enhancement agent that improves prompts for better AI interactions. Supports rewriting for clarity, expanding with details, adding template variables, and applying best practices. Best for: prompt optimization, template creation, prompt engineering.",
		url: BASE_URL,
		skills: AGENT_SKILLS,
		protocolVersion: "0.3.0",
		supportsStreaming: false,
		tags: ["prompt", "enhancement", "ai", "optimization", "langgraph"],
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
		agent: "prompt_enhancer",
		protocol: "a2a",
		version: "0.3.0",
	});
});

// Start the server
console.log(`[A2A Server] Starting Prompt Enhancer on ${HOST}:${PORT}`);
console.log(`[A2A Server] Agent Card: ${BASE_URL}/.well-known/agent.json`);
console.log(`[A2A Server] A2A Send: ${BASE_URL}/a2a/send`);
console.log(`[A2A Server] Health: ${BASE_URL}/health`);

serve({
	fetch: app.fetch,
	hostname: HOST,
	port: PORT,
});

export { app };
