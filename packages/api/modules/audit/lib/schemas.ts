/**
 * Shared Zod schemas for the audit-log read API.
 *
 * `audit.list` and `audit.export` accept the same filter shape with a
 * couple of extra fields on each side (cursor/limit on list; format on
 * export). Defining the schemas once here keeps the two procedures in
 * lock-step.
 *
 * Spec: docs/audit-log/README.md §6.
 */

import { z } from "zod";
import { AUDIT_CATEGORIES } from "./taxonomy";

const AUDIT_CATEGORY_VALUES = AUDIT_CATEGORIES as readonly string[];

/**
 * Output schema for a single audit-log row, matching the
 * `AuditLogRow` interface exported from `@repo/database`. The
 * `metadata` field is `z.unknown()` because it can carry arbitrary
 * structure (already redacted at write time, see D15).
 */
export const auditLogItemSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable(),
	userId: z.string().nullable(),
	actorType: z.string(),
	actorEmailSnapshot: z.string().nullable(),
	actorNameSnapshot: z.string().nullable(),
	impersonatedById: z.string().nullable(),
	action: z.string(),
	category: z.string(),
	severity: z.string(),
	outcome: z.string(),
	resourceType: z.string().nullable(),
	resourceId: z.string().nullable(),
	resourceName: z.string().nullable(),
	projectId: z.string().nullable(),
	ipAddress: z.string().nullable(),
	userAgent: z.string().nullable(),
	requestId: z.string().nullable(),
	sessionId: z.string().nullable(),
	metadata: z.unknown().nullable(),
	/** Procedure latency in milliseconds; null when not measured. */
	durationMs: z.number().int().nonnegative().nullable(),
	createdAt: z.coerce.date(),
});

/**
 * Sort directions for `audit.list`. Default is `newest` (i.e.
 * `createdAt DESC, id DESC`). `severity_desc` orders by severity rank
 * (critical > error > warning > info) then by `createdAt DESC` so the
 * highest-impact events bubble to the top.
 */
const AUDIT_SORT_VALUES = ["newest", "oldest", "severity_desc"] as const;

/**
 * Shared filter shape. Every field is optional; an empty filter object
 * means "all rows visible to the current tenant scope".
 */
const auditLogFilterSchema = z
	.object({
		actions: z.array(z.string()).optional(),
		categories: z
			.array(
				z.enum(
					AUDIT_CATEGORY_VALUES as unknown as [string, ...string[]],
				),
			)
			.optional(),
		actorIds: z.array(z.string()).optional(),
		/**
		 * Filter to actor type buckets: `user`, `api_key`, `system`, `agent`.
		 * Surfaced inside the actor popover as a "Custom" sub-section so an
		 * operator can scope to API-key traffic or system writes without
		 * picking individual members.
		 */
		actorTypes: z
			.array(z.enum(["user", "api_key", "system", "agent"]))
			.optional(),
		projectId: z.string().optional(),
		severities: z
			.array(z.enum(["info", "warning", "error", "critical"]))
			.optional(),
		outcomes: z.array(z.enum(["success", "failure"])).optional(),
		dateFrom: z.coerce.date().optional(),
		dateTo: z.coerce.date().optional(),
		/**
		 * D16: exact-match filter on `metadata.correlationId`. Bound to a
		 * sane upper length so a hostile client cannot pass a multi-MB
		 * payload that would slow the WHERE plan.
		 */
		correlationId: z.string().min(1).max(256).optional(),
		/**
		 * Case-insensitive substring match on `ipAddress`. The operator
		 * pattern here is "search for events from a /24 prefix" rather than
		 * exact match. Bound to 256 chars so the WHERE plan stays sane.
		 */
		ipAddressContains: z.string().min(1).max(256).optional(),
	})
	.default({});

export const auditListInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(200).default(50),
	filter: auditLogFilterSchema,
	/**
	 * Sort order for the result set. Defaults to `newest` so the existing
	 * `(createdAt DESC, id DESC)` index continues to back the dominant
	 * query shape. Cursor pagination semantics adapt to whichever direction
	 * the caller picks — the cursor encodes `(createdAt, id)` and the
	 * WHERE comparison flips for `oldest`.
	 */
	sort: z.enum(AUDIT_SORT_VALUES).default("newest"),
});

export const auditListOutputSchema = z.object({
	items: z.array(auditLogItemSchema),
	nextCursor: z.string().nullable(),
	totalCount: z.number().int().nonnegative().optional(),
});

export const auditExportInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	format: z.enum(["csv", "ndjson"]),
	filter: auditLogFilterSchema,
});

export const auditExportOutputSchema = z.object({
	format: z.enum(["csv", "ndjson"]),
	rowCount: z.number().int().nonnegative(),
	body: z.string(),
	filename: z.string(),
	contentType: z.string(),
});

export const auditTaxonomyOutputSchema = z.object({
	actions: z.array(z.string()),
	categories: z.array(z.string()),
	/**
	 * Open-namespace error action keys (D16). Surfaced separately so the
	 * viewer can group them under an "Errors" sub-header in the action chip
	 * without polluting the closed `actions` taxonomy.
	 */
	errorActions: z.array(z.string()),
});

const AUDIT_LATENCY_WINDOWS = ["1h", "6h", "24h", "7d"] as const;
const auditLatencyWindowSchema = z.enum(AUDIT_LATENCY_WINDOWS);

export const auditStatsInputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	/**
	 * v2 item 5: which window the latency aggregation should cover.
	 * Defaults to "24h" so existing callers keep working unchanged.
	 */
	latencyWindow: auditLatencyWindowSchema.optional(),
});

export const auditStatsOutputSchema = z.object({
	eventsToday: z.number().int().nonnegative(),
	failuresToday: z.number().int().nonnegative(),
	uniqueActorsToday: z.number().int().nonnegative(),
	lastEventAt: z.coerce.date().nullable(),
	/**
	 * Most-frequent action key today (within the tenant scope) and its
	 * count. Null when no events have been recorded today.
	 */
	topAction: z
		.object({
			action: z.string(),
			count: z.number().int().nonnegative(),
		})
		.nullable(),
	/**
	 * Hourly event counts for the last 24 hours, oldest first (24 values).
	 * Always populated — empty hours are zero. Used by the viewer's
	 * compact sparkline.
	 */
	hourlyVolume: z.array(z.number().int().nonnegative()).length(24),
	/**
	 * v2 item 5: distinct sessionIds today — the 4th slot in the stats
	 * strip.
	 */
	sessionsToday: z.number().int().nonnegative(),
	/**
	 * v2 item 5: average procedure latency (ms) over `latencyWindow`,
	 * or null when no rows in the window carry a `durationMs` value.
	 */
	averageLatencyMs: z.number().nonnegative().nullable(),
	/**
	 * v2 item 5: bucketed average latency over the window. Bucket count
	 * depends on `latencyWindow`:
	 *   1h → 12, 6h → 12, 24h → 24, 7d → 7.
	 */
	latencySparkline: z.array(z.number().nonnegative()),
	/**
	 * Window the latency stats were computed over (echo of the input).
	 */
	latencyWindow: auditLatencyWindowSchema,
});
