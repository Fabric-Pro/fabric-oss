/**
 * Agent Error Types
 *
 * Custom error classes for agent-related failures.
 * Provides structured error information for better error handling and debugging.
 */

/**
 * Base Agent Error
 *
 * All agent-specific errors extend this base class.
 */
export class AgentError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly details?: Record<string, any>,
	) {
		super(message);
		this.name = "AgentError";
		Object.setPrototypeOf(this, AgentError.prototype);
	}

	/**
	 * Convert error to JSON for serialization
	 */
	toJSON() {
		return {
			name: this.name,
			code: this.code,
			message: this.message,
			details: this.details,
			stack: this.stack,
		};
	}
}

/**
 * Agent Health Check Error
 *
 * Thrown when agent health check fails.
 */
export class AgentHealthCheckError extends AgentError {
	constructor(
		public readonly agentName: string,
		public readonly responseTime: number,
		message: string,
		details?: Record<string, any>,
	) {
		super(message, "AGENT_HEALTH_CHECK_FAILED", {
			agentName,
			responseTime,
			...details,
		});
		this.name = "AgentHealthCheckError";
		Object.setPrototypeOf(this, AgentHealthCheckError.prototype);
	}
}

/**
 * Agent Not Found Error
 *
 * Thrown when attempting to access an agent that doesn't exist in the registry.
 */
export class AgentNotFoundError extends AgentError {
	constructor(
		public readonly agentName: string,
		details?: Record<string, any>,
	) {
		super(`Agent "${agentName}" not found in registry`, "AGENT_NOT_FOUND", {
			agentName,
			...details,
		});
		this.name = "AgentNotFoundError";
		Object.setPrototypeOf(this, AgentNotFoundError.prototype);
	}
}

/**
 * Agent Execution Error
 *
 * Thrown when agent execution fails.
 */
export class AgentExecutionError extends AgentError {
	constructor(
		public readonly taskId: string,
		public readonly agentName: string,
		public readonly stage: string,
		message: string,
		details?: Record<string, any>,
	) {
		super(message, "AGENT_EXECUTION_FAILED", {
			taskId,
			agentName,
			stage,
			...details,
		});
		this.name = "AgentExecutionError";
		Object.setPrototypeOf(this, AgentExecutionError.prototype);
	}
}

/**
 * Agent Timeout Error
 *
 * Thrown when agent execution exceeds timeout.
 */
export class AgentTimeoutError extends AgentError {
	constructor(
		public readonly agentName: string,
		public readonly timeoutMs: number,
		public readonly stage?: string,
		details?: Record<string, any>,
	) {
		super(
			`Agent "${agentName}" timed out after ${timeoutMs}ms${stage ? ` during stage: ${stage}` : ""}`,
			"AGENT_TIMEOUT",
			{
				agentName,
				timeoutMs,
				stage,
				...details,
			},
		);
		this.name = "AgentTimeoutError";
		Object.setPrototypeOf(this, AgentTimeoutError.prototype);
	}
}

/**
 * Agent Configuration Error
 *
 * Thrown when agent configuration is invalid.
 */
export class AgentConfigurationError extends AgentError {
	constructor(
		public readonly agentName: string,
		message: string,
		details?: Record<string, any>,
	) {
		super(message, "AGENT_CONFIGURATION_ERROR", {
			agentName,
			...details,
		});
		this.name = "AgentConfigurationError";
		Object.setPrototypeOf(this, AgentConfigurationError.prototype);
	}
}

/**
 * Agent Authorization Error
 *
 * Thrown when user is not authorized to access or trigger an agent.
 */
export class AgentAuthorizationError extends AgentError {
	constructor(
		public readonly agentName: string,
		public readonly userId: string,
		message: string,
		details?: Record<string, any>,
	) {
		super(message, "AGENT_AUTHORIZATION_FAILED", {
			agentName,
			userId,
			...details,
		});
		this.name = "AgentAuthorizationError";
		Object.setPrototypeOf(this, AgentAuthorizationError.prototype);
	}
}
