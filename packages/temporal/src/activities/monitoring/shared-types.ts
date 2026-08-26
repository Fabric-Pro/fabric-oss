/**
 * Shared types for monitoring activities.
 *
 * Mirrors the Prisma enums on the workflow/activity wire — Temporal
 * serializes inputs/outputs as JSON, so string-literal types keep the
 * boundary explicit and avoid pulling the Prisma runtime client into
 * the workflow bundle.
 *
 * Keep these in lock-step with `packages/database/prisma/schema.prisma`
 * (enums at the bottom of the file).
 */

/**
 * Mirror of Prisma `IncidentSeverity` enum.
 * Uppercase per schema — distinct from the lowercase `"sev1" | "sev2" |
 * "sev3"` form used on the notification-payload wire.
 */
export type IncidentSeverity = "SEV1" | "SEV2" | "SEV3";

/**
 * Mirror of Prisma `IncidentStatus` enum.
 */
export type IncidentStatus = "FIRING" | "ACKNOWLEDGED" | "RESOLVED";

/**
 * Mirror of Prisma `ProviderHealthStatus` enum.
 *
 * `NOT_CONFIGURED` is set when the synthetic probe is registered but
 * cannot run because the required environment variables are missing
 * in this environment (e.g., `STRIPE_SECRET_KEY` unset on staging).
 * The provider itself is not necessarily down — it's just not probed
 * from here. The admin UI renders this as a neutral gray badge, NOT
 * an outage, and the active-incidents banner ignores it.
 */
export type ProviderHealthStatus =
	| "OPERATIONAL"
	| "DEGRADED"
	| "PARTIAL_OUTAGE"
	| "MAJOR_OUTAGE"
	| "MAINTENANCE"
	| "UNKNOWN"
	| "NOT_CONFIGURED";

/**
 * Mirror of Prisma `IncidentEventType` enum.
 */
export type IncidentEventType =
	| "FIRED"
	| "RE_FIRED"
	| "ACKNOWLEDGED"
	| "COMMENT"
	| "AUTO_RESOLVED"
	| "MANUAL_RESOLVED";

/**
 * Mirror of Prisma `IncidentDetectionMethod` enum.
 */
export type IncidentDetectionMethod =
	| "STATUSPAGE_POLL"
	| "SYNTHETIC_PROBE"
	| "BREAKER_OPEN"
	| "ALERT_MANAGER"
	| "WEBHOOK";

/**
 * Incident "kind" discriminator used by the lifecycle workflow + activity.
 * Matches the `IncidentSource` shape in `incident-notifications-types.ts`
 * (modulo casing). The lifecycle workflow keeps its own copy because
 * @repo/database can't be imported into workflow code.
 */
export type IncidentKind = "error_rate" | "integration";

/**
 * MVP-5 synthetic-probe provider keys. Used as the unique key on the
 * Temporal Schedule (`synthetic-probe-${providerKey}`) and as the
 * Prometheus `provider` label.
 */
export type SyntheticProbeProviderKey =
	| "openai"
	| "anthropic"
	| "stripe"
	| "resend"
	| "aws_s3";
