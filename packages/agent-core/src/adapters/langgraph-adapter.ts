/**
 * LangGraph Agent Adapter
 *
 * Adapter for LangGraph-based agents (TypeScript or Python).
 * Implements the AgentAdapter interface to enable:
 * - Unified agent registration
 * - CopilotKit integration
 * - Health monitoring
 * - Framework-agnostic access
 */

import type { ToolDefinition } from "@repo/agent-tools";
import type { BaseAgentState } from "@repo/agent-types";
import type {
	AgentConfig,
	AgentHealthStatus,
	CopilotKitAgentAdapter,
} from "../adapter";

// Adapter init logs run once per agent per CopilotKit request and drown
// out real diagnostics. Off by default; AGENT_CORE_VERBOSE=1 re-enables.
const VERBOSE = process.env.AGENT_CORE_VERBOSE === "1";

/**
 * LangGraph agent configuration
 */
export interface LangGraphAgentConfig {
	/** Agent name (unique identifier) */
	name: string;

	/** Display name for UI */
	displayName: string;

	/** Agent description */
	description: string;

	/** Deployment URL (where the LangGraph server is running) */
	deploymentUrl: string;

	/** Graph ID (LangGraph graph identifier) */
	graphId: string;

	/** LangSmith API key (optional, for tracing) */
	langsmithApiKey?: string;

	/** Tools available to this agent */
	tools: ToolDefinition[];

	/** Agent configuration */
	agentConfig: Omit<AgentConfig, "name" | "displayName" | "description">;

	/** Implementation language (typescript or python) */
	language?: "typescript" | "python";

	/** Agent version */
	version?: string;

	/** Agent tags */
	tags?: string[];

	/** Custom headers to forward to the agent (for auth, tenant context, etc.) */
	headers?: Record<string, string>;
}

/**
 * LangGraph implementation of AgentAdapter
 *
 * This adapter wraps LangGraph agents and provides:
 * - CopilotKit compatibility via LangGraphAgent
 * - Health checks
 * - Metadata for registry
 * - AG-UI protocol compliance
 */
export class LangGraphAgentAdapter<TState extends BaseAgentState>
	implements CopilotKitAgentAdapter<TState>
{
	readonly name: string;
	readonly framework = "langgraph";
	readonly language: string;
	readonly config: AgentConfig;
	readonly tools: ToolDefinition[];

	private deploymentUrl: string;
	private graphId: string;
	private langsmithApiKey?: string;
	private langGraphAgent: any; // Will be LangGraphAgent or LangGraphHttpAgent from @copilotkit/runtime
	private version: string;
	private tags: string[];
	private headers?: Record<string, string>;

	constructor(config: LangGraphAgentConfig) {
		this.name = config.name;
		this.deploymentUrl = config.deploymentUrl;
		this.graphId = config.graphId;
		this.langsmithApiKey = config.langsmithApiKey;
		this.tools = config.tools;
		this.language = config.language || "typescript";
		this.version = config.version || "1.0.0";
		this.tags = config.tags || [];
		this.headers = config.headers;

		// Merge agent config
		this.config = {
			name: config.name,
			displayName: config.displayName,
			description: config.description,
			...config.agentConfig,
		};

		if (VERBOSE) {
			console.log("[LangGraphAdapter] Initializing adapter:", {
				name: this.name,
				deploymentUrl: this.deploymentUrl,
				graphId: this.graphId,
				language: this.language,
				hasHeaders: !!config.headers,
			});
		}
	}

	/**
	 * Update headers for tenant context (called per-request)
	 * This allows dynamic header injection based on authenticated user
	 */
	setHeaders(headers: Record<string, string>): void {
		this.headers = { ...this.headers, ...headers };
		// Reset agent to force re-initialization with new headers
		this.langGraphAgent = undefined;
	}

	/**
	 * Initialize the underlying LangGraph agent
	 * This is called lazily when getCopilotKitAgent() is first invoked
	 *
	 * Uses LangGraphHttpAgent for self-hosted agents (supports custom headers)
	 * Falls back to LangGraphAgent for LangGraph Platform (no custom headers needed)
	 */
	private initializeLangGraphAgent(): void {
		if (this.langGraphAgent) {
			return;
		}

		// Dynamically import to avoid hard dependency
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const copilotRuntime = require("@copilotkit/runtime");

			// Use LangGraphHttpAgent for self-hosted agents (supports headers)
			// Use LangGraphAgent for LangGraph Platform
			if (this.headers && Object.keys(this.headers).length > 0) {
				const { LangGraphHttpAgent } = copilotRuntime;

				// LangGraphHttpAgent expects a full URL path to the agent endpoint
				// Our unified-server exposes at /copilotkit
				const agentUrl = `${this.deploymentUrl}/copilotkit`;

				this.langGraphAgent = new LangGraphHttpAgent({
					url: agentUrl,
					headers: this.headers,
				});

				if (VERBOSE) {
					console.log(
						"[LangGraphAdapter] LangGraphHttpAgent initialized:",
						{
							name: this.name,
							url: agentUrl,
							headerKeys: Object.keys(this.headers),
						},
					);
				}
			} else {
				// Fall back to LangGraphAgent (for LangGraph Platform or no headers)
				const { LangGraphAgent } = copilotRuntime;

				this.langGraphAgent = new LangGraphAgent({
					deploymentUrl: this.deploymentUrl,
					graphId: this.graphId,
					langsmithApiKey: this.langsmithApiKey || "",
				});

				if (VERBOSE) {
					console.log(
						"[LangGraphAdapter] LangGraphAgent initialized:",
						{
							name: this.name,
							graphId: this.graphId,
						},
					);
				}
			}
		} catch (error) {
			console.error(
				"[LangGraphAdapter] Failed to initialize LangGraph agent:",
				error,
			);
			throw new Error(
				`Failed to initialize LangGraph agent: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	getDeploymentUrl(): string {
		return this.deploymentUrl;
	}

	async healthCheck(): Promise<AgentHealthStatus> {
		const startTime = Date.now();
		const timeout = this.config.healthCheckTimeout ?? 5000; // Default 5 seconds

		try {
			// Try to hit the health endpoint
			const healthUrl = `${this.deploymentUrl}/health`;
			const response = await fetch(healthUrl, {
				method: "GET",
				signal: AbortSignal.timeout(timeout),
			});

			const responseTime = Date.now() - startTime;

			if (!response.ok) {
				return {
					healthy: false,
					responseTime,
					error: `Health check failed with status ${response.status}`,
					lastCheck: new Date(),
				};
			}

			// Try to parse version from response if available
			let version: string | undefined;
			try {
				const data = (await response.json()) as { version?: string };
				version = data.version;
			} catch {
				// Ignore JSON parse errors
			}

			return {
				healthy: true,
				responseTime,
				lastCheck: new Date(),
				version: version || this.version,
			};
		} catch (error) {
			const responseTime = Date.now() - startTime;
			return {
				healthy: false,
				responseTime,
				error: error instanceof Error ? error.message : "Unknown error",
				lastCheck: new Date(),
			};
		}
	}

	getMetadata() {
		return {
			name: this.name,
			framework: this.framework,
			language: this.language,
			version: this.version,
			description: this.config.description,
			tags: this.tags,
			deploymentUrl: this.deploymentUrl,
			tools: this.tools.map((t) => t.function.name),
		};
	}

	/**
	 * Get the underlying LangGraph agent for CopilotKit runtime
	 * This allows CopilotKit to communicate with the LangGraph server
	 */
	getCopilotKitAgent(): any {
		this.initializeLangGraphAgent();
		return this.langGraphAgent;
	}
}
