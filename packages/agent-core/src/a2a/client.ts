/**
 * A2A Protocol Client
 * Implements Google's Agent2Agent protocol (v0.3.0) for inter-agent communication
 * @see https://a2a-protocol.org/latest/specification/
 */

import type {
	A2AError,
	A2AMessage,
	A2ATask,
	AgentCard,
	SendMessageRequest,
	TaskEvent,
} from "./types";

export interface A2AClientOptions {
	timeout?: number;
	headers?: Record<string, string>;
	retryAttempts?: number;
	retryDelay?: number;
}

const DEFAULT_OPTIONS: Required<A2AClientOptions> = {
	timeout: 60000,
	headers: {},
	retryAttempts: 3,
	retryDelay: 1000,
};

export class A2AClient {
	private options: Required<A2AClientOptions>;

	constructor(options: A2AClientOptions = {}) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Discover agent capabilities via Agent Card
	 * Tries GET /.well-known/agent-card.json first (v0.3.0),
	 * falls back to GET /.well-known/agent.json (legacy)
	 */
	async getAgentCard(baseUrl: string): Promise<AgentCard> {
		// Try v0.3.0 well-known URI first
		const primaryUrl = new URL("/.well-known/agent-card.json", baseUrl);
		const primaryResponse = await this.fetch(primaryUrl.toString(), {
			method: "GET",
		});

		if (primaryResponse.ok) {
			const card = (await primaryResponse.json()) as AgentCard;
			this.validateAgentCard(card);
			return card;
		}

		// Fall back to legacy well-known URI
		const fallbackUrl = new URL("/.well-known/agent.json", baseUrl);
		const fallbackResponse = await this.fetch(fallbackUrl.toString(), {
			method: "GET",
		});

		if (!fallbackResponse.ok) {
			throw new A2AClientError(
				`Failed to fetch agent card: ${fallbackResponse.status} ${fallbackResponse.statusText}`,
				"AGENT_CARD_FETCH_FAILED",
			);
		}

		const card = (await fallbackResponse.json()) as AgentCard;
		this.validateAgentCard(card);
		return card;
	}

	/**
	 * Send a message to an agent and get a Task
	 * POST /a2a/send
	 */
	async sendMessage(
		baseUrl: string,
		message: A2AMessage,
		options?: { contextId?: string; metadata?: Record<string, unknown> },
	): Promise<A2ATask> {
		const url = new URL("/a2a/send", baseUrl);

		const request: SendMessageRequest = {
			message,
			contextId: options?.contextId,
			metadata: options?.metadata,
		};

		const response = await this.fetch(url.toString(), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new A2AClientError(
				`Failed to send message: ${response.status} ${response.statusText} - ${errorBody}`,
				"SEND_MESSAGE_FAILED",
			);
		}

		const result = (await response.json()) as { task?: A2ATask } | A2ATask;
		if ("task" in result && result.task) {
			return result.task;
		}
		return result as A2ATask;
	}

