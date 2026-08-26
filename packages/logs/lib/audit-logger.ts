/**
 * Audit Logger for Security and Compliance Events
 *
 * Provides structured logging for security-relevant events including:
 * - Authentication events (login, logout, failed attempts)
 * - Authorization events (access granted/denied)
 * - Data access events (CRUD operations on sensitive data)
 * - System events (configuration changes, admin actions)
 * - Security incidents (rate limiting, suspicious activity)
 *
 * Features:
 * - Correlation IDs for request tracing
 * - Structured JSON output for log aggregation
 * - Configurable severity levels
 * - Optional external transport (webhook, Loki, etc.)
 */

import { createConsola, type LogObject } from "consola";

/**
 * Audit event types
 */
export type AuditEventType =
	// Authentication
	| "AUTH_LOGIN_SUCCESS"
	| "AUTH_LOGIN_FAILED"
	| "AUTH_LOGOUT"
	| "AUTH_SESSION_EXPIRED"
	| "AUTH_PASSWORD_CHANGED"
	| "AUTH_MFA_ENABLED"
	| "AUTH_MFA_DISABLED"
	| "AUTH_API_KEY_CREATED"
	| "AUTH_API_KEY_REVOKED"
	// Authorization
	| "AUTHZ_ACCESS_GRANTED"
	| "AUTHZ_ACCESS_DENIED"
	| "AUTHZ_PERMISSION_CHANGED"
	| "AUTHZ_ROLE_CHANGED"
	// Data Operations
	| "DATA_CREATE"
	| "DATA_READ"
	| "DATA_UPDATE"
	| "DATA_DELETE"
	| "DATA_EXPORT"
	| "DATA_IMPORT"
	// Security Events
	| "SECURITY_RATE_LIMIT_EXCEEDED"
	| "SECURITY_SUSPICIOUS_ACTIVITY"
	| "SECURITY_BRUTE_FORCE_DETECTED"
	| "SECURITY_SSRF_BLOCKED"
	| "SECURITY_INJECTION_BLOCKED"
	| "SECURITY_INVALID_TOKEN"
	// Admin Actions
	| "ADMIN_USER_CREATED"
	| "ADMIN_USER_DELETED"
	| "ADMIN_USER_SUSPENDED"
	| "ADMIN_CONFIG_CHANGED"
	| "ADMIN_INTEGRATION_ADDED"
	| "ADMIN_INTEGRATION_REMOVED"
	// Workflow/Agent Events
	| "WORKFLOW_EXECUTED"
	| "WORKFLOW_FAILED"
	| "AGENT_TRIGGERED"
	| "AGENT_COMPLETED"
	| "AGENT_FAILED"
	// MCP Events
	| "MCP_CONNECTION_SUCCESS"
	| "MCP_CONNECTION_FAILED"
	| "MCP_TOOL_EXECUTED"
	| "MCP_AUTH_REFRESHED";

/**
 * Severity levels for audit events
 */
export type AuditSeverity = "info" | "warning" | "error" | "critical";

/**
 * Audit event metadata
 */
export interface AuditEventMeta {
	/** Unique identifier for this event */
	eventId?: string;
	/** Correlation ID for request tracing */
	correlationId?: string;
	/** User ID who triggered the event */
	userId?: string;
	/** Organization ID context */
	organizationId?: string;
	/** Client IP address */
	clientIp?: string;
	/** User agent string */
	userAgent?: string;
	/** Resource type being accessed */
	resourceType?: string;
	/** Resource ID being accessed */
	resourceId?: string;
	/** HTTP method if applicable */
	method?: string;
	/** Request path if applicable */
	path?: string;
	/** Duration in milliseconds */
	durationMs?: number;
	/** Additional context-specific data */
	[key: string]: unknown;
}

/**
 * Full audit event structure
 */
export interface AuditEvent {
	timestamp: string;
	type: AuditEventType;
	severity: AuditSeverity;
	message: string;
	meta: AuditEventMeta;
}

/**
 * External transport for sending audit logs to external services
 */
export interface AuditTransport {
	send(event: AuditEvent): Promise<void>;
}

// Configurable transports
const transports: AuditTransport[] = [];

// Create a dedicated audit logger instance
const auditConsola = createConsola({
	formatOptions: {
		date: true,
		colors: process.env.NODE_ENV !== "production",
	},
	// Use custom reporters for structured output
	reporters: [
		{
			log: (logObj: LogObject) => {
				const output = {
					timestamp: new Date().toISOString(),
					level: logObj.type,
					...logObj.args[0],
				};

				// Output as JSON in production, pretty print in development
				if (process.env.NODE_ENV === "production") {
					console.log(JSON.stringify(output));
				} else {
					console.log("[AUDIT]", JSON.stringify(output, null, 2));
				}
			},
		},
	],
});

/**
 * Generate a unique event ID
 */
function generateEventId(): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 8);
	return `evt_${timestamp}_${random}`;
}

/**
 * Map audit severity to consola log level
 */
function getSeverityLogFn(severity: AuditSeverity) {
	switch (severity) {
		case "critical":
			return auditConsola.error;
		case "error":
			return auditConsola.error;
		case "warning":
			return auditConsola.warn;
		default:
			return auditConsola.info;
	}
}

/**
 * Log an audit event
 */
export async function logAuditEvent(
	type: AuditEventType,
	message: string,
	severity: AuditSeverity = "info",
	meta: AuditEventMeta = {},
): Promise<void> {
	const event: AuditEvent = {
		timestamp: new Date().toISOString(),
		type,
		severity,
		message,
		meta: {
			eventId: generateEventId(),
			...meta,
		},
	};

	// Log to console
	const logFn = getSeverityLogFn(severity);
	logFn(event);

	// Send to external transports
	for (const transport of transports) {
		try {
			await transport.send(event);
		} catch (error) {
			// Don't let transport errors break the application
			console.error("[AUDIT] Transport error:", error);
		}
	}
}

