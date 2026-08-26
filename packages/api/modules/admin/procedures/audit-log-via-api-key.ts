/**
 * Admin audit-log-via-API-key proxy procedure.
 *
 * Powers `/app/admin/audit-log-explorer` — lets Fabric staff dogfood the
 * public `/api/v1/audit-log` REST endpoint without configuring cross-origin
 * CORS or persisting the customer's key in the browser.
 *
 * Why a server-side proxy (and not a direct cross-origin fetch from the
 * staff browser):
 *   - Admins should be able to read prod customer audit logs from the
 *     staging Fabric UI without us opening CORS on the prod REST endpoint
 *     to staff origins (that would be a customer-facing change for a
 *     staff-only feature).
 *   - The API key value never lives in localStorage — it sits in the
 *     React component state for the session and is forwarded once per
 *     query to this procedure, then released when the page unmounts.
 *
 * The proxy ALSO emits an audit-log row of its own (`admin.auditLog.viaApiKey`)
 * every time a staff member runs a query, with:
 *   - the actor (the signed-in admin)
 *   - the targeted tenant (org id OR personal user id)
 *   - the first 12 chars of the key for forensic identification
 *   - the row count returned + the filter set used
 *
 * That trail lives in the Fabric internal audit log (NOT the customer's
 * log), so we have a record of staff-initiated cross-tenant reads.
 */

import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import {
	type AuditOutcome,
	type AuditSeverityLevel,
	aggregateAuditLogStats,
	listAuditLog,
	verifyOrganizationApiKey,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";
import { verifyUserApiKey } from "../../users/procedures/api-keys/verify";

/** Length of the API-key prefix retained for audit forensic logging. */
const KEY_PREFIX_KEEP = 12;

/**
 * Input shape — mirrors the public REST endpoint at GET /api/v1/audit-log.
 * Kept in lock-step so the explorer UI behaves identically to a direct
 * REST call from a customer.
 */
const inputSchema = z.object({
	apiKey: z
		.string()
		.min(8, "API key is required")
		.max(2000, "API key looks too long"),
	limit: z.number().int().min(1).max(200).default(50),
	cursor: z.string().nullable().optional(),
	sort: z.enum(["newest", "oldest"]).default("newest"),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	action: z.string().optional(),
	category: z.string().optional(),
	severity: z.enum(["info", "warning", "error", "critical"]).optional(),
	outcome: z.enum(["success", "failure"]).optional(),
	correlationId: z.string().optional(),
	ipAddress: z.string().optional(),
});

const outputSchema = z.object({
	tenant: z.object({
		kind: z.enum(["organization", "personal"]),
		organizationId: z.string().nullable(),
		userId: z.string().nullable(),
		keyType: z.enum(["organization", "personal"]),
		keyPrefix: z.string(),
	}),
	items: z.array(z.unknown()),
	nextCursor: z.string().nullable(),
	total: z.number(),
});

type ResolvedTenant = {
	kind: "organization" | "personal";
	keyType: "organization" | "personal";
	keyPrefix: string;
	organizationId: string | null;
	userId: string | null;
};

function buildKeyPrefix(rawKey: string): string {
	// Preserve `org_xxxxxxxx` or `fab_xxxxxxxx` shape — first 12 chars is
	// enough for forensic identification without exposing the secret.
	return rawKey.slice(0, KEY_PREFIX_KEEP);
}

async function resolveTenant(rawKey: string): Promise<ResolvedTenant> {
	if (rawKey.startsWith("org_")) {
		const keyHash = createHash("sha256").update(rawKey).digest("hex");
		const result = await verifyOrganizationApiKey(keyHash);
		if (!result) {
			throw new ORPCError("UNAUTHORIZED", {
				message: "Invalid or expired organization API key.",
			});
		}
		return {
			kind: "organization",
			keyType: "organization",
			keyPrefix: buildKeyPrefix(rawKey),
			organizationId: result.organizationId,
			userId: null,
		};
	}

	if (rawKey.startsWith("fab_")) {
		const result = await verifyUserApiKey(rawKey);
		if (!result.valid || !result.userId) {
			throw new ORPCError("UNAUTHORIZED", {
				message: result.error ?? "Invalid personal API key.",
			});
		}
		return {
			kind: "personal",
			keyType: "personal",
			keyPrefix: buildKeyPrefix(rawKey),
			organizationId: null,
			userId: result.userId,
		};
	}

	throw new ORPCError("BAD_REQUEST", {
		message: "API key must start with org_ or fab_.",
	});
}

export const adminAuditLogViaApiKeyProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_AUDIT_LOG_READ))
	.route({
		method: "POST",
		path: "/admin/audit-log/via-api-key",
		tags: ["Administration", "Audit Log"],
		summary:
			"Query a customer's audit log via their API key (staff-only proxy)",
	})
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const tenant = await resolveTenant(input.apiKey);

		const fromDate = input.from ? new Date(input.from) : undefined;
		const toDate = input.to ? new Date(input.to) : undefined;

		const result = await listAuditLog({
			scope: {
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
			filter: {
				actions: input.action ? [input.action] : undefined,
				categories: input.category ? [input.category] : undefined,
				severities: input.severity
					? [input.severity as AuditSeverityLevel]
					: undefined,
				outcomes: input.outcome
					? [input.outcome as AuditOutcome]
					: undefined,
				dateFrom: fromDate,
				dateTo: toDate,
				correlationId: input.correlationId,
				ipAddressContains: input.ipAddress,
			},
			cursor: input.cursor ?? null,
			limit: input.limit,
			sort: input.sort,
		});

		// Best-effort audit emit of this staff-initiated cross-tenant read.
		// Fire-and-forget — never blocks the query response. Uses
		// recordAuditFromRequest so the acting staff member's IP / UA /
		// correlation id come through (previously these rows always
		// landed with null IP, which hurt forensic lookups).
		recordAuditFromRequest(context, {
			organizationId: null,
			action: "admin.auditLog.viaApiKey",
			category: "admin",
			severity: "info",
			outcome: "success",
			resource: {
				type: "AuditLog",
				id: tenant.organizationId ?? tenant.userId ?? null,
			},
			metadata: {
				keyPrefix: tenant.keyPrefix,
				keyType: tenant.keyType,
				targetTenant: {
					kind: tenant.kind,
					organizationId: tenant.organizationId,
					userId: tenant.userId,
				},
				filters: {
					from: input.from ?? null,
					to: input.to ?? null,
					action: input.action ?? null,
					category: input.category ?? null,
					severity: input.severity ?? null,
					outcome: input.outcome ?? null,
					correlationId: input.correlationId ?? null,
					ipAddress: input.ipAddress ?? null,
				},
				rowsReturned: result.items.length,
				total: result.totalCount ?? null,
			},
		});

		return {
			tenant: {
				kind: tenant.kind,
				organizationId: tenant.organizationId,
				userId: tenant.userId,
				keyType: tenant.keyType,
				keyPrefix: tenant.keyPrefix,
			},
			items: result.items.map((r) => ({
				id: r.id,
				organizationId: r.organizationId,
				userId: r.userId,
				actorType: r.actorType,
				actor: {
					email: r.actorEmailSnapshot,
					name: r.actorNameSnapshot,
				},
				impersonatedById: r.impersonatedById,
				action: r.action,
				category: r.category,
				severity: r.severity,
				outcome: r.outcome,
				resource:
					r.resourceType || r.resourceId
						? {
								type: r.resourceType,
								id: r.resourceId,
								name: r.resourceName,
							}
						: null,
				projectId: r.projectId,
				ipAddress: r.ipAddress,
				userAgent: r.userAgent,
				correlationId:
					(r.metadata as Record<string, unknown> | null)
						?.correlationId ?? r.requestId,
				sessionId: r.sessionId,
				metadata: r.metadata,
				durationMs: r.durationMs,
				createdAt: r.createdAt.toISOString(),
			})),
			nextCursor: result.nextCursor,
			total: result.totalCount ?? result.items.length,
		};
	});

