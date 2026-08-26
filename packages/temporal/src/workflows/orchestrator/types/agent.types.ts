/**
 * Agent Types
 *
 * Defines agent capabilities and the agent registry.
 * Part of the Composable Agent Architecture.
 */

// =============================================================================
// Agent Capability
// =============================================================================

export interface AgentCapability {
	id: string;
	name: string;
	description: string;
	/** What this agent is best for */
	bestFor: string[];
	/** Input schema for this agent */
	inputSchema?: Record<string, unknown>;
	/** Output schema for this agent */
	outputSchema?: Record<string, unknown>;
	/** Whether this agent can be used as a tool by other agents */
	exposedAsTool: boolean;
	/** Risk level when using this agent */
	defaultRiskLevel: "low" | "medium" | "high" | "critical";
	/** Maximum concurrent executions */
	maxConcurrency?: number;
}

// =============================================================================
// Agent Registry
// =============================================================================

export const AGENT_REGISTRY: Record<string, AgentCapability> = {
	project_document_generator: {
		id: "project_document_generator",
		name: "Project Document Generator",
		description:
			"Specialized agent for generating PRDs, technical specs, and project documentation with RAG context support",
		bestFor: [
			"PRD",
			"product requirements",
			"technical spec",
			"project documentation",
			"requirements document",
			"funding proposal",
		],
		exposedAsTool: true,
		defaultRiskLevel: "low",
	},
	task_planner: {
		id: "task_planner",
		name: "Task Planner",
		description:
			"Breaks down complex tasks into actionable steps with risk analysis",
		bestFor: [
			"planning",
			"task breakdown",
			"project planning",
			"feature planning",
		],
		exposedAsTool: true,
		defaultRiskLevel: "low",
	},
	document_generator: {
		id: "document_generator",
		name: "Document Generator",
		description: "Creates general documents, articles, and content",
		bestFor: [
			"documentation",
			"articles",
			"summaries",
			"API docs",
			"README",
		],
		exposedAsTool: true,
		defaultRiskLevel: "low",
	},
	code_executor: {
		id: "code_executor",
		name: "Code Executor",
		description:
			"DEPRECATED: Use cuga_generalist for actual code execution. This agent only generates code but does NOT execute it. For real code execution with E2B/Docker sandbox, use cuga_generalist instead.",
		bestFor: ["code generation only", "code templates"],
		exposedAsTool: false, // Hide from tool exposure since CUGA handles execution
		defaultRiskLevel: "low",
	},
	story_breakdown: {
		id: "story_breakdown",
		name: "Story Breakdown",
		description: "Converts PRDs into actionable features with estimates",
		bestFor: ["features", "agile", "sprint planning", "story points"],
		exposedAsTool: true,
		defaultRiskLevel: "low",
	},
	mcp_tool_executor: {
		id: "mcp_tool_executor",
		name: "MCP Tool Executor",
		description: "Executes MCP tools to interact with external services",
		bestFor: [
			"API calls",
			"external services",
			"integrations",
			"data fetching",
		],
		exposedAsTool: true,
		defaultRiskLevel: "medium",
	},
	api_agent: {
		id: "api_agent",
		name: "API Agent",
		description:
			"Orchestrates complex API workflows across multiple services",
		bestFor: [
			"complex API workflows",
			"multi-service coordination",
			"API orchestration",
		],
		exposedAsTool: true,
		defaultRiskLevel: "medium",
	},
	cuga_generalist: {
		id: "cuga_generalist",
		name: "CUGA Generalist Agent",
		description:
			"Configurable Universal Generalist Agent (CUGA) - A FULL-FEATURED GENERALIST with AUTONOMOUS planning and multi-step execution capabilities. CUGA is NOT a specialized tool - it is an intelligent agent that can: (1) CODE EXECUTION: Write AND execute Python code in E2B/Docker sandbox with real output, debugging, and iteration, (2) BROWSER AUTOMATION: Full Playwright support for interactive web tasks, form filling, multi-step UI navigation, screenshots, data extraction from web pages, (3) API ORCHESTRATION: Complex multi-API workflows with variable management, (4) AUTONOMOUS PLANNING: Internal task decomposition - delegate ENTIRE complex tasks to CUGA and let it plan its own execution. Use CUGA for code execution, browser automation, or complex multi-modal tasks that combine code+web+API.",
		bestFor: [
			// Code execution capabilities
			"execute python code",
			"run code in sandbox",
			"debug code",
			"fix code errors",
			"test code",
			"write and run python",
			"code execution with output",
			"data processing scripts",
			"run scripts",
			// Browser automation capabilities
			"browser automation",
			"interactive web tasks",
			"form filling",
			"multi-step UI navigation",
			"web scraping with interaction",
			"clicking through UI flows",
			"screenshot capture",
			"navigate websites",
			"extract data from web pages",
			// Complex multi-step capabilities
			"autonomous planning",
			"complex multi-step tasks",
			"multimodal tasks combining web and code",
			"API orchestration workflows",
			"task decomposition",
			"research and summarize from web",
			"scrape and analyze data",
		],
		exposedAsTool: true,
		defaultRiskLevel: "high",
	},
	workflow_executor: {
		id: "workflow_executor",
		name: "Workflow Executor",
		description: "Triggers and monitors Fabric workflows",
		bestFor: [
			"workflow execution",
			"automation triggers",
			"scheduled tasks",
		],
		exposedAsTool: true,
		defaultRiskLevel: "medium",
	},
	reflection_agent: {
		id: "reflection_agent",
		name: "Reflection Agent",
		description:
			"Evaluates outputs, detects errors, and suggests improvements",
		bestFor: ["quality assurance", "error detection", "output validation"],
		exposedAsTool: true,
		defaultRiskLevel: "low",
	},
};
