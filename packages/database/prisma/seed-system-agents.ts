/**
 * Seed System Agents
 *
 * This script registers all built-in system agents in the database.
 * System agents are registered with scope "SYSTEM" and are available to all users.
 *
 * UNIFIED SERVER ARCHITECTURE:
 * Each agent runs a single unified server that handles both protocols:
 * - AG-UI endpoints: /invoke, /stream, /ok (for CopilotKit frontend)
 * - A2A endpoints: /.well-known/agent.json, /a2a/send, /health (for Fabric Loom)
 *
 * This eliminates the need for separate servers per protocol, reducing infrastructure overhead.
 *
 * Port Convention:
 * - document_generator: 8124
 * - project_document_generator: 8125
 * - task_planner: 8126
 * - story_breakdown: 8127
 * - data_analyst: 8130
 * - api_agent: 8131
 * - prompt_enhancer: 8134
 * - custom_agent_runtime: 8240
 * - weave-readers (thread, spindle, weft, warp): 8140
 * - weave-shuttle: 8141
 * (Pattern is not registered — it's the orchestrator's internal planner in weave mode)
 *
 * All agents support both AG-UI and A2A protocols on the same port.
 * This script validates A2A endpoints when VALIDATE_A2A=true is set.
 *
 * Usage:
 *   pnpm --filter @repo/database seed:system-agents
 *   VALIDATE_A2A=true pnpm --filter @repo/database seed:system-agents
 */

import { db } from "./client";

/**
 * Agent capabilities - determines UI behavior
 */
interface AgentCapabilities {
	/** Supports AG-UI predictive state updates (streaming document updates) */
	supportsPredictiveState?: boolean;
	/** Uses OpenAPI services instead of MCP servers */
	usesOpenAPI?: boolean;
	/** Requires an editor interface (TipTap + CopilotKit) */
	requiresEditor?: boolean;
	/** Type of editor to use */
	editorType?: "document" | "prompt" | "code";
	/** Has a native UI that should be shown in an iframe */
	hasNativeUI?: boolean;
	/** URL to the native UI (only applicable if hasNativeUI is true) */
	uiUrl?: string;
	/** Index signature for JSON compatibility */
	[key: string]: unknown;
}

/**
 * System agent definition
 */
interface SystemAgentDefinition {
	agentId: string;
	name: string;
	displayName: string;
	description: string;
	deploymentUrl: string;
	framework: string; // What the agent is built with (LangGraph, Vercel AI SDK, etc.)
	protocols: string[]; // How the agent communicates (A2A, AG-UI, MCP)
	capabilities: AgentCapabilities;
	skills: Array<{
		id: string;
		name: string;
		description: string;
		tags?: string[];
	}>;
	tags?: string[];
}

/**
 * Get unified server URL from environment or use default
 * Each agent now runs a single unified server that handles both AG-UI and A2A protocols.
 *
 * When running in Docker, uses container service names instead of localhost.
 */
function getUnifiedUrl(
	envVar: string,
	defaultUrl: string,
	serviceName?: string,
): string {
	// If DOCKER_CONTAINER is explicitly set to true, use container service names
	// This takes precedence over environment variables to ensure proper container networking
	const isDocker = process.env.DOCKER_CONTAINER === "true";

	if (isDocker && serviceName) {
		// Extract port from defaultUrl
		const port = defaultUrl.match(/:(\d+)$/)?.[1];
		return `http://${serviceName}:${port}`;
	}

	// Check if environment variable is set (for non-Docker deployments)
	if (process.env[envVar]) {
		return process.env[envVar];
	}

	// Fall back to default URL
	return defaultUrl;
}

/**
 * System agents configuration
 * These are the built-in agents that ship with the platform
 */
