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

import {
	type AgentSkill,
	createUnifiedServer,
	getUserFacingError,
} from "@repo/agent-core";
import { v4 as uuidv4 } from "uuid";
import { storyBreakdownGraph } from "./agent.js";
import { createInvokeAgent } from "./invoke-agent.js";

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
	createInvokeAgent(storyBreakdownGraph),
	// Transform output for A2A response
	(output) => {
		const document = (output.document as string) || "";

		return {
			error: getUserFacingError(output.error, output.failureText),
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