	/**
	 * Send a message with streaming response
	 * POST /a2a/send/stream
	 */
	async *sendMessageStream(
		baseUrl: string,
		message: A2AMessage,
		options?: { contextId?: string; metadata?: Record<string, unknown> },
	): AsyncGenerator<TaskEvent> {
		const url = new URL("/a2a/send/stream", baseUrl);

		const request: SendMessageRequest = {
			message,
			contextId: options?.contextId,
			metadata: options?.metadata,
		};

		const response = await this.fetch(url.toString(), {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new A2AClientError(
				`Failed to send streaming message: ${response.status} - ${errorBody}`,
				"STREAM_MESSAGE_FAILED",
			);
		}

		if (!response.body) {
			throw new A2AClientError(
				"No response body for stream",
				"NO_STREAM_BODY",
			);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data && data !== "[DONE]") {
							try {
								const event = JSON.parse(data) as TaskEvent;
								yield event;
							} catch {
								console.warn(
									"Failed to parse SSE event:",
									data,
								);
							}
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Get task status and artifacts
	 * GET /a2a/tasks/{taskId}
	 */
	async getTask(baseUrl: string, taskId: string): Promise<A2ATask> {
		const url = new URL(`/a2a/tasks/${taskId}`, baseUrl);

		const response = await this.fetch(url.toString(), {
			method: "GET",
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new A2AClientError(
					`Task not found: ${taskId}`,
					"TASK_NOT_FOUND",
				);
			}
			throw new A2AClientError(
				`Failed to get task: ${response.status} ${response.statusText}`,
				"GET_TASK_FAILED",
			);
		}

		return response.json() as Promise<A2ATask>;
	}

	/**
	 * Cancel a running task
	 * POST /a2a/tasks/{taskId}/cancel
	 */
	async cancelTask(baseUrl: string, taskId: string): Promise<void> {
		const url = new URL(`/a2a/tasks/${taskId}/cancel`, baseUrl);

		const response = await this.fetch(url.toString(), {
			method: "POST",
		});

		if (!response.ok && response.status !== 204) {
			throw new A2AClientError(
				`Failed to cancel task: ${response.status} ${response.statusText}`,
				"CANCEL_TASK_FAILED",
			);
		}
	}

	/**
	 * Poll for task completion
	 */
	async waitForCompletion(
		baseUrl: string,
		taskId: string,
		options?: { pollInterval?: number; timeout?: number },
	): Promise<A2ATask> {
		const pollInterval = options?.pollInterval || 1000;
		const timeout = options?.timeout || this.options.timeout;
		const startTime = Date.now();

		while (true) {
			const task = await this.getTask(baseUrl, taskId);

			if (
				task.status === "completed" ||
				task.status === "failed" ||
				task.status === "canceled"
			) {
				return task;
			}

			if (Date.now() - startTime > timeout) {
				throw new A2AClientError(
					`Task ${taskId} timed out after ${timeout}ms`,
					"TASK_TIMEOUT",
				);
			}

			await this.sleep(pollInterval);
		}
	}

	/**
	 * Health check for an agent
	 */
	async healthCheck(baseUrl: string): Promise<boolean> {
		try {
			// Try to fetch agent card as a health check
			await this.getAgentCard(baseUrl);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Fetch with retry logic and exponential backoff
	 * Retries on network errors (ECONNREFUSED, DNS failures, timeouts)
	 * Does NOT retry on HTTP errors (4xx, 5xx) - those are returned as-is
	 */
	private async fetch(url: string, init: RequestInit): Promise<Response> {
		let lastError: Error | null = null;
		const maxAttempts = this.options.retryAttempts;
		const baseDelay = this.options.retryDelay;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(
				() => controller.abort(),
				this.options.timeout,
			);

			try {
				const response = await fetch(url, {
					...init,
					signal: controller.signal,
					headers: {
						...this.options.headers,
						...init.headers,
					},
				});
				clearTimeout(timeoutId);
				// Return on successful fetch (even if HTTP error status)
				return response;
			} catch (error) {
				clearTimeout(timeoutId);
				lastError =
					error instanceof Error ? error : new Error(String(error));

				// Check if this is a retryable error (network-level failures)
				const isRetryable = this.isRetryableError(lastError);

				if (!isRetryable || attempt >= maxAttempts) {
					// Don't retry non-retryable errors or if we've exhausted attempts
					throw new A2AClientError(
						`Network request to ${url} failed after ${attempt} attempt(s): ${lastError.message}`,
						"NETWORK_ERROR",
						{
							url,
							attempts: attempt,
							originalError: lastError.message,
							cause: this.getErrorCause(lastError),
						},
					);
				}

				// Calculate delay with exponential backoff (capped at 30 seconds)
				const delay = Math.min(baseDelay * 2 ** (attempt - 1), 30000);
				console.log(
					`[A2A Client] Request to ${url} failed (attempt ${attempt}/${maxAttempts}): ${lastError.message}. Retrying in ${delay}ms...`,
				);
				await this.sleep(delay);
			}
		}

		// This shouldn't be reached, but just in case
		throw new A2AClientError(
			`Network request to ${url} failed after ${maxAttempts} attempts`,
			"NETWORK_ERROR",
			{ url, attempts: maxAttempts },
		);
	}

	/**
	 * Determine if an error is retryable (network-level failures)
	 */
	private isRetryableError(error: Error): boolean {
		const message = error.message.toLowerCase();
		const name = error.name.toLowerCase();

		// Network-level failures that should be retried
		const retryablePatterns = [
			"econnrefused", // Connection refused
			"econnreset", // Connection reset
			"enotfound", // DNS lookup failed
			"etimedout", // Connection timed out
			"esockettimedout", // Socket timed out
			"enetunreach", // Network unreachable
			"ehostunreach", // Host unreachable
			"epipe", // Broken pipe
			"fetch failed", // Generic fetch failure
			"network", // Generic network error
			"socket hang up", // Socket hang up
			"aborted", // Request aborted (timeout)
		];

		return retryablePatterns.some(
			(pattern) => message.includes(pattern) || name.includes(pattern),
		);
	}

	/**
	 * Extract a human-readable error cause
	 */
	private getErrorCause(error: Error): string {
		const message = error.message.toLowerCase();

		if (message.includes("econnrefused")) {
			return "Connection refused - agent service may not be running";
		}
		if (message.includes("enotfound")) {
			return "DNS lookup failed - check agent URL";
		}
		if (message.includes("etimedout") || message.includes("aborted")) {
			return "Connection timed out - agent may be overloaded or unreachable";
		}
		if (message.includes("econnreset")) {
			return "Connection reset - agent may have crashed or restarted";
		}
		if (message.includes("fetch failed")) {
			return "Network request failed - check if agent is running and accessible";
		}

		return "Unknown network error";
	}

	private validateAgentCard(card: AgentCard): void {
		if (!card.name) {
			throw new A2AClientError(
				"Agent card missing 'name'",
				"INVALID_AGENT_CARD",
			);
		}
		if (!card.url) {
			throw new A2AClientError(
				"Agent card missing 'url'",
				"INVALID_AGENT_CARD",
			);
		}
		if (!card.protocolVersion) {
			throw new A2AClientError(
				"Agent card missing 'protocolVersion'",
				"INVALID_AGENT_CARD",
			);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export class A2AClientError extends Error {
	code: string;
	details?: Record<string, unknown>;

	constructor(
		message: string,
		code: string,
		details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "A2AClientError";
		this.code = code;
		this.details = details;
	}

	toA2AError(): A2AError {
		return {
			code: this.code,
			message: this.message,
			details: this.details,
		};
	}
}
