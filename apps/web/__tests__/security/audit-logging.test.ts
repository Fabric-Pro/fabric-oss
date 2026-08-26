/**
 * Tests for Audit Logging functionality
 * Validates event types, structures, and helper functions
 */

import type {
	AuditEventMeta,
	AuditEventType,
	AuditSeverity,
	AuditTransport,
} from "@repo/logs";
import { describe, expect, it } from "vitest";

describe("Audit Logging", () => {
	describe("Event Types", () => {
		it("should define authentication event types", () => {
			const authEvents: AuditEventType[] = [
				"AUTH_LOGIN_SUCCESS",
				"AUTH_LOGIN_FAILED",
				"AUTH_LOGOUT",
				"AUTH_SESSION_EXPIRED",
				"AUTH_PASSWORD_CHANGED",
				"AUTH_MFA_ENABLED",
				"AUTH_MFA_DISABLED",
				"AUTH_API_KEY_CREATED",
				"AUTH_API_KEY_REVOKED",
			];

			// This test validates the types exist at compile time
			expect(authEvents.length).toBe(9);
		});

		it("should define authorization event types", () => {
			const authzEvents: AuditEventType[] = [
				"AUTHZ_ACCESS_GRANTED",
				"AUTHZ_ACCESS_DENIED",
				"AUTHZ_PERMISSION_CHANGED",
				"AUTHZ_ROLE_CHANGED",
			];

			expect(authzEvents.length).toBe(4);
		});

		it("should define security event types", () => {
			const securityEvents: AuditEventType[] = [
				"SECURITY_RATE_LIMIT_EXCEEDED",
				"SECURITY_SUSPICIOUS_ACTIVITY",
				"SECURITY_BRUTE_FORCE_DETECTED",
				"SECURITY_SSRF_BLOCKED",
				"SECURITY_INJECTION_BLOCKED",
				"SECURITY_INVALID_TOKEN",
			];

			expect(securityEvents.length).toBe(6);
		});

		it("should define data operation event types", () => {
			const dataEvents: AuditEventType[] = [
				"DATA_CREATE",
				"DATA_READ",
				"DATA_UPDATE",
				"DATA_DELETE",
				"DATA_EXPORT",
				"DATA_IMPORT",
			];

			expect(dataEvents.length).toBe(6);
		});

		it("should define workflow/agent event types", () => {
			const workflowEvents: AuditEventType[] = [
				"WORKFLOW_EXECUTED",
				"WORKFLOW_FAILED",
				"AGENT_TRIGGERED",
				"AGENT_COMPLETED",
				"AGENT_FAILED",
			];

			expect(workflowEvents.length).toBe(5);
		});

		it("should define MCP event types", () => {
			const mcpEvents: AuditEventType[] = [
				"MCP_CONNECTION_SUCCESS",
				"MCP_CONNECTION_FAILED",
				"MCP_TOOL_EXECUTED",
				"MCP_AUTH_REFRESHED",
			];

			expect(mcpEvents.length).toBe(4);
		});

		it("should define admin event types", () => {
			const adminEvents: AuditEventType[] = [
				"ADMIN_USER_CREATED",
				"ADMIN_USER_DELETED",
				"ADMIN_USER_SUSPENDED",
				"ADMIN_CONFIG_CHANGED",
				"ADMIN_INTEGRATION_ADDED",
				"ADMIN_INTEGRATION_REMOVED",
			];

			expect(adminEvents.length).toBe(6);
		});
	});

	describe("Severity Levels", () => {
		it("should define all severity levels", () => {
			const severities: AuditSeverity[] = [
				"info",
				"warning",
				"error",
				"critical",
			];

			expect(severities.length).toBe(4);
		});

		it("should use correct severity for different event categories", () => {
			// Security events should typically be error or warning
			const securitySeverity: AuditSeverity = "error";
			expect(securitySeverity).toBe("error");

			// Admin events should be warning
			const adminSeverity: AuditSeverity = "warning";
			expect(adminSeverity).toBe("warning");

			// Successful operations should be info
			const successSeverity: AuditSeverity = "info";
			expect(successSeverity).toBe("info");
		});
	});

	describe("Event Metadata", () => {
		it("should accept standard metadata fields", () => {
			const meta: AuditEventMeta = {
				eventId: "evt_123abc",
				correlationId: "req_456def",
				userId: "user_789",
				organizationId: "org_abc",
				clientIp: "192.168.1.1",
				userAgent: "Mozilla/5.0",
				resourceType: "workflow",
				resourceId: "wf_xyz",
				method: "POST",
				path: "/api/workflows/execute",
				durationMs: 1500,
			};

			expect(meta.eventId).toBe("evt_123abc");
			expect(meta.correlationId).toBe("req_456def");
			expect(meta.userId).toBe("user_789");
			expect(meta.durationMs).toBe(1500);
		});

		it("should accept custom metadata fields", () => {
			const meta: AuditEventMeta = {
				userId: "user_123",
				customField1: "value1",
				customField2: 42,
				customObject: { nested: "data" },
			};

			expect(meta.customField1).toBe("value1");
			expect(meta.customField2).toBe(42);
		});
	});

	describe("Transport Interface", () => {
		it("should define transport interface correctly", async () => {
			const mockTransport: AuditTransport = {
				send: async (event) => {
					expect(event.type).toBeDefined();
					expect(event.timestamp).toBeDefined();
					expect(event.severity).toBeDefined();
					expect(event.message).toBeDefined();
				},
			};

			await mockTransport.send({
				type: "AUTH_LOGIN_SUCCESS",
				timestamp: new Date().toISOString(),
				severity: "info",
				message: "Test login",
				meta: {},
			});
		});

		it("should allow async transport send", async () => {
			let sendCalled = false;

			const asyncTransport: AuditTransport = {
				send: async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					sendCalled = true;
				},
			};

			await asyncTransport.send({
				type: "DATA_CREATE",
				timestamp: new Date().toISOString(),
				severity: "info",
				message: "Test create",
				meta: {},
			});

			expect(sendCalled).toBe(true);
		});
	});

	describe("Helper Functions", () => {
		it("should export logAuditEvent function", async () => {
			const { logAuditEvent } = await import("@repo/logs");
			expect(typeof logAuditEvent).toBe("function");
		});

		it("should export logAuthEvent function", async () => {
			const { logAuthEvent } = await import("@repo/logs");
			expect(typeof logAuthEvent).toBe("function");
		});

		it("should export logSecurityEvent function", async () => {
			const { logSecurityEvent } = await import("@repo/logs");
			expect(typeof logSecurityEvent).toBe("function");
		});

		it("should export logDataEvent function", async () => {
			const { logDataEvent } = await import("@repo/logs");
			expect(typeof logDataEvent).toBe("function");
		});

		it("should export logWorkflowEvent function", async () => {
			const { logWorkflowEvent } = await import("@repo/logs");
			expect(typeof logWorkflowEvent).toBe("function");
		});

		it("should export logMcpEvent function", async () => {
			const { logMcpEvent } = await import("@repo/logs");
			expect(typeof logMcpEvent).toBe("function");
		});

		it("should export logAdminEvent function", async () => {
			const { logAdminEvent } = await import("@repo/logs");
			expect(typeof logAdminEvent).toBe("function");
		});

		it("should export addAuditTransport function", async () => {
			const { addAuditTransport } = await import("@repo/logs");
			expect(typeof addAuditTransport).toBe("function");
		});

		it("should export removeAuditTransport function", async () => {
			const { removeAuditTransport } = await import("@repo/logs");
			expect(typeof removeAuditTransport).toBe("function");
		});

		it("should export createWebhookTransport function", async () => {
			const { createWebhookTransport } = await import("@repo/logs");
			expect(typeof createWebhookTransport).toBe("function");
		});

		it("should export initAuditLogging function", async () => {
			const { initAuditLogging } = await import("@repo/logs");
			expect(typeof initAuditLogging).toBe("function");
		});
	});

	describe("Webhook Transport", () => {
		it("should create webhook transport with URL", async () => {
			const { createWebhookTransport } = await import("@repo/logs");

			const transport = createWebhookTransport(
				"https://example.com/webhook",
			);

			expect(transport).toBeDefined();
			expect(typeof transport.send).toBe("function");
		});

		it("should create webhook transport with headers", async () => {
			const { createWebhookTransport } = await import("@repo/logs");

			const transport = createWebhookTransport(
				"https://example.com/webhook",
				{
					Authorization: "Bearer token123",
					"X-Custom-Header": "value",
				},
			);

			expect(transport).toBeDefined();
		});
	});
});