/**
 * Add an external transport for audit logs
 */
export function addAuditTransport(transport: AuditTransport): void {
	transports.push(transport);
}

/**
 * Remove a transport
 */
export function removeAuditTransport(transport: AuditTransport): void {
	const index = transports.indexOf(transport);
	if (index > -1) {
		transports.splice(index, 1);
	}
}

// Convenience functions for common audit events

/**
 * Log authentication event
 */
export function logAuthEvent(
	type: Extract<AuditEventType, `AUTH_${string}`>,
	userId: string | undefined,
	success: boolean,
	meta: AuditEventMeta = {},
): Promise<void> {
	const severity: AuditSeverity = success ? "info" : "warning";
	const message = success
		? `Authentication event: ${type}`
		: `Authentication failed: ${type}`;

	return logAuditEvent(type, message, severity, {
		userId,
		success,
		...meta,
	});
}

/**
 * Log authorization event
 */
export function logAuthzEvent(
	type: Extract<AuditEventType, `AUTHZ_${string}`>,
	userId: string,
	resourceType: string,
	resourceId: string,
	granted: boolean,
	meta: AuditEventMeta = {},
): Promise<void> {
	const severity: AuditSeverity = granted ? "info" : "warning";
	const message = granted
		? `Access granted to ${resourceType}/${resourceId}`
		: `Access denied to ${resourceType}/${resourceId}`;

	return logAuditEvent(type, message, severity, {
		userId,
		resourceType,
		resourceId,
		granted,
		...meta,
	});
}

/**
 * Log security event
 */
export function logSecurityEvent(
	type: Extract<AuditEventType, `SECURITY_${string}`>,
	message: string,
	meta: AuditEventMeta = {},
): Promise<void> {
	// Security events are at least warnings
	const severity: AuditSeverity =
		type === "SECURITY_RATE_LIMIT_EXCEEDED" ? "warning" : "error";

	return logAuditEvent(type, message, severity, meta);
}

/**
 * Log data operation event
 */
export function logDataEvent(
	operation: "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXPORT" | "IMPORT",
	resourceType: string,
	resourceId: string,
	userId: string,
	meta: AuditEventMeta = {},
): Promise<void> {
	const type = `DATA_${operation}` as Extract<
		AuditEventType,
		`DATA_${string}`
	>;
	const message = `${operation} operation on ${resourceType}/${resourceId}`;

	return logAuditEvent(type, message, "info", {
		userId,
		resourceType,
		resourceId,
		...meta,
	});
}

/**
 * Log admin action
 */
export function logAdminEvent(
	type: Extract<AuditEventType, `ADMIN_${string}`>,
	adminUserId: string,
	targetUserId: string | undefined,
	message: string,
	meta: AuditEventMeta = {},
): Promise<void> {
	return logAuditEvent(type, message, "warning", {
		userId: adminUserId,
		targetUserId,
		...meta,
	});
}

/**
 * Log workflow/agent event
 */
export function logWorkflowEvent(
	type: Extract<AuditEventType, `WORKFLOW_${string}` | `AGENT_${string}`>,
	workflowId: string,
	userId: string,
	success: boolean,
	meta: AuditEventMeta = {},
): Promise<void> {
	const severity: AuditSeverity = success ? "info" : "error";
	const message = success
		? `${type.split("_")[0]} executed successfully: ${workflowId}`
		: `${type.split("_")[0]} failed: ${workflowId}`;

	return logAuditEvent(type, message, severity, {
		userId,
		resourceType: type.startsWith("WORKFLOW") ? "workflow" : "agent",
		resourceId: workflowId,
		success,
		...meta,
	});
}

/**
 * Log MCP event
 */
export function logMcpEvent(
	type: Extract<AuditEventType, `MCP_${string}`>,
	serverName: string,
	userId: string,
	success: boolean,
	meta: AuditEventMeta = {},
): Promise<void> {
	const severity: AuditSeverity = success ? "info" : "warning";
	const message = success
		? `MCP ${type.replace("MCP_", "").toLowerCase().replace(/_/g, " ")}: ${serverName}`
		: `MCP operation failed on ${serverName}`;

	return logAuditEvent(type, message, severity, {
		userId,
		resourceType: "mcp_server",
		serverName,
		success,
		...meta,
	});
}

/**
 * Create a webhook transport for sending audit logs to external systems
 */
export function createWebhookTransport(
	webhookUrl: string,
	headers?: Record<string, string>,
): AuditTransport {
	return {
		async send(event: AuditEvent): Promise<void> {
			try {
				await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...headers,
					},
					body: JSON.stringify(event),
				});
			} catch (error) {
				console.error("[AUDIT] Failed to send to webhook:", error);
			}
		},
	};
}

/**
 * Initialize audit logging with optional external transport
 */
export function initAuditLogging(): void {
	const webhookUrl = process.env.AUDIT_LOG_WEBHOOK_URL;

	if (webhookUrl) {
		const headers: Record<string, string> = {};
		const authToken = process.env.AUDIT_LOG_WEBHOOK_TOKEN;
		if (authToken) {
			headers.Authorization = `Bearer ${authToken}`;
		}

		addAuditTransport(createWebhookTransport(webhookUrl, headers));

		if (process.env.NODE_ENV === "development") {
			console.log("[AUDIT] External audit log webhook configured");
		}
	}
}
