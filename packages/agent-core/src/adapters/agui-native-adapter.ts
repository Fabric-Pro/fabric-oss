/**
 * AG-UI Native Agent Adapter
 *
 * Generic adapter for agents that natively support the AG-UI protocol.
 * Use this adapter for any agent (Python, TypeScript, C#, etc.) that:
 * - Natively emits AG-UI protocol events
 * - Exposes HTTP/WebSocket endpoint
 * - Implements standard AG-UI event types
 *
 * This adapter replaces framework-specific adapters (MicrosoftAgentAdapter, PydanticAIAdapter)
 * for agents that don't require special integration features.
 *
 * @example
 * ```typescript
 * // Python Pydantic AI agent
 * const pythonAgent = new AGUINativeAgentAdapter({
 *   name: "python_agent",
 *   displayName: "Python Agent",
 *   description: "Custom Python agent with AG-UI support",
 *   framework: "pydantic-ai",
 *   language: "python",
 *   deploymentUrl: "http://localhost:8000",
 *   tools: [MY_TOOL],
 *   agentConfig: { model: "gpt-4o", temperature: 0.7, ... },
 * });
 *
 * // C# Microsoft Agent Framework agent
 * const csharpAgent = new AGUINativeAgentAdapter({
 *   name: "csharp_agent",
 *   displayName: "C# Agent",
 *   description: "Custom C# agent with AG-UI support",
 *   framework: "microsoft-agent-framework",
 *   language: "csharp",
 *   deploymentUrl: "http://localhost:5000",
 *   tools: [MY_TOOL],
 *   agentConfig: { model: "gpt-4o", temperature: 0.7, ... },
 * });
 * ```
 */

import type { ToolDefinition } from "@repo/agent-tools";
import type { BaseAgentState } from "@repo/agent-types";
import type {
	AgentConfig,
	AgentHealthStatus,
	CopilotKitAgentAdapter,
} from "../adapter";

/**
 * Configuration for AG-UI Native Agent Adapter
 */
export interface AGUINativeAgentConfig {
	/** Agent name (unique identifier) */
	name: string;

	/** Display name for UI */
	displayName: string;

	/** Agent description */
	description: string;

	/** Framework identifier (e.g., "pydantic-ai", "microsoft-agent-framework", "custom") */
	framework: string;

	/** Programming language (e.g., "python", "typescript", "csharp") */
	language: string;

	/** Deployment URL (where the agent is running) */
	deploymentUrl: string;

	/** Tools available to this agent */
	tools: ToolDefinition[];

	/** Agent configuration */
	agentConfig: Omit<AgentConfig, "name" | "displayName" | "description">;

	/** Optional API key for authentication */
	apiKey?: string;

	/** Optional version (default: "1.0.0") */
	version?: string;

	/** Optional tags for categorization */
	tags?: string[];
}

/**
 * AG-UI Native Agent Adapter
 *
 * Generic adapter for agents that natively support the AG-UI protocol.
 * Works with any language/framework that emits AG-UI events.
 */
export class AGUINativeAgentAdapter<
	TState extends BaseAgentState = BaseAgentState,
> implements CopilotKitAgentAdapter<TState>
{
	readonly name: string;
	readonly framework: string;
	readonly language: string;
	readonly config: AgentConfig;
	readonly tools: ToolDefinition[];

	private deploymentUrl: string;
	private apiKey?: string;
	private copilotKitAgent: any = null;
	private version: string;
	private tags: string[];

	constructor(config: AGUINativeAgentConfig) {
		this.name = config.name;
		this.framework = config.framework;
		this.language = config.language;
		this.deploymentUrl = config.deploymentUrl;
		this.apiKey = config.apiKey;
		this.tools = config.tools;
		this.version = config.version || "1.0.0";
		this.tags = config.tags || [];

		// Merge agent config
		this.config = {
			name: config.name,
			displayName: config.displayName,
			description: config.description,
			...config.agentConfig,
		};

		console.log("[AGUINativeAdapter] Initializing adapter:", {
			name: this.name,
			framework: this.framework,
			language: this.language,
			deploymentUrl: this.deploymentUrl,
		});
	}

	/**
	 * Initialize CopilotKit agent
	 * Uses RemoteAgent for generic HTTP/WebSocket communication
	 */
	private initializeCopilotKitAgent(): void {
		if (this.copilotKitAgent) {
			return;
		}

		try {
			// Dynamically import to avoid hard dependency
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { RemoteAgent } = require("@copilotkit/runtime");

			this.copilotKitAgent = new RemoteAgent({
				url: this.deploymentUrl,
				name: this.name,
				description: this.config.description,
				...(this.apiKey && {
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
					},
				}),
			});

			console.log("[AGUINativeAdapter] CopilotKit agent initialized:", {
				name: this.name,
				framework: this.framework,
			});
		} catch (error) {
			console.error(
				"[AGUINativeAdapter] Failed to initialize CopilotKit agent:",
				error,
			);
			throw new Error(
				`Failed to initialize AG-UI native agent "${this.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	getDeploymentUrl(): string {
		return this.deploymentUrl;
	}

	/**
	 * Health check
	 * Verifies the agent is running and responsive
	 */
	async healthCheck(): Promise<AgentHealthStatus> {
		const startTime = Date.now();

		try {
			const response = await fetch(`${this.deploymentUrl}/health`, {
				method: "GET",
				headers: this.apiKey
					? { Authorization: `Bearer ${this.apiKey}` }
					: {},
				signal: AbortSignal.timeout(
					this.config.healthCheckTimeout || 5000,
				),
			});

			const responseTime = Date.now() - startTime;

			return {
				healthy: response.ok,
				responseTime,
				lastCheck: new Date(),
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
	 * Get the underlying CopilotKit agent for CopilotKit runtime
	 * Returns a RemoteAgent that communicates via AG-UI protocol
	 */
	getCopilotKitAgent(): any {
		this.initializeCopilotKitAgent();
		return this.copilotKitAgent;
	}
}