const SYSTEM_AGENTS: SystemAgentDefinition[] = [
	{
		agentId: "fabric-workspace-assistant",
		name: "fabric_workspace_assistant",
		displayName: "Fabric",
		description:
			"Canonical workspace assistant for grounded project Q&A, planning, approved actions, implementation handoffs, Skills, and automations across Fabric.",
		deploymentUrl: getUnifiedUrl(
			"FABRIC_WORKSPACE_ASSISTANT_URL",
			"http://localhost:3001/app/agents/fabric-ai",
		),
		framework: "FABRIC_NATIVE",
		protocols: ["FABRIC_NATIVE", "DIRECT_CHAT"],
		capabilities: {
			hasNativeUI: true,
			uiUrl: "/app/agents/fabric-ai",
		},
		skills: [
			{
				id: "workspace_qa",
				name: "Workspace Q&A",
				description:
					"Answer grounded questions about projects, features, tasks, documents, and workspace activity.",
				tags: ["qa", "workspace", "project"],
			},
			{
				id: "approved_actions",
				name: "Approved Actions",
				description:
					"Draft and execute approved actions such as task creation, update drafts, Skill creation, and implementation handoffs.",
				tags: ["actions", "approval", "project"],
			},
		],
		tags: ["fabric", "workspace", "assistant", "canonical"],
	},
	// ========================================================================
	// Compatibility alias: "fabric-ai" — graceful deprecation phase
	//
	// Historical drift: the frontend established `agentId = "fabric-ai"` as
	// the literal value for the canonical workspace assistant's
	// `AgentConversation.agentId` column (matches the URL slug at
	// `/app/agents/fabric-ai`). The backend canonical id is
	// `fabric-workspace-assistant` (above), used by Temporal workflows,
	// story-comments procedures, and the BACKLOG_AGENT_ID constant pattern.
	//
	// PR #1236 added this alias to unblock the round-2 catalog validation
	// in `agents.conversations.create`. The cleanup PR (Fizzy #1412
	// fabric-ai-cleanup) migrated the three frontend call sites
	// (FabricDirectChat, useOrchestratorConversation, FabricAIClient) to
	// use the canonical id directly, and applied a Prisma migration
	// (`20260528100000_rename_fabric_ai_to_canonical_agent_id`) that
	// rewrote existing AgentConversation rows.
	//
	// The alias entry is INTENTIONALLY KEPT during a graceful-deprecation
	// window so that:
	//   - A stale browser tab still running pre-cleanup frontend code can
	//     send `agentId: "fabric-ai"` to `conversations.create` and have
	//     it accepted (the rollover window between Vercel atomic deploy
	//     and user-tab refresh is otherwise a 400-error window).
	//   - Any third-party integration or legacy E2E run continues to work
	//     through one release cycle.
	//
	// Codex round-2 flagged this rollout race on PR #1239; user chose the
	// conservative path (keep alias, drop in follow-up after observability
	// confirms zero callers). The retired-alias-rejection test that
	// briefly lived in agent-id-validation.test.ts has been removed — both
	// canonical and alias paths are intentionally accepted in this phase.
	//
	// CLEANUP: a follow-up PR (after ≥1 release cycle and observability
	// dashboards confirming zero "fabric-ai" requests on conversations.create)
	// should remove this entry plus the associated compat test, with no
	// migration needed because the persisted rows are already canonical.
	// ========================================================================
	{
		agentId: "fabric-ai",
		name: "fabric_ai",
		displayName: "Fabric",
		description:
			"Compatibility alias of `fabric-workspace-assistant` — kept during a graceful-deprecation window so stale browser tabs and legacy integrations continue to work post-cleanup. New code MUST use `fabric-workspace-assistant`. To be removed in a follow-up PR once observability confirms zero callers.",
		deploymentUrl: getUnifiedUrl(
			"FABRIC_WORKSPACE_ASSISTANT_URL",
			"http://localhost:3001/app/agents/fabric-ai",
		),
		framework: "FABRIC_NATIVE",
		protocols: ["FABRIC_NATIVE", "DIRECT_CHAT"],
		capabilities: {
			hasNativeUI: true,
			uiUrl: "/app/agents/fabric-ai",
		},
		skills: [
			{
				id: "workspace_qa",
				name: "Workspace Q&A",
				description:
					"Answer grounded questions about projects, features, tasks, documents, and workspace activity.",
				tags: ["qa", "workspace", "project"],
			},
			{
				id: "approved_actions",
				name: "Approved Actions",
				description:
					"Draft and execute approved actions such as task creation, update drafts, Skill creation, and implementation handoffs.",
				tags: ["actions", "approval", "project"],
			},
		],
		tags: [
			"fabric",
			"workspace",
			"assistant",
			"alias",
			"deprecation-window",
		],
	},
	{
		agentId: "project_document_generator",
		name: "project_document_generator",
		displayName: "Project Document Generator",
		description:
			"Specialized agent for generating PRDs, technical specs, and project documentation with RAG context. Best for creating comprehensive project documents with proper structure and formatting.",
		// Unified proxy handles both AG-UI and A2A on port 8125
		deploymentUrl: getUnifiedUrl(
			"PROJECT_DOCUMENT_GENERATOR_URL",
			"http://localhost:8125",
			"project-document-generator",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: true,
			requiresEditor: true,
			editorType: "document",
		},
		skills: [
			{
				id: "generate_prd",
				name: "Generate PRD",
				description:
					"Create a Product Requirements Document with features and acceptance criteria",
				tags: ["prd", "product", "requirements"],
			},
			{
				id: "generate_tech_spec",
				name: "Generate Technical Spec",
				description:
					"Create a Technical Specification with architecture, APIs, and implementation details",
				tags: ["technical", "spec", "architecture"],
			},
			{
				id: "generate_project_doc",
				name: "Generate Project Documentation",
				description:
					"Create general project documentation with customizable structure",
				tags: ["documentation", "project"],
			},
		],
		tags: ["documentation", "prd", "technical-spec", "project"],
	},
	{
		agentId: "document_generator",
		name: "document_generator",
		displayName: "Document Generator",
		description:
			"General-purpose document generator for creating various types of documents. Best for general content creation, reports, and non-project-specific documents.",
		// Unified proxy handles both AG-UI and A2A on port 8124
		deploymentUrl: getUnifiedUrl(
			"DOCUMENT_GENERATOR_URL",
			"http://localhost:8124",
			"document-generator",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: true,
			requiresEditor: true,
			editorType: "document",
		},
		skills: [
			{
				id: "generate_document",
				name: "Generate Document",
				description:
					"Create a general document with specified content and structure",
				tags: ["document", "content"],
			},
			{
				id: "generate_report",
				name: "Generate Report",
				description: "Create reports with data analysis and summaries",
				tags: ["report", "analysis"],
			},
		],
		tags: ["documentation", "content", "general"],
	},
	{
		agentId: "task_planner",
		name: "task_planner",
		displayName: "Task Planner",
		description:
			"Breaks down complex tasks into actionable steps with risk analysis and dependencies. Best for project planning and task decomposition.",
		deploymentUrl: getUnifiedUrl(
			"TASK_PLANNER_URL",
			"http://localhost:8126",
			"task-planner",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: false,
		},
		skills: [
			{
				id: "plan_tasks",
				name: "Plan Tasks",
				description:
					"Break down a goal into actionable tasks with dependencies and estimates",
				tags: ["planning", "tasks"],
			},
			{
				id: "analyze_risks",
				name: "Analyze Risks",
				description: "Identify and assess risks in a project plan",
				tags: ["risk", "analysis"],
			},
		],
		tags: ["planning", "tasks", "project-management"],
	},
	{
		agentId: "story_breakdown",
		name: "story_breakdown",
		displayName: "Story Breakdown",
		description:
			"Converts PRDs and requirements into features with acceptance criteria. Best for agile teams converting specs to implementation tasks.",
		deploymentUrl: getUnifiedUrl(
			"STORY_BREAKDOWN_URL",
			"http://localhost:8127",
			"story-breakdown",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: false,
		},
		skills: [
			{
				id: "create_user_stories",
				name: "Create Features",
				description:
					"Generate features from requirements with acceptance criteria",
				tags: ["user-stories", "agile"],
			},
			{
				id: "estimate_stories",
				name: "Estimate Stories",
				description:
					"Provide story point estimates based on complexity",
				tags: ["estimation", "agile"],
			},
		],
		tags: ["agile", "user-stories", "requirements"],
	},
	{
		agentId: "data_analyst",
		name: "data_analyst",
		displayName: "Data Analyst",
		description:
			"Data analysis agent that connects to user's MCP data sources (HubSpot, Attio, Google Sheets, databases) to analyze data, generate insights, and create visualizations. Best for: data analysis, charts, reports, business intelligence.",
		deploymentUrl: getUnifiedUrl(
			"DATA_ANALYST_URL",
			"http://localhost:8130",
			"data-analyst",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: true,
		},
		skills: [
			{
				id: "analyze_data",
				name: "Analyze Data",
				description:
					"Analyze data from connected sources (HubSpot, Attio, Google Sheets, databases) and generate insights",
				tags: ["data", "analysis", "insights", "business-intelligence"],
			},
			{
				id: "create_visualization",
				name: "Create Visualization",
				description:
					"Generate charts and visualizations from data (bar, line, pie, scatter, histogram)",
				tags: ["visualization", "charts", "graphics"],
			},
			{
				id: "generate_report",
				name: "Generate Report",
				description:
					"Generate comprehensive data reports with statistics, trends, and recommendations",
				tags: ["reports", "summary", "documentation"],
			},
			{
				id: "query_data",
				name: "Query Data",
				description:
					"Query and retrieve data from connected MCP data sources",
				tags: ["query", "data", "retrieval"],
			},
		],
		tags: [
			"data",
			"analysis",
			"visualization",
			"charts",
			"business-intelligence",
		],
	},
	{
		agentId: "api_agent",
		name: "api_agent",
		displayName: "API Agent",
		description:
			"Executes external API calls based on registered OpenAPI specifications. Best for calling REST APIs, integrating with third-party services, and data retrieval using OpenAPI Services.",
		deploymentUrl: getUnifiedUrl(
			"API_AGENT_URL",
			"http://localhost:8131",
			"api-agent",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: false,
			usesOpenAPI: true,
		},
		skills: [
			{
				id: "execute_openapi_tool",
				name: "Execute OpenAPI Tool",
				description:
					"Execute operations from registered OpenAPI specifications",
				tags: ["api", "openapi", "rest"],
			},
			{
				id: "call_external_api",
				name: "Call External API",
				description:
					"Make authenticated API calls to external services using OpenAPI specs",
				tags: ["api", "http", "integration"],
			},
		],
		tags: ["api", "openapi", "integration", "rest"],
	},
	{
		agentId: "prompt_enhancer",
		name: "prompt_enhancer",
		displayName: "Prompt Enhancer",
		description:
			"Enhances and optimizes prompts for better AI responses. Best for refining prompts, adding context, and improving clarity for LLM interactions.",
		deploymentUrl: getUnifiedUrl(
			"PROMPT_ENHANCER_URL",
			"http://localhost:8134",
			"prompt-enhancer",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: true,
			requiresEditor: true,
			editorType: "prompt",
		},
		skills: [
			{
				id: "enhance_prompt",
				name: "Enhance Prompt",
				description:
					"Improve prompts with better structure, clarity, and context",
				tags: ["prompt", "enhancement"],
			},
			{
				id: "optimize_prompt",
				name: "Optimize Prompt",
				description:
					"Optimize prompts for specific LLM capabilities and use cases",
				tags: ["prompt", "optimization"],
			},
		],
		tags: ["prompt", "enhancement", "optimization"],
	},
	{
		agentId: "backlog_updater",
		name: "backlog_updater",
		displayName: "Backlog Updater",
		description:
			"Updates project backlogs and features based on changes, feedback, and new requirements. Best for keeping backlogs current with implementation progress.",
		deploymentUrl: getUnifiedUrl(
			"BACKLOG_UPDATER_URL",
			"http://localhost:8135",
			"backlog-updater",
		),
		framework: "LangGraph",
		protocols: ["A2A", "AG-UI"],
		capabilities: {
			supportsPredictiveState: false,
		},
		skills: [
			{
				id: "update_backlog",
				name: "Update Backlog",
				description:
					"Update project backlog items based on implementation progress and feedback",
				tags: ["backlog", "update", "project-management"],
			},
			{
				id: "sync_stories",
				name: "Sync Stories",
				description:
					"Synchronize features with current implementation state",
				tags: ["stories", "sync", "agile"],
			},
		],
		tags: ["backlog", "project-management", "agile", "stories"],
	},
	// ========================================================================
	// Weave Agents (Multi-Agent Orchestration)
	// These agents are routed to by Fabric Loom for code-aware tasks.
	// Port Convention: weave-readers: 8140, weave-shuttle: 8141, weave-planners: 8142
	// ========================================================================
	{
		agentId: "weave_thread",
		name: "weave_thread",
		displayName: "Thread (Codebase Explorer)",
		description:
			"Read-only codebase exploration agent. Searches files, reads code, analyzes project structure, and finds patterns. Best for: finding code, understanding architecture, locating usages, exploring file structure.",
		deploymentUrl: getUnifiedUrl(
			"WEAVE_READERS_URL",
			"http://localhost:8140",
			"weave-readers",
		),
		framework: "Vercel AI SDK",
		protocols: ["A2A"],
		capabilities: {},
		skills: [
			{
				id: "explore_codebase",
				name: "Explore Codebase",
				description:
					"Search and explore a codebase to find files, patterns, and understand structure",
				tags: ["code", "search", "exploration"],
			},
			{
				id: "find_code_usage",
				name: "Find Code Usage",
				description:
					"Find all usages of a function, class, or variable across the codebase",
				tags: ["code", "search", "usage"],
			},
			{
				id: "analyze_architecture",
				name: "Analyze Architecture",
				description:
					"Understand project structure, module relationships, and architectural patterns",
				tags: ["architecture", "analysis", "structure"],
			},
		],
		tags: ["code", "exploration", "codebase", "read-only", "weave"],
	},
	{
		agentId: "weave_spindle",
		name: "weave_spindle",
		displayName: "Spindle (External Researcher)",
		description:
			"Read-only external research agent. Fetches documentation, API references, library examples, and best practices from the web. Best for: looking up docs, researching libraries, finding API references.",
		deploymentUrl: getUnifiedUrl(
			"WEAVE_READERS_URL",
			"http://localhost:8140",
			"weave-readers",
		),
		framework: "Vercel AI SDK",
		protocols: ["A2A"],
		capabilities: {},
		skills: [
			{
				id: "research_documentation",
				name: "Research Documentation",
				description:
					"Fetch and synthesize documentation for libraries, APIs, and frameworks",
				tags: ["documentation", "research", "api"],
			},
			{
				id: "find_best_practices",
				name: "Find Best Practices",
				description:
					"Research best practices and recommended patterns for technologies",
				tags: ["best-practices", "patterns", "research"],
			},
		],
		tags: ["research", "documentation", "external", "read-only", "weave"],
	},
	{
		agentId: "weave_weft",
		name: "weave_weft",
		displayName: "Weft (Quality Reviewer)",
		description:
			"Read-only code quality reviewer. Reviews plans and implementations for correctness, completeness, and quality. Returns APPROVE or REJECT verdicts with specific blocking issues. Best for: code review, plan validation, quality assurance.",
		deploymentUrl: getUnifiedUrl(
			"WEAVE_READERS_URL",
			"http://localhost:8140",
			"weave-readers",
		),
		framework: "Vercel AI SDK",
		protocols: ["A2A"],
		capabilities: {},
		skills: [
			{
				id: "review_code",
				name: "Review Code",
				description:
					"Review code changes for correctness, completeness, and quality",
				tags: ["review", "quality", "code"],
			},
			{
				id: "validate_plan",
				name: "Validate Plan",
				description:
					"Review an execution plan to verify file references exist and tasks have context",
				tags: ["review", "plan", "validation"],
			},
		],
		tags: ["review", "quality", "code-review", "read-only", "weave"],
	},
	{
		agentId: "weave_warp",
		name: "weave_warp",
		displayName: "Warp (Security Auditor)",
		description:
			"Read-only security and spec compliance auditor. Checks for auth, crypto, token handling, input validation, and injection vulnerabilities. Reviews against OAuth2, OIDC, JWT, CORS, CSP specs. Best for: security review, vulnerability scanning, compliance audit.",
		deploymentUrl: getUnifiedUrl(
			"WEAVE_READERS_URL",
			"http://localhost:8140",
			"weave-readers",
		),
		framework: "Vercel AI SDK",
		protocols: ["A2A"],
		capabilities: {},
		skills: [
			{
				id: "security_audit",
				name: "Security Audit",
				description:
					"Audit code for security vulnerabilities including auth, crypto, injection, and token handling",
				tags: ["security", "audit", "vulnerabilities"],
			},
			{
				id: "compliance_check",
				name: "Compliance Check",
				description:
					"Verify code against security specs: OAuth2, OIDC, JWT, CORS, CSP",
				tags: ["compliance", "security", "specs"],
			},
		],
		tags: ["security", "audit", "compliance", "read-only", "weave"],
	},
	{
		agentId: "weave_shuttle",
		name: "weave_shuttle",
		displayName: "Shuttle (Code Implementer)",
		description:
			"Write-enabled implementation agent. Writes code, creates files, runs builds, and executes commands in a sandboxed environment. Best for: implementing features, fixing bugs, writing code, creating files.",
		deploymentUrl: getUnifiedUrl(
			"WEAVE_SHUTTLE_URL",
			"http://localhost:8141",
			"weave-shuttle",
		),
		framework: "Vercel AI SDK",
		protocols: ["A2A"],
		capabilities: {},
		skills: [
			{
				id: "implement_code",
				name: "Implement Code",
				description:
					"Write and implement code changes based on specifications",
				tags: ["code", "implementation", "write"],
			},
			{
				id: "fix_bug",
				name: "Fix Bug",
				description: "Diagnose and fix bugs in existing code",
				tags: ["bug", "fix", "debug"],
			},
			{
				id: "create_files",
				name: "Create Files",
				description:
					"Create new files and directories with proper structure",
				tags: ["files", "create", "write"],
			},
		],
		tags: ["code", "implementation", "write", "sandbox", "weave"],
	},
	// Pattern is NOT a standalone A2A agent — it's the orchestrator's planning
	// brain in weave mode, called as an internal activity via A2A to weave-planners.

	// ========================================================================
	// Sidekick (Inline AI SDK Agent)
	// Runs inline in the Next.js route handler, not as a separate service.
	// ========================================================================
	{
		agentId: "sidekick",
		name: "sidekick",
		displayName: "Sidekick",
		description:
			"AI assistant that helps configure agents in the Agent Builder via structured suggestions.",
		deploymentUrl: "", // Runs inline — no separate deployment
		framework: "AI_SDK",
		protocols: [],
		capabilities: {},
		skills: [
			{
				id: "configure_agent",
				name: "Configure Agent",
				description:
					"Help users configure agent tools, instructions, skills, knowledge sources, and model settings through accept/reject suggestions",
				tags: ["agent-builder", "configuration", "suggestions"],
			},
		],
		tags: ["agent-builder", "configuration", "inline"],
	},
];

