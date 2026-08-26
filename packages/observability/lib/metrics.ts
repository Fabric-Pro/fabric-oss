import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * Prometheus Metrics for MCP Operations
 * Exposed at /api/metrics endpoint
 */

// Create a custom registry
export const register = new Registry();

// Set default labels for all metrics
register.setDefaultLabels({
	app: "fabric-mcp",
	environment: process.env.NODE_ENV || "development",
});

/**
 * OAuth Connection Metrics
 */
export const mcpOAuthConnectionsTotal = new Counter({
	name: "mcp_oauth_connections_total",
	help: "Total number of OAuth connections attempted",
	labelNames: ["status", "server_key", "auth_type"],
	registers: [register],
});

export const mcpOAuthConnectionDuration = new Histogram({
	name: "mcp_oauth_connection_duration_seconds",
	help: "Duration of OAuth connection flow from start to callback",
	labelNames: ["status", "server_key"],
	buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
	registers: [register],
});

/**
 * Token Refresh Metrics
 */
export const mcpTokenRefreshTotal = new Counter({
	name: "mcp_token_refresh_total",
	help: "Total number of token refresh operations",
	labelNames: ["status", "server_key"],
	registers: [register],
});

export const mcpTokenRefreshDuration = new Histogram({
	name: "mcp_token_refresh_duration_seconds",
	help: "Duration of token refresh operations",
	labelNames: ["status", "server_key"],
	buckets: [0.1, 0.3, 0.5, 1, 2, 5],
	registers: [register],
});

/**
 * Test Connection Metrics
 */
export const mcpTestConnectionTotal = new Counter({
	name: "mcp_test_connection_total",
	help: "Total number of test connection requests",
	labelNames: ["status", "server_key", "transport"],
	registers: [register],
});