/**
 * Stats proxy — mirrors `audit.stats` for the explorer. Resolves the
 * customer tenant from the API key the same way `viaApiKey` does, then
 * runs `aggregateAuditLogStats` against that tenant. The explorer
 * mounts the same `<AuditLogStatsStrip>` component as the in-product
 * viewer; this procedure is its data source.
 *
 * Latency window is fixed to 24h on the consumer side (the stats strip
 * no longer offers a dropdown). We still accept the same input shape
 * as `audit.stats` for forward compatibility.
 */
const statsInputSchema = z.object({
	apiKey: z
		.string()
		.min(8, "API key is required")
		.max(2000, "API key looks too long"),
	latencyWindow: z.enum(["1h", "6h", "24h", "7d"]).default("24h"),
});

export const adminAuditLogStatsViaApiKeyProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_AUDIT_LOG_READ))
	.route({
		method: "POST",
		path: "/admin/audit-log/stats-via-api-key",
		tags: ["Administration", "Audit Log"],
		summary:
			"Query a customer's audit-log stats via their API key (staff-only proxy)",
	})
	.input(statsInputSchema)
	.handler(async ({ input, context }) => {
		const tenant = await resolveTenant(input.apiKey);

		const stats = await aggregateAuditLogStats({
			scope: {
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
			latencyWindow: input.latencyWindow,
		});

		// Best-effort audit emit of the staff-initiated stats read.
		recordAuditFromRequest(context, {
			organizationId: null,
			action: "admin.auditLog.viaApiKey",
			category: "admin",
			severity: "info",
			outcome: "success",
			resource: {
				type: "AuditLogStats",
				id: tenant.organizationId ?? tenant.userId ?? null,
			},
			metadata: {
				keyPrefix: tenant.keyPrefix,
				keyType: tenant.keyType,
				targetTenant: {
					kind: tenant.kind,
					organizationId: tenant.organizationId,
					userId: tenant.userId,
				},
				latencyWindow: input.latencyWindow,
				surface: "stats",
			},
		});

		return stats;
	});
