/**
 * Microsoft Agent Framework Adapter
 *
 * Adapter for Microsoft Agent Framework (C#/.NET) agents.
 * Supports:
 * - CopilotKit integration via HTTP/WebSocket
 * - AG-UI protocol event emission
 * - Predictive state updates
 * - Health monitoring
 */

import type { ToolDefinition } from "@repo/agent-tools";
import type { BaseAgentState } from "@repo/agent-types";
import type {
	AgentConfig,
	AgentHealthStatus,
	CopilotKitAgentAdapter,
} from "../adapter";

export interface MicrosoftAgentAdapterConfig {
	/** Agent identifier */
	name: string;

	/** Display name */
	displayName: string;

	/** Agent description */
	description: string;

	/** Deployment URL (e.g., "https://agent.example.com") */
	deploymentUrl: string;

	/** Agent configuration */
	agentConfig: Partial<AgentConfig>;

	/** Available tools */
	tools?: ToolDefinition[];

	/** Agent version */
	version?: string;

	/** Agent tags */
	tags?: string[];

	/** API key for authentication (optional) */
	apiKey?: string;
}

/**
 * Microsoft Agent Framework Adapter
 *
 * Wraps Microsoft Agent Framework agents to provide:
 * - Framework-agnostic access
 * - CopilotKit integration
 * - AG-UI protocol compliance
 */
export class MicrosoftAgentAdapter<
	TState extends BaseAgentState = BaseAgentState,
> implements CopilotKitAgentAdapter<TState>
{
	readonly name: string;
	readonly framework = "microsoft-agent-framework";
	readonly language = "csharp";
	readonly deploymentUrl: string;
	readonly version: string;
	readonly tags: string[];
	readonly tools: ToolDefinition[];
	readonly config: AgentConfig;

	private apiKey?: string;
	private copilotKitAgent: any = null;

	constructor(config: MicrosoftAgentAdapterConfig) {
		this.name = config.name;
		this.deploymentUrl = config.deploymentUrl;
		this.version = config.version || "1.0.0";
		this.tags = config.tags || [];
		this.tools = config.tools || [];
		this.apiKey = config.apiKey;

		// Merge agent config with defaults
		this.config = {
			name: config.name,
			displayName: config.displayName,
			description: config.description,
			model: config.agentConfig.model || "gpt-4o",
			temperature: config.agentConfig.temperature ?? 0.7,
			maxTokens: config.agentConfig.maxTokens || 4000,
			timeout: config.agentConfig.timeout || 30000,
			recursionLimit: config.agentConfig.recursionLimit || 25,
			predictiveStates: config.agentConfig.predictiveStates || [],
			...config.agentConfig,
		};

		console.log("[MicrosoftAgentAdapter] Initializing adapter:", {
			name: this.name,
			deploymentUrl: this.deploymentUrl,
			language: this.language,
		});
	}

	/**
	 * Initialize CopilotKit agent
	 * Microsoft agents expose a CopilotKit-compatible HTTP/WebSocket endpoint
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

			console.log(
				"[MicrosoftAgentAdapter] CopilotKit agent initialized:",
				{
					name: this.name,
				},
			);
		} catch (error) {
			console.error(
				"[MicrosoftAgentAdapter] Failed to initialize CopilotKit agent:",
				error,
			);
			throw new Error(
				`Failed to initialize Microsoft agent "${this.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	getDeploymentUrl(): string {
		return this.deploymentUrl;
	}

	async healthCheck(): Promise<AgentHealthStatus> {
		const startTime = Date.now();
		const timeout = this.config.healthCheckTimeout ?? 5000;

		try {
			const healthUrl = `${this.deploymentUrl}/health`;
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};

			if (this.apiKey) {
				headers.Authorization = `Bearer ${this.apiKey}`;
			}

			const response = await fetch(healthUrl, {
				method: "GET",
				headers,
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

			// Try to parse version from response
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

	getCopilotKitAgent(): any {
		this.initializeCopilotKitAgent();
		return this.copilotKitAgent;
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
}
