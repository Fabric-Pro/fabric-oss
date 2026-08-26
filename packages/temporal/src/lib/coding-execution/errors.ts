import type { CodingRunProvider } from "@repo/database/prisma/generated/client";

/**
 * Error codes for coding execution provider failures
 */
export type ProviderErrorCode =
	| "AUTH_FAILED"
	| "TIMEOUT"
	| "INVALID_SESSION"
	| "NETWORK_ERROR"
	| "RATE_LIMITED"
	| "VALIDATION_ERROR"
	| "PORT_UNAVAILABLE"
	| "RUNTIME_NOT_FOUND"
	| "WORKSPACE_ERROR"
	| "UNKNOWN";

/**
 * Base error class for all coding execution provider errors
 */
export class ProviderError extends Error {
	constructor(
		message: string,
		public readonly provider: CodingRunProvider,
		public readonly code: ProviderErrorCode,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "ProviderError";
		// Maintain proper stack trace in V8
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, ProviderError);
		}
	}

	/**
	 * Returns a structured error object for logging/telemetry
	 */
	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			provider: this.provider,
			code: this.code,
			cause:
				this.cause instanceof Error ? this.cause.message : this.cause,
			stack: this.stack,
		};
	}
}

/**
 * Error thrown when authentication fails with the provider
 */
export class AuthError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		message = "Authentication failed",
		cause?: unknown,
	) {
		super(message, provider, "AUTH_FAILED", cause);
		this.name = "AuthError";
	}
}

/**
 * Error thrown when a timeout occurs
 */
export class TimeoutError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		public readonly operation: string,
		public readonly timeoutMs: number,
		cause?: unknown,
	) {
		super(
			`${operation} timed out after ${timeoutMs}ms`,
			provider,
			"TIMEOUT",
			cause,
		);
		this.name = "TimeoutError";
	}
}

/**
 * Error thrown when session validation fails
 */
export class SessionValidationError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		message = "Invalid session",
		cause?: unknown,
	) {
		super(message, provider, "VALIDATION_ERROR", cause);
		this.name = "SessionValidationError";
	}
}

/**
 * Error thrown when network communication fails
 */
export class NetworkError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		public readonly url: string,
		public readonly statusCode?: number,
		cause?: unknown,
	) {
		const statusMsg = statusCode ? ` (HTTP ${statusCode})` : "";
		super(
			`Network request failed${statusMsg}: ${url}`,
			provider,
			"NETWORK_ERROR",
			cause,
		);
		this.name = "NetworkError";
	}
}

/**
 * Error thrown when rate limiting is exceeded
 */
export class RateLimitError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		message = "Rate limit exceeded",
		public readonly retryAfterMs?: number,
	) {
		super(message, provider, "RATE_LIMITED");
		this.name = "RateLimitError";
	}
}

/**
 * Error thrown when no available port can be found
 */
export class PortUnavailableError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		public readonly startPort: number,
		public readonly attempts: number,
	) {
		super(
			`No available port found after ${attempts} attempts starting from ${startPort}`,
			provider,
			"PORT_UNAVAILABLE",
		);
		this.name = "PortUnavailableError";
	}
}

/**
 * Error thrown when a required runtime (CLI tool) is not found
 */
export class RuntimeNotFoundError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		public readonly command: string,
	) {
		super(
			`Required runtime not found: ${command}. Please install it globally or ensure it's in PATH.`,
			provider,
			"RUNTIME_NOT_FOUND",
		);
		this.name = "RuntimeNotFoundError";
	}
}

/**
 * Error thrown when workspace operations fail
 */
export class WorkspaceError extends ProviderError {
	constructor(
		provider: CodingRunProvider,
		message: string,
		public readonly workspaceId?: string,
		cause?: unknown,
	) {
		super(message, provider, "WORKSPACE_ERROR", cause);
		this.name = "WorkspaceError";
	}
}

/**
 * Converts any error to a ProviderError
 */
export function toProviderError(
	error: unknown,
	provider: CodingRunProvider,
	defaultCode: ProviderErrorCode = "UNKNOWN",
): ProviderError {
	if (error instanceof ProviderError) {
		return error;
	}

	if (error instanceof Error) {
		return new ProviderError(error.message, provider, defaultCode, error);
	}

	return new ProviderError(String(error), provider, defaultCode);
}
