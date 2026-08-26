/**
 * Sandbox Client - HTTP client for Fabric Sandbox Worker
 *
 * Used by Temporal activities to interact with the sandbox service.
 */

import * as jose from "jose";
import type {
	ApiResponse,
	ClaudeResult,
	CommitResult,
	CreateSessionOptions,
	DiffResult,
	ExecOptions,
	ExecResult,
	PushOptions,
	PushResult,
	RunClaudeOptions,
	SandboxClientConfig,
	SandboxSession,
	SessionInfo,
} from "./types";
import { ExecOptionsSchema } from "./types";

export class SandboxClient {
	private baseUrl: string;
	private authSecret: string;
	private defaultTimeout: number;

	constructor(config: SandboxClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
		this.authSecret = config.authSecret;
		this.defaultTimeout = config.timeout || 30000;
	}

	/**
	 * Generate a JWT token for authenticating with the sandbox worker
	 */
	private async generateToken(
		userId: string,
		organizationId?: string,
	): Promise<string> {
		const secret = new TextEncoder().encode(this.authSecret);

		const token = await new jose.SignJWT({
			sub: userId,
			org: organizationId,
		})
			.setProtectedHeader({ alg: "HS256" })
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(secret);

		return token;
	}

	/**
	 * Make an authenticated request to the sandbox worker
	 */
	private async request<T>(
		method: string,
		path: string,
		userId: string,
		organizationId?: string,
		body?: unknown,
		timeout?: number,
	): Promise<T> {
		const token = await this.generateToken(userId, organizationId);
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			timeout || this.defaultTimeout,
		);

		try {
			const response = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});

			const data = (await response.json()) as ApiResponse<T>;

			if (!data.success) {
				throw new Error(data.error?.message || "Request failed");
			}

			return data.data as T;
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Create a new sandbox session
	 */
	async createSession(
		userId: string,
		organizationId: string | undefined,
		options: CreateSessionOptions,
	): Promise<SandboxSession> {
		return this.request<SandboxSession>(
			"POST",
			"/sessions",
			userId,
			organizationId,
			options,
		);
	}

	/**
	 * Get session information
	 */
	async getSession(
		sessionId: string,
		userId: string,
		organizationId?: string,
	): Promise<SessionInfo> {
		return this.request<SessionInfo>(
			"GET",
			`/sessions/${sessionId}`,
			userId,
			organizationId,
		);
	}

	/**
	 * Run Claude Code in the sandbox
	 */
	async runClaude(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		options: RunClaudeOptions,
		anthropicApiKey: string,
	): Promise<ClaudeResult> {
		// Claude operations can take a long time
		const timeout = (options.timeout || 300) * 1000 + 30000; // Add 30s buffer

		return this.request<ClaudeResult>(
			"POST",
			`/sessions/${sessionId}/claude`,
			userId,
			organizationId,
			{ ...options, anthropicApiKey },
			timeout,
		);
	}

	/**
	 * Execute a shell command in the sandbox
	 * Default timeout increased to 180 seconds to handle complex operations like git, npm, etc.
	 */
	async exec(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		options: ExecOptions,
	): Promise<ExecResult> {
		const parsedOptions = ExecOptionsSchema.parse(options);
		// Default 180 seconds (3 min) to handle complex git/npm operations + 30s buffer
		const timeout = (parsedOptions.timeout || 180) * 1000 + 30000;

		return this.request<ExecResult>(
			"POST",
			`/sessions/${sessionId}/exec`,
			userId,
			organizationId,
			parsedOptions,
			timeout,
		);
	}

	/**
	 * Get git diff of current changes
	 */
	async getDiff(
		sessionId: string,
		userId: string,
		organizationId?: string,
		staged = false,
	): Promise<DiffResult> {
		const query = staged ? "?staged=true" : "";
		return this.request<DiffResult>(
			"GET",
			`/sessions/${sessionId}/diff${query}`,
			userId,
			organizationId,
		);
	}

	/**
	 * Commit staged changes
	 */
	async commit(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		message: string,
	): Promise<CommitResult> {
		return this.request<CommitResult>(
			"POST",
			`/sessions/${sessionId}/commit`,
			userId,
			organizationId,
			{ message },
		);
	}

	/**
	 * Push changes to remote
	 */
	async push(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		options?: PushOptions,
	): Promise<PushResult> {
		return this.request<PushResult>(
			"POST",
			`/sessions/${sessionId}/push`,
			userId,
			organizationId,
			options || {},
		);
	}

	/**
	 * Read a file from the sandbox
	 */
	async readFile(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		path: string,
	): Promise<string> {
		const result = await this.request<{ content: string }>(
			"GET",
			`/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`,
			userId,
			organizationId,
		);
		return result.content;
	}

	/**
	 * Write a file to the sandbox
	 */
	async writeFile(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		path: string,
		content: string,
	): Promise<void> {
		await this.request<{ success: boolean }>(
			"POST",
			`/sessions/${sessionId}/files`,
			userId,
			organizationId,
			{ path, content },
		);
	}

	/**
	 * Destroy a sandbox session
	 */
	async destroySession(
		sessionId: string,
		userId: string,
		organizationId?: string,
	): Promise<void> {
		await this.request<{ success: boolean }>(
			"DELETE",
			`/sessions/${sessionId}`,
			userId,
			organizationId,
		);
	}
}

/**
 * Create a sandbox client instance from environment variables
 */
export function createSandboxClient(): SandboxClient {
	const baseUrl = process.env.SANDBOX_WORKER_URL;
	const authSecret = process.env.SANDBOX_AUTH_SECRET;

	if (!baseUrl) {
		throw new Error("SANDBOX_WORKER_URL environment variable is required");
	}
	if (!authSecret) {
		throw new Error("SANDBOX_AUTH_SECRET environment variable is required");
	}

	return new SandboxClient({
		baseUrl,
		authSecret,
	});
}
