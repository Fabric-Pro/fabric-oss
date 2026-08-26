/**
 * Unified Server for Story Breakdown
 *
 * Single server that handles both AG-UI (CopilotKit) and A2A (orchestrator) protocols.
 * This replaces the need for separate AG-UI and A2A servers.
 *
 * Endpoints:
 * - AG-UI: /invoke, /stream, /ok (for CopilotKit frontend)
 * - A2A: /.well-known/agent.json, /a2a/send, /health (for orchestrator)
 */

import { type AgentSkill, createUnifiedServer } from "@repo/agent-core";
import { v4 as uuidv4 } from "uuid";
import { storyBreakdownGraph } from "./agent.js";
import { DEFAULT_RECURSION_LIMIT } from "./utils";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8126", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "create-features",
		name: "Create Features",
		description:
			"Generate features from requirements with acceptance criteria",
		parameters: {
			type: "object",
			properties: {
				prdContent: {
					type: "string",
					description: "PRD or requirements document content",
				},
				projectName: {
					type: "string",
					description: "Project name for context",
				},
				projectDescription: {
					type: "string",
					description: "Optional project description",
				},
			},
			required: ["prdContent", "projectName"],
		},
		examples: [
			"Break down the authentication PRD into features",
			"Create features from the payment requirements",
		],
		tags: ["features", "agile"],
	},
	{
		id: "estimate-stories",
		name: "Estimate Stories",
		description: "Provide story point estimates based on complexity",
		examples: [
			"Estimate the features for the dashboard",
			"Add story point estimates to the backlog items",
		],
		tags: ["estimation", "agile"],
	},
];

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "story_breakdown",
		description:
			"Converts PRDs and requirements into features with acceptance criteria. Best for agile teams converting specs to implementation tasks.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: ["agile", "user-stories", "requirements", "langgraph"],
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
		const projectName = (input.projectName as string) || "Unnamed Project";
		const projectDescription = input.projectDescription as
			| string
			| undefined;
		const prdContent = (input.prdContent as string) || userMessage;

		console.log("[UnifiedServer] Invoking story_breakdown with:", {
			projectName,
			prdContentLength: prdContent.length,
		});

		// Invoke the LangGraph graph
		const graphResult = await storyBreakdownGraph.invoke(
			{
				messages: [{ role: "user", content: userMessage }],
				prdContent,
				projectName,
				projectDescription,
				tools: [],
			},
			{ recursionLimit: DEFAULT_RECURSION_LIMIT },
		);

		// Cast to access properties
		const result = graphResult as unknown as {
			document?: string;
			messages: unknown[];
			error?: string;
		};

		console.log("[UnifiedServer] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
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
			document: result.document || "",
			messages: outputMessages,
			error: result.error,
		};
	},
	// Transform output for A2A response
	(output) => {
		const document = (output.document as string) || "";

		return {
			response: document,
			artifacts: document
				? [
						{
							id: uuidv4(),
							name: "features",
							description:
								"Generated features with acceptance criteria",
							mimeType: "text/markdown",
							parts: [{ type: "text", text: document }],
						},
					]
				: [],
			metadata: {
				error: output.error,
			},
		};
	},
);

// Start the server
start();

export { app };
