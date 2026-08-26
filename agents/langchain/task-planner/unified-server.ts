/**
 * Unified Server for Task Planner
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
import { taskPlannerGraph } from "./agent.js";

// Configuration
const PORT = Number.parseInt(process.env.PORT || "8125", 10);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Define agent skills for A2A discovery
const AGENT_SKILLS: AgentSkill[] = [
	{
		id: "plan-tasks",
		name: "Plan Tasks",
		description:
			"Break down a goal into actionable tasks with dependencies and estimates",
		parameters: {
			type: "object",
			properties: {
				userStory: {
					type: "string",
					description: "Feature or requirement to decompose",
				},
				projectName: {
					type: "string",
					description: "Project name for context",
				},
				projectDescription: {
					type: "string",
					description: "Optional project description",
				},
				techStack: {
					type: "string",
					description: "Technology stack being used",
				},
			},
			required: ["userStory", "projectName"],
		},
		examples: [
			"Break down the user authentication feature into tasks",
			"Create a task plan for implementing payment integration",
		],
		tags: ["planning", "tasks", "decomposition"],
	},
	{
		id: "analyze-risks",
		name: "Analyze Risks",
		description:
			"Identify and assess risks in a project plan with mitigations",
		examples: [
			"Identify risks for the database migration",
			"Assess technical risks for the API redesign",
		],
		tags: ["risk", "analysis"],
	},
	{
		id: "create-execution-plan",
		name: "Create Execution Plan",
		description:
			"Generate a phased execution plan with dependencies and parallelization",
		examples: [
			"Create an execution timeline for the feature rollout",
			"Plan the sprint work with parallel tracks",
		],
		tags: ["execution", "planning", "timeline"],
	},
];

// Create unified server
const { app, start } = createUnifiedServer(
	{
		name: "task_planner",
		description:
			"Breaks down complex tasks into actionable steps with risk analysis and dependencies. Best for project planning and task decomposition.",
		baseUrl: BASE_URL,
		port: PORT,
		host: HOST,
		skills: AGENT_SKILLS,
		tags: ["planning", "tasks", "project-management", "langgraph"],
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
		const techStack = input.techStack as string | undefined;
		const userStory = (input.userStory as string) || userMessage;

		console.log("[UnifiedServer] Invoking task_planner with:", {
			projectName,
			userStoryLength: userStory.length,
			hasTechStack: !!techStack,
		});

		// Invoke the LangGraph graph
		const result = await taskPlannerGraph.invoke({
			messages: [{ role: "user", content: userMessage }],
			userStory,
			projectName,
			projectDescription,
			techStack,
			tools: [],
		});

		console.log("[UnifiedServer] Graph result:", {
			hasDocument: !!result.document,
			documentLength: result.document?.length || 0,
			taskCount: result.decomposedTasks?.length || 0,
		});

		// Convert BaseMessage[] to simple message format for the unified server
		const outputMessages = (result.messages || []).map((msg) => ({
			role:
				typeof msg === "object" && "role" in msg
					? String(msg.role)
					: "assistant",
			content:
				typeof msg === "object" && "content" in msg
					? String(msg.content)
					: String(msg),
		}));

		return {
			document: result.document || "",
			messages: outputMessages,
			decomposedTasks: result.decomposedTasks,
			riskAnalysis: result.riskAnalysis,
			dependencyGraph: result.dependencyGraph,
			executionPlan: result.executionPlan,
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
							name: "task-plan",
							description:
								"Generated task plan with decomposition and analysis",
							mimeType: "text/markdown",
							parts: [{ type: "text", text: document }],
						},
					]
				: [],
			metadata: {
				decomposedTasks: output.decomposedTasks,
				riskAnalysis: output.riskAnalysis,
				dependencyGraph: output.dependencyGraph,
				executionPlan: output.executionPlan,
				error: output.error,
			},
		};
	},
);

// Start the server
start();

export { app };
