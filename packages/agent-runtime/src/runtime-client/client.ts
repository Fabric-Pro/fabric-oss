/**
 * Runtime API Client
 *
 * Lightweight HTTP client for calling the Fabric Runtime API.
 * Replaces direct database access in agents.
 */

import type { TenantContext, TenantModelConfig } from "../types";

// ============================================================================
// Types
// ============================================================================

export interface RuntimeClientConfig {
	/** Base URL of the Runtime API (e.g., http://localhost:3001) */
	baseUrl: string;
	/** Request timeout in ms (default: 10000) */
	timeout?: number;
}

interface ResolveTenantRequest {
	apiKey: string;
	requiredScopes?: string[];
}

interface ResolveModelRequest {
	apiKey: string;
	taskType:
		| "SIMPLE"
		| "COMPLEX"
		| "REASONING"
		| "CHAT"
		| "TOOL_CALLING"
		| "EMBEDDING"
		| "IMAGE"
		| "AUDIO";
	agentId?: string;
}

interface AgentConfig {
	id: string;
	agentId: string;
	name: string;
	displayName: string;
	description: string | null;
	framework: string;
	deploymentUrl: string | null;
	status: string;
	scope: string;
	config: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
}

// ============================================================================
// Client Implementation
// ============================================================================

export class RuntimeClient {
	private readonly baseUrl: string;
	private readonly timeout: number;

	constructor(config: RuntimeClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
		this.timeout = config.timeout ?? 10000;
	}

	/**
	 * Resolve tenant from API key
	 */
	async resolveTenant(
		request: ResolveTenantRequest,
	): Promise<TenantContext | null> {
		try {
			const response = await this.post<TenantContext>(
				"/api/runtime/resolveTenant",
				request,
			);
			return response;
		} catch (error) {
			if (this.isHttpError(error, 401) || this.isHttpError(error, 403)) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Resolve model configuration for a task type
	 */
	async resolveModel(
		request: ResolveModelRequest,
	): Promise<TenantModelConfig | null> {
		try {
			const response = await this.post<TenantModelConfig>(
				"/api/runtime/resolveModel",
				request,
			);
			return response;
		} catch (error) {
			if (
				this.isHttpError(error, 401) ||
				this.isHttpError(error, 403) ||
				this.isHttpError(error, 412)
			) {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Get agent configuration
	 */
	async getAgent(
		apiKey: string,
		agentId: string,
	): Promise<AgentConfig | null> {
		try {
			const response = await this.post<AgentConfig | null>(
				"/api/runtime/getAgent",
				{
					apiKey,
					agentId,
				},
			);
			return response;
		} catch (error) {
			if (
				this.isHttpError(error, 401) ||
				this.isHttpError(error, 403) ||
				this.isHttpError(error, 404)
			) {
				return null;
			}
			throw error;
		}
	}

	// ============================================================================
	// HTTP Helpers
	// ============================================================================

	private async post<T>(path: string, body: unknown): Promise<T> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new RuntimeApiError(
					response.status,
					response.statusText,
					errorBody,
				);
			}

			return (await response.json()) as T;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private isHttpError(error: unknown, statusCode: number): boolean {
		return (
			error instanceof RuntimeApiError && error.statusCode === statusCode
		);
	}
}

// ============================================================================
// Error Types
// ============================================================================

class RuntimeApiError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly statusText: string,
		public readonly body: string,
	) {
		super(`Runtime API error: ${statusCode} ${statusText}`);
		this.name = "RuntimeApiError";
	}
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalClient: RuntimeClient | null = null;

/**
 * Create a new RuntimeClient instance
 */
export function createRuntimeClient(
	config: RuntimeClientConfig,
): RuntimeClient {
	return new RuntimeClient(config);
}

/**
 * Get or create the global RuntimeClient instance
 * Uses RUNTIME_API_URL environment variable
 */
export function getRuntimeClient(): RuntimeClient {
	if (!globalClient) {
		const baseUrl =
			process.env.RUNTIME_API_URL ||
			process.env.NEXT_PUBLIC_SITE_URL ||
			"http://localhost:3001";
		globalClient = new RuntimeClient({ baseUrl });
	}
	return globalClient;
}
