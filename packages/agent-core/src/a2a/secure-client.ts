/**
 * Secure A2A Protocol Client
 *
 * Extends the base A2A client with multi-tenant security features:
 * - Automatic service token injection
 * - Signed tenant context propagation
 * - Request tracing (request ID, source agent)
 *
 * This is the recommended client for orchestrator-to-agent communication.
 */

import { A2AClient, type A2AClientOptions } from "./client";
import type { A2AMessage, A2ATask, TaskEvent } from "./types";

/**
 * Tenant context for secure requests
 */
export interface SecureTenantContext {
	userId: string;
	organizationId: string | null;
	scopes?: string[];
	apiKeyId?: string;
}

/**
 * AI configuration for system agents
 * Passed as headers to enable agents to use the user's configured AI provider
 */
export interface AIConfig {
	/** AI token for secure API key exchange (short-lived JWT) */
	token: string;
	/** Model identifier (e.g., "groq/llama-3.3-70b-versatile") */
	model: string;
	/** Provider type (e.g., "GROQ", "OPENAI_DIRECT") */
	provider: string;
	/** Base URL for the provider (optional) */
	baseUrl?: string;
}

/** Header name for AI tokens */
const AI_TOKEN_HEADER = "X-AI-Token";

/**
 * Options for secure A2A client
 */
export interface SecureA2AClientOptions extends A2AClientOptions {
	/** Service token for inter-agent auth (defaults to AGENT_SERVICE_SECRET) */
	serviceToken?: string;
	/** Source agent identifier for tracing */
	sourceAgent?: string;
}

/**
 * Secure A2A Client with multi-tenant support
 *
 * Usage:
 * ```typescript
 * const client = new SecureA2AClient({
 *   sourceAgent: "orchestrator",
 * });
 *
 * const task = await client.sendMessageSecure(
 *   "http://task-planner:8126",
 *   { role: "user", parts: [{ type: "text", text: "Plan this task" }] },
 *   { userId: "user_123", organizationId: "org_456" }
 * );
 * ```
 */
export class SecureA2AClient extends A2AClient {
	private serviceToken: string;
	private sourceAgent: string;

	constructor(options: SecureA2AClientOptions = {}) {
		super(options);
		this.serviceToken =
			options.serviceToken || process.env.AGENT_SERVICE_SECRET || "";
		this.sourceAgent = options.sourceAgent || "unknown";

		if (!this.serviceToken) {
			console.warn(
				"[SecureA2AClient] AGENT_SERVICE_SECRET not set. Secure requests will fail.",
			);
		}
	}

	/**
	 * Send a message with security headers
	 *
	 * @param baseUrl - Agent endpoint URL
	 * @param message - A2A message to send
	 * @param tenant - Tenant context for multi-tenancy
	 * @param options - Additional options including AI config for system agents
	 */
	async sendMessageSecure(
		baseUrl: string,
		message: A2AMessage,
		tenant: SecureTenantContext,
		options?: {
			contextId?: string;
			metadata?: Record<string, unknown>;
			requestId?: string;
			/** AI config to pass to system agents (not external agents) */
			aiConfig?: AIConfig;
		},
	): Promise<A2ATask> {
		const securityHeaders = this.createSecurityHeaders(
			tenant,
			options?.requestId,
		);
		const aiHeaders = options?.aiConfig
			? this.createAIConfigHeaders(options.aiConfig)
			: {};

		// Create a new client with security headers for this request
		const secureClient = new A2AClient({
			...this.getOptions(),
			headers: {
				...this.getOptions().headers,
				...securityHeaders,
				...aiHeaders,
			},
		});

		return secureClient.sendMessage(baseUrl, message, options);
	}

	/**
	 * Send a streaming message with security headers
	 */
	async *sendMessageStreamSecure(
		baseUrl: string,
		message: A2AMessage,
		tenant: SecureTenantContext,
		options?: {
			contextId?: string;
			metadata?: Record<string, unknown>;
			requestId?: string;
		},
	): AsyncGenerator<TaskEvent> {
		const securityHeaders = this.createSecurityHeaders(
			tenant,
			options?.requestId,
		);

		const secureClient = new A2AClient({
			...this.getOptions(),
			headers: {
				...this.getOptions().headers,
				...securityHeaders,
			},
		});

		yield* secureClient.sendMessageStream(baseUrl, message, options);
	}

	/**
	 * Create security headers for the request
	 */
	private createSecurityHeaders(
		tenant: SecureTenantContext,
		requestId?: string,
	): Record<string, string> {
		const timestamp = Date.now();

		// Create payload
		const payloadData = {
			...tenant,
			_ts: timestamp,
		};
		const payload = Buffer.from(JSON.stringify(payloadData)).toString(
			"base64",
		);

		// Create HMAC signature
		const crypto = require("node:crypto");
		const hmac = crypto.createHmac("sha256", this.serviceToken);
		hmac.update(payload);
		const signature = hmac.digest("hex");

		const headers: Record<string, string> = {
			"X-Service-Token": this.serviceToken,
			"X-Tenant-Payload": payload,
			"X-Tenant-Signature": signature,
			"X-Tenant-Timestamp": timestamp.toString(),
			"X-Source-Agent": this.sourceAgent,
			// Also pass tenant context as explicit headers for unified-server compatibility
			"X-Tenant-User-ID": tenant.userId,
		};

		if (tenant.organizationId) {
			headers["X-Tenant-Organization-ID"] = tenant.organizationId;
		}

		if (requestId) {
			headers["X-Request-ID"] = requestId;
		}

		return headers;
	}

	/**
	 * Create AI config headers for system agents
	 * Uses X-AI-Token (short-lived JWT) instead of raw API keys for security
	 * Agents exchange the token for API credentials via /api/ai/keys/exchange
	 */
	private createAIConfigHeaders(aiConfig: AIConfig): Record<string, string> {
		const headers: Record<string, string> = {
			// Token for secure API key exchange (replaces X-AI-API-Key)
			[AI_TOKEN_HEADER]: aiConfig.token,
			// Model/provider hints (not sensitive)
			"X-AI-Model": aiConfig.model,
			"X-AI-Provider": aiConfig.provider,
		};

		if (aiConfig.baseUrl) {
			headers["X-AI-Base-URL"] = aiConfig.baseUrl;
		}

		return headers;
	}

	/**
	 * Get the underlying options (for creating new clients)
	 */
	private getOptions(): Required<A2AClientOptions> {
		return (this as unknown as { options: Required<A2AClientOptions> })
			.options;
	}
}