/**
 * Validate A2A endpoint
 * Returns true if the agent is reachable and supports A2A protocol
 */
async function validateA2AEndpoint(
	url: string,
): Promise<{ valid: boolean; error?: string }> {
	try {
		const agentCardUrl = new URL("/.well-known/agent.json", url);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		try {
			const response = await fetch(agentCardUrl.toString(), {
				method: "GET",
				signal: controller.signal,
			});

			if (!response.ok) {
				return {
					valid: false,
					error: `HTTP ${response.status}: ${response.statusText}`,
				};
			}

			const card = await response.json();

			// Basic validation
			if (!card.name || !card.url || !card.protocolVersion) {
				return {
					valid: false,
					error: "Invalid agent card: missing required fields",
				};
			}

			// Check protocol version
			if (!card.protocolVersion.startsWith("0.")) {
				return {
					valid: false,
					error: `Unsupported protocol version: ${card.protocolVersion}`,
				};
			}

			return { valid: true };
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === "AbortError") {
				return { valid: false, error: "Connection timeout" };
			}
			return { valid: false, error: error.message };
		}
		return { valid: false, error: "Unknown error" };
	}
}

/**
 * Register or update a system agent
 */
async function upsertSystemAgent(
	agent: SystemAgentDefinition,
	validateA2A: boolean,
): Promise<{
	success: boolean;
	action: "created" | "updated" | "skipped";
	error?: string;
}> {
	// Optionally validate A2A endpoint
	if (validateA2A) {
		console.log(`  Validating A2A endpoint: ${agent.deploymentUrl}`);
		const validation = await validateA2AEndpoint(agent.deploymentUrl);
		if (!validation.valid) {
			console.log(
				`  WARNING: A2A validation failed: ${validation.error}`,
			);
			// Don't skip - still register but mark as inactive
		}
	}

	try {
		// Check if agent exists
		const existing = await db.registeredAgent.findUnique({
			where: { agentId: agent.agentId },
		});

		// Build metadata as a plain JSON object (using JSON.parse/stringify to ensure it's serializable)
		const metadata = JSON.parse(
			JSON.stringify({
				skills: agent.skills,
				tags: agent.tags || [],
				protocols: agent.protocols,
				capabilities: agent.capabilities,
				isSystemAgent: true,
			}),
		);

		const agentData = {
			name: agent.name,
			displayName: agent.displayName,
			description: agent.description,
			framework: agent.framework,
			deploymentUrl: agent.deploymentUrl,
			scope: "SYSTEM",
			status: "ACTIVE",
			config: {},
			metadata,
		};

		if (existing) {
			// Update existing agent
			await db.registeredAgent.update({
				where: { agentId: agent.agentId },
				data: {
					...agentData,
					lastHealthCheck: new Date(),
				},
			});
			return { success: true, action: "updated" };
		}
		// Create new agent
		await db.registeredAgent.create({
			data: {
				agentId: agent.agentId,
				...agentData,
			},
		});
		return { success: true, action: "created" };
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		return { success: false, action: "skipped", error: errorMessage };
	}
}

