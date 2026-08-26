import type { ConsolaInstance } from "consola";
import { logger as baseLogger } from "./logger";

/**
 * Structured logger for MCP operations
 * Provides context-aware logging with correlation IDs and compliance tracking
 */

export interface MCPLogContext {
	correlationId?: string;
	userId?: string;
	organizationId?: string;
	configId?: string;
	serverId?: string;
	operation?: string;
	authType?: string;
	timestamp?: string;
}

export interface MCPComplianceLog extends MCPLogContext {
	action:
		| "oauth_connection_created"
		| "oauth_connection_refreshed"
		| "oauth_connection_deleted"
		| "config_created"
		| "config_updated"
		| "config_deleted"
		| "test_connection"
		| "dcr_registration"
		| "token_revocation";
	metadata?: Record<string, any>;
}

class MCPLogger {
	private logger: ConsolaInstance;
	private defaultContext: MCPLogContext;

	constructor(logger: ConsolaInstance) {
		this.logger = logger;
		this.defaultContext = {};
	}

	/**
	 * Set default context for all log messages
	 */
	setDefaultContext(context: MCPLogContext) {
		this.defaultContext = context;
	}

	/**
	 * Clear default context
	 */
	clearContext() {
		this.defaultContext = {};
	}

	/**
	 * Create a child logger with additional context
	 */
	child(context: MCPLogContext): MCPLogger {
		const child = new MCPLogger(this.logger);
		child.defaultContext = { ...this.defaultContext, ...context };
		return child;
	}

	/**
	 * Format log message with context
	 */
	private formatMessage(message: string, context?: MCPLogContext): string {
		const fullContext = { ...this.defaultContext, ...context };
		const contextStr = Object.entries(fullContext)
			.filter(([_, value]) => value !== undefined)
			.map(([key, value]) => `${key}=${value}`)
			.join(" ");

		return contextStr ? `${message} | ${contextStr}` : message;
	}

	/**
	 * Debug level logging
	 */
	debug(message: string, context?: MCPLogContext) {
		this.logger.debug(this.formatMessage(message, context));
	}

	/**
	 * Info level logging
	 */
	info(message: string, context?: MCPLogContext) {
		this.logger.info(this.formatMessage(message, context));
	}

	/**
	 * Warning level logging
	 */
	warn(message: string, context?: MCPLogContext) {
		this.logger.warn(this.formatMessage(message, context));
	}

	/**
	 * Error level logging
	 */
	error(message: string, error?: Error, context?: MCPLogContext) {
		const errorMessage = error
			? `${message}: ${error.message}\n${error.stack}`
			: message;
		this.logger.error(this.formatMessage(errorMessage, context));
	}

	/**
	 * Log OAuth connection attempts
	 */
	logOAuthConnection(
		status: "success" | "failure",
		context: MCPLogContext & { error?: string },
	) {
		const message = `OAuth connection ${status}`;

		if (status === "success") {
			this.info(message, {
				...context,
				operation: "oauth_connection",
				timestamp: new Date().toISOString(),
			});
		} else {
			this.warn(message, {
				...context,
				operation: "oauth_connection",
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * Log OAuth token refresh operations
	 */
	logTokenRefresh(
		status: "success" | "failure",
		context: MCPLogContext & { error?: string },
	) {
		const message = `OAuth token refresh ${status}`;

		if (status === "success") {
			this.info(message, {
				...context,
				operation: "token_refresh",
				timestamp: new Date().toISOString(),
			});
		} else {
			this.warn(message, {
				...context,
				operation: "token_refresh",
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * Log configuration changes
	 */
	logConfigChange(
		action: "created" | "updated" | "deleted",
		context: MCPLogContext,
	) {
		this.info(`MCP config ${action}`, {
			...context,
			operation: `config_${action}`,
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Log test connection results
	 */
	logTestConnection(
		status: "success" | "failure",
		context: MCPLogContext & {
			responseTime?: number;
			serverName?: string;
			error?: string;
		},
	) {
		const message = `Test connection ${status}`;

		if (status === "success") {
			this.info(message, {
				...context,
				operation: "test_connection",
				timestamp: new Date().toISOString(),
			});
		} else {
			this.warn(message, {
				...context,
				operation: "test_connection",
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * Log compliance-critical operations
	 * These logs should be preserved for audit purposes
	 */
	logCompliance(log: MCPComplianceLog) {
		const message = `[COMPLIANCE] ${log.action}`;
		this.info(message, {
			...log,
			timestamp: log.timestamp || new Date().toISOString(),
		});

		// In production, this would also send to a compliance logging service
		// e.g., AWS CloudWatch Logs, Azure Monitor, or a SIEM system
	}

	/**
	 * Log DCR (Dynamic Client Registration) operations
	 */
	logDCR(
		status: "success" | "failure",
		context: MCPLogContext & { error?: string; clientId?: string },
	) {
		const message = `DCR registration ${status}`;

		if (status === "success") {
			this.info(message, {
				...context,
				operation: "dcr_registration",
				timestamp: new Date().toISOString(),
			});
		} else {
			this.warn(message, {
				...context,
				operation: "dcr_registration",
				timestamp: new Date().toISOString(),
			});
		}
	}

	/**
	 * Log security-related events
	 */
	logSecurity(event: string, context: MCPLogContext & { reason?: string }) {
		this.warn(`[SECURITY] ${event}`, {
			...context,
			operation: "security_event",
			timestamp: new Date().toISOString(),
		});
	}

	/**
	 * Log performance metrics
	 */
	logPerformance(
		operation: string,
		durationMs: number,
		context?: MCPLogContext,
	) {
		this.debug(`Performance: ${operation} took ${durationMs}ms`, {
			...context,
			operation: "performance",
			timestamp: new Date().toISOString(),
		});
	}
}

// Export singleton instance
export const mcpLogger = new MCPLogger(baseLogger);

// Export class for custom instances
export { MCPLogger };
