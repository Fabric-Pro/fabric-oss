/**
 * Public types for incident notification dispatch.
 *
 * Split out from incident-notifications.ts so consumers can type-check
 * inputs/outputs without pulling in the `db` import (which transitively
 * loads the Prisma client). Mirrors the Zod schema in
 * `packages/api/modules/notifications/lib/payloads.ts` for the
 * INTEGRATION_INCIDENT and SYSTEM_INCIDENT types.
 */

/**
 * Incident source kind. Drives default routing in
 * `createIncidentNotification`:
 *   - `errorRate`   → admin SYSTEM_INCIDENT rows only.
 *   - `integration` → admin + per-org INTEGRATION_INCIDENT rows.
 *
 * Maps to the canonical row in `error_rate_incident` (errorRate) or
 * `integration_incident` (integration).
 */
export type IncidentSource = "errorRate" | "integration";

/**
 * Lowercase severity string. Matches Alertmanager rule labels and the
 * spec's alert rules table (§5). The Prisma enum `IncidentSeverity` uses
 * uppercase (SEV1, SEV2, SEV3) for storage, but the wire format and
 * notification payload use the lowercase form so it round-trips through
 * Alertmanager → webhook → Notification.payload without coercion.
 */
export type IncidentSeverity = "sev1" | "sev2" | "sev3";

/**
 * Routing target. Inferred from severity by default; tests and the
 * recovery (close) path can override.
 *   - `admins`       → Fabric system admins (User.role === "admin").
 *   - `orgs`         → org owners of affected orgs (per ).
 *   - `admins+orgs`  → both.
 *   - `none`         → no in-app rows written (used for severities outside
 *                      the v1 routing matrix).
 */
export type IncidentTarget = "admins" | "orgs" | "admins+orgs" | "none";

/**
 * Notification payload shape persisted into Notification.payload. Mirrors
 * the Zod schema; keep both in lock-step.
 */
export type IncidentNotificationPayload = {
	incidentId: string;
	providerKey?: string;
	severity: IncidentSeverity;
	summary: string;
	link: string;
	startedAt: string; // ISO 8601
};