/**
 * Main seed function
 */
async function seedSystemAgents() {
	console.log("=== Seeding System Agents ===\n");

	const validateA2A = process.env.VALIDATE_A2A === "true";
	if (validateA2A) {
		console.log("A2A validation enabled - will test agent endpoints\n");
	} else {
		console.log(
			"A2A validation disabled - use VALIDATE_A2A=true to enable\n",
		);
	}

	const results = {
		created: 0,
		updated: 0,
		failed: 0,
	};

	for (const agent of SYSTEM_AGENTS) {
		console.log(`Processing: ${agent.displayName} (${agent.agentId})`);
		console.log(`  URL: ${agent.deploymentUrl}`);

		const result = await upsertSystemAgent(agent, validateA2A);

		if (result.success) {
			console.log(`  Result: ${result.action.toUpperCase()}`);
			if (result.action === "created") {
				results.created++;
			}
			if (result.action === "updated") {
				results.updated++;
			}
		} else {
			console.log(`  Result: FAILED - ${result.error}`);
			results.failed++;
		}

		console.log("");
	}

	console.log("=== Summary ===");
	console.log(`Created: ${results.created}`);
	console.log(`Updated: ${results.updated}`);
	console.log(`Failed: ${results.failed}`);
	console.log(`Total: ${SYSTEM_AGENTS.length}`);

	console.log(
		"\nNote: Embeddings will be generated automatically by the health monitor on first startup.",
	);
}

// Run if executed directly
seedSystemAgents()
	.then(() => {
		console.log("\nSystem agents seeding complete!");
		process.exit(0);
	})
	.catch((error) => {
		console.error("Error seeding system agents:", error);
		process.exit(1);
	});