export const mcpTestConnectionDuration = new Histogram({
	name: "mcp_test_connection_duration_seconds",
	help: "Duration of test connection requests",
	labelNames: ["status", "server_key", "transport"],
	buckets: [0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
	registers: [register],
});

/**
 * Configuration Metrics
 */
export const mcpActiveConfigurations = new Gauge({
	name: "mcp_active_configurations",
	help: "Number of active MCP configurations",
	labelNames: ["auth_type", "status", "scope"],
	registers: [register],
});

export const mcpConfigOperationsTotal = new Counter({
	name: "mcp_config_operations_total",
	help: "Total number of configuration operations",
	labelNames: ["operation", "auth_type"],
	registers: [register],
});

/**
 * DCR (Dynamic Client Registration) Metrics
 */
export const mcpDCRRegistrationsTotal = new Counter({
	name: "mcp_dcr_registrations_total",
	help: "Total number of DCR registration attempts",
	labelNames: ["status", "server_key"],
	registers: [register],
});

export const mcpDCRRegistrationDuration = new Histogram({
	name: "mcp_dcr_registration_duration_seconds",
	help: "Duration of DCR registration operations",
	labelNames: ["status", "server_key"],
	buckets: [0.1, 0.5, 1, 2, 5],
	registers: [register],
});

/**
 * Health Check Metrics
 */
export const mcpHealthCheckTotal = new Counter({
	name: "mcp_health_check_total",
	help: "Total number of health checks performed",
	labelNames: ["status", "config_id"],
	registers: [register],
});

export const mcpConsecutiveFailures = new Gauge({
	name: "mcp_consecutive_failures",
	help: "Number of consecutive failures for each configuration",
	labelNames: ["config_id", "server_key"],
	registers: [register],
});

/**
 * Error Metrics
 */
export const mcpErrorsTotal = new Counter({
	name: "mcp_errors_total",
	help: "Total number of errors by type",
	labelNames: ["error_type", "operation"],
	registers: [register],
});

/**
 * PM Ticket Listing Metrics (F-1035)
 *
 * Emitted by `listPMTicketsProcedure`. Cardinality is bounded by
 * {tool, batch_get, kind} — `tool` is one of the small, closed set of
 * detected PM types, `batch_get` is one of:
 *   - "true"  — ADO batch-get fast path (single MCP call resolves all IDs)
 *   - "loop"  — non-ADO per-ID fast path (parallel single-item gets)
 *   - "false" — full-board fetch loop or server-side search
 * `kind` covers the per-ID resolution errors only.
 */
export const pmTicketsListRequestsTotal = new Counter({
	name: "pm_tickets_list_requests_total",
	help: "Total number of PM ticket list requests handled by listPMTicketsProcedure",
	labelNames: ["tool", "batch_get"],
	registers: [register],
});

export const pmTicketsListDurationSeconds = new Histogram({
	name: "pm_tickets_list_duration_seconds",
	help: "Duration of PM ticket list handler execution",
	labelNames: ["tool", "batch_get"],
	buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
	registers: [register],
});

export const pmTicketsListErrorsTotal = new Counter({
	name: "pm_tickets_list_errors_total",
	help: "Per-ID resolution errors emitted by listPMTicketsProcedure (not_found, wrong_board)",
	labelNames: ["tool", "kind"],
	registers: [register],
});

/**
 * AI Limit Signal Metrics (Fizzy #962)
 *
 * Emitted every time the orchestrator / streaming chats classify an error
 * as a provider/budget limit event. Cardinality is bounded by the closed
 * `kind` enum and the small set of provider slugs.
 */
export const aiLimitSignalTotal = new Counter({
	name: "ai_limit_signal_total",
	help: "Total number of AI token-budget / provider-limit signals surfaced to the user",
	labelNames: ["kind", "provider"],
	registers: [register],
});

/**
 * Audit log write metrics.
 *
 * Cardinality is bounded by the closed audit-action taxonomy (28 actions ×
 * 5 categories × 2 outcomes = 280 series max), which is well under
 * Prometheus's cardinality budget. The two counters together let
 * operators compute a write success rate
 * (`1 - failures_total / writes_total`) on a dashboard panel.
 */
export const auditWriteFailures = new Counter({
	name: "fabric_audit_write_failures_total",
	help: "Audit log inserts that failed and fell back to stdout/webhook",
	labelNames: ["action", "category"] as const,
	registers: [register],
});

export const auditWritesTotal = new Counter({
	name: "fabric_audit_writes_total",
	help: "Audit log inserts attempted (successful committed writes)",
	labelNames: ["action", "category", "outcome"] as const,
	registers: [register],
});

/**
 * Rejected public-API requests that could not be attributed to a tenant.
 *
 * These are the attempts whose presented secret never matched a stored hash —
 * an unknown key prefix, or a known prefix with the wrong secret. They ARE
 * written to the audit log, but tenant-less by necessity (attributing on an
 * unverified prefix would let prefix-guessing write into a stranger's trail), so
 * no tenant-scoped viewer or API can surface them. This counter is therefore the
 * only alertable signal for credential probing against the public surface.
 *
 * Label cardinality is bounded by the mapped error codes
 * (`INVALID_API_KEY`, `MISSING_AUTHORIZATION`, `INVALID_API_KEY_FORMAT`).
 */
export const apiKeyRestUnattributableRejections = new Counter({
	name: "fabric_api_key_rest_unattributable_rejections_total",
	help: "Public-API key rejections with no proven owner (probing signal)",
	labelNames: ["error_code"] as const,
	registers: [register],
});

/**
 * Cleanup Job Metrics
 */
export const mcpCleanupTotal = new Counter({
	name: "mcp_cleanup_total",
	help: "Total number of cleanup operations",
	labelNames: ["resource_type"],
	registers: [register],
});

export const mcpCleanupRecordsDeleted = new Counter({
	name: "mcp_cleanup_records_deleted",
	help: "Total number of records deleted during cleanup",
	labelNames: ["resource_type"],
	registers: [register],
});

/**
 * Excalidraw chat -> editor auto-insert metrics.
 *
 * Fired from `createFromChatProcedure` (packages/api/modules/projects/
 * procedures/diagrams/create-from-chat.ts) on every successful Diagram
 * row creation triggered by the chat-message "Insert into <Doc>" button.
 *
 * The single `surface` label is bounded to the four `ChatSurface`
 * enum values declared in
 * `apps/web/modules/saas/projects/components/excalidraw-auto-insert/types.ts`.
 * We mirror the literal union locally (`DiagramAutoInsertSurface`) so this
 * package stays free of any reverse dependency on `apps/web`; the helper
 * `incrementDiagramAutoInsertedCounter` enforces the union at the call
 * site, and prom-client itself silently accepts any string label value
 * so the runtime guard is the typed wrapper. Cardinality: 4 series max.
 *
 * Naming follows the OpenMetrics `_total` suffix convention for counters.
 */
export type DiagramAutoInsertSurface =
	| "nexus"
	| "loom"
	| "in-feature"
	| "in-document";

export const diagramAutoInsertedTotal = new Counter({
	name: "diagram_auto_inserted_total",
	help: "Total Diagram rows created from chat-message Insert button, by chat surface.",
	labelNames: ["surface"] as const,
	registers: [register],
});

/**
 * Increment the `diagram_auto_inserted_total{surface}` counter.
 *
 * Restricted to the four `ChatSurface` enum values via the
 * {@link DiagramAutoInsertSurface} union so the label cardinality stays
 * bounded at 4 series. Callers that derive `surface` from oRPC input
 * already get this guarantee from the Zod enum on
 * `createFromChatProcedure`; this wrapper carries the same constraint
 * into the metrics layer.
 *
 * The function is synchronous and side-effect-only — it never throws.
 * prom-client's `Counter.inc` is constant-time.
 */
export function incrementDiagramAutoInsertedCounter(params: {
	surface: DiagramAutoInsertSurface;
}): void {
	diagramAutoInsertedTotal.inc({ surface: params.surface });
}

/**
 * Utility functions for tracking metrics
 */
export const metricsTracker = {
	/**
	 * Track OAuth connection attempt
	 */
	trackOAuthConnection: (
		status: "success" | "failure",
		serverKey: string,
		authType: string,
		durationSeconds?: number,
	) => {
		mcpOAuthConnectionsTotal.inc({
			status,
			server_key: serverKey,
			auth_type: authType,
		});

		if (durationSeconds !== undefined) {
			mcpOAuthConnectionDuration.observe(
				{ status, server_key: serverKey },
				durationSeconds,
			);
		}
	},

	/**
	 * Track token refresh operation
	 */
	trackTokenRefresh: (
		status: "success" | "failure",
		serverKey: string,
		durationSeconds?: number,
	) => {
		mcpTokenRefreshTotal.inc({ status, server_key: serverKey });

		if (durationSeconds !== undefined) {
			mcpTokenRefreshDuration.observe(
				{ status, server_key: serverKey },
				durationSeconds,
			);
		}
	},

	/**
	 * Track test connection
	 */
	trackTestConnection: (
		status: "success" | "failure",
		serverKey: string,
		transport: string,
		durationSeconds: number,
	) => {
		mcpTestConnectionTotal.inc({
			status,
			server_key: serverKey,
			transport,
		});
		mcpTestConnectionDuration.observe(
			{ status, server_key: serverKey, transport },
			durationSeconds,
		);
	},

	/**
	 * Update active configurations gauge
	 */
	updateActiveConfigurations: (
		authType: string,
		status: string,
		scope: "user" | "organization",
		count: number,
	) => {
		mcpActiveConfigurations.set(
			{ auth_type: authType, status, scope },
			count,
		);
	},

	/**
	 * Track configuration operation
	 */
	trackConfigOperation: (
		operation: "create" | "update" | "delete",
		authType: string,
	) => {
		mcpConfigOperationsTotal.inc({ operation, auth_type: authType });
	},

	/**
	 * Track DCR registration
	 */
	trackDCRRegistration: (
		status: "success" | "failure",
		serverKey: string,
		durationSeconds?: number,
	) => {
		mcpDCRRegistrationsTotal.inc({ status, server_key: serverKey });

		if (durationSeconds !== undefined) {
			mcpDCRRegistrationDuration.observe(
				{ status, server_key: serverKey },
				durationSeconds,
			);
		}
	},

	/**
	 * Track health check
	 */
	trackHealthCheck: (status: "success" | "failure", configId: string) => {
		mcpHealthCheckTotal.inc({ status, config_id: configId });
	},

	/**
	 * Update consecutive failures
	 */
	updateConsecutiveFailures: (
		configId: string,
		serverKey: string,
		failures: number,
	) => {
		mcpConsecutiveFailures.set(
			{ config_id: configId, server_key: serverKey },
			failures,
		);
	},

	/**
	 * Track error
	 */
	trackError: (errorType: string, operation: string) => {
		mcpErrorsTotal.inc({ error_type: errorType, operation });
	},

	/**
	 * Track AI limit signal (Fizzy #962)
	 */
	trackAiLimitSignal: (kind: string, provider?: string) => {
		aiLimitSignalTotal.inc({ kind, provider: provider ?? "unknown" });
	},

	/**
	 * Track cleanup operation
	 */
	trackCleanup: (
		resourceType: "oauth_states" | "client_sessions",
		deletedCount: number,
	) => {
		mcpCleanupTotal.inc({ resource_type: resourceType });
		mcpCleanupRecordsDeleted.inc(
			{ resource_type: resourceType },
			deletedCount,
		);
	},
};
