/**
 * Public audit-log REST API routes.
 *
 *   - `GET /api/v1/audit-log`        — paginated list (`audit_log:read`).
 *   - `GET /api/v1/audit-log/export` — CSV / NDJSON export (`audit_log:export`).
 *
 * Auth: `Authorization: Bearer fab_*` (personal) or `Bearer org_*` (org).
 *  The key's owning tenant is the ONLY tenant whose audit rows are
 *  returned — cross-tenant access is impossible because the scope is
 *  derived from the key, not from a query parameter.
 *
 * No CORS — these endpoints are server-to-server only. CORS would
 * allow a browser on any origin to fish for audit data using a stolen
 * key.
 *
 * Behavioural notes:
 *  - Same filter, cursor pagination, and 50k export cap as the oRPC
 *    procedures (the queries are shared: `listAuditLog` /
 *    `fetchAuditLogForExport` / `countAuditLog`).
 *  - Rate limit: 600 requests/min per API key (`auditExternal` preset).
 *  - Every authenticated request emits one `audit.api_request` row
 *    (D12-like — once per request, not once per row) so operators have
 *    a who-read-what trail for external integrations. Sampled at 100%
 *    in v1; can throttle in metadata if volume grows.
 *  - The export endpoint streams a single response body (no async job
 *    queue in v1), capped at 50k rows.
 *
 * Spec: public audit-log REST API instructions.
 */

import {
	AUDIT_EXPORT_ROW_CAP,
	countAuditLog,
	fetchAuditLogForExport,
	listAuditLog,
} from "@repo/database";
import { logger } from "@repo/logs";
import { Hono } from "hono";
import {
	type ApiKeyRestVariables,
	apiKeyRestAuth,
	insufficientScope,
} from "../../../lib/api-key-rest-auth";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	exportContentType,
	exportFilename,
	serializeAuditLogToCsv,
	serializeAuditLogToNdjson,
} from "../lib/export-format";
import {
	AUDIT_LOG_SCOPES,
	hasAuditLogScope,
	type VerifiedAuditApiKey,
} from "./verify-audit-key";

// ---------------------------------------------------------------------------
// Hono context shape for these routes
// ---------------------------------------------------------------------------

type AuditApiVariables = ApiKeyRestVariables;

// ---------------------------------------------------------------------------
// Query-param parsing
// ---------------------------------------------------------------------------

/**
 * Comma-separated query param -> string[].
 * Drops empty entries so `?actions=` doesn't produce `[""]`.
 */
function readArrayParam(value: string | undefined): string[] | undefined {
	if (!value) {
		return undefined;
	}
	const parts = value
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return parts.length > 0 ? parts : undefined;
}

function readDateParam(value: string | undefined): Date | undefined {
	if (!value) {
		return undefined;
	}
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

function readPositiveIntParam(
	value: string | undefined,
	min: number,
	max: number,
	fallback: number,
): number {
	if (value === undefined) {
		return fallback;
	}
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	if (n < min) {
		return min;
	}
	if (n > max) {
		return max;
	}
	return n;
}

function readEnumArrayParam<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
): T[] | undefined {
	const arr = readArrayParam(value);
	if (!arr) {
		return undefined;
	}
	const allowedSet = new Set<string>(allowed as readonly string[]);
	const filtered = arr.filter((entry) => allowedSet.has(entry)) as T[];
	return filtered.length > 0 ? filtered : undefined;
}

interface ParsedFilter {
	actions?: string[];
	categories?: string[];
	actorIds?: string[];
	actorTypes?: ("user" | "api_key" | "system" | "agent")[];
	projectId?: string;
	severities?: ("info" | "warning" | "error" | "critical")[];
	outcomes?: ("success" | "failure")[];
	dateFrom?: Date;
	dateTo?: Date;
	correlationId?: string;
	ipAddressContains?: string;
}

function parseFilter(qs: Record<string, string | undefined>): ParsedFilter {
	const filter: ParsedFilter = {};
	const actions = readArrayParam(qs.actions);
	if (actions) {
		filter.actions = actions;
	}
	const categories = readArrayParam(qs.categories);
	if (categories) {
		filter.categories = categories;
	}
	const actorIds = readArrayParam(qs.actorIds);
	if (actorIds) {
		filter.actorIds = actorIds;
	}
	const actorTypes = readEnumArrayParam(qs.actorTypes, [
		"user",
		"api_key",
		"system",
		"agent",
	] as const);
	if (actorTypes) {
		filter.actorTypes = actorTypes;
	}
	if (qs.projectId) {
		filter.projectId = qs.projectId;
	}
	const severities = readEnumArrayParam(qs.severities, [
		"info",
		"warning",
		"error",
		"critical",
	] as const);
	if (severities) {
		filter.severities = severities;
	}
	const outcomes = readEnumArrayParam(qs.outcomes, [
		"success",
		"failure",
	] as const);
	if (outcomes) {
		filter.outcomes = outcomes;
	}
	const dateFrom = readDateParam(qs.dateFrom);
	if (dateFrom) {
		filter.dateFrom = dateFrom;
	}
	const dateTo = readDateParam(qs.dateTo);
	if (dateTo) {
		filter.dateTo = dateTo;
	}
	if (qs.correlationId && qs.correlationId.length <= 256) {
		filter.correlationId = qs.correlationId;
	}
	if (qs.ipAddressContains && qs.ipAddressContains.length <= 256) {
		filter.ipAddressContains = qs.ipAddressContains;
	}
	return filter;
}

// ---------------------------------------------------------------------------
// Helpers — scope + audit emit
// ---------------------------------------------------------------------------

/**
 * Build the audit-log XOR scope from a verified API key.
 *
 *   - User keys -> personal scope (`organizationId: null`,
 *     `userId: <key.owner.userId>`). The key sees ONLY personal-context
 *     rows for the user who owns the key. They never get to read another
 *     user's personal trail.
 *   - Org keys -> org scope (`organizationId: <key.owner.organizationId>`,
 *     `userId: null`). The key sees the full org-wide trail (admins'
 *     view), exactly the way the in-product viewer does.
 */
function scopeFromKey(key: VerifiedAuditApiKey) {
	if (key.owner.type === "user") {
		return { organizationId: null, userId: key.owner.userId };
	}
	return {
		organizationId: key.owner.organizationId,
		userId: null,
	};
}

/**
 * Construct the synthetic AuditRequestContext we hand to
 * `recordAuditFromRequest` so the per-request audit row carries the API
 * key's owning user as the actor (with snapshot fields), not a fake
 * "anonymous" placeholder.
 *
 * The actor's email is snapshot from the User row at write time so a
 * later rename of the key creator doesn't rewrite history (D11). We
 * fetch it lazily inside the audit metadata payload via the API key
 * record's `createdBy` relation — but to keep the path zero-await,
 * we leave the snapshot fields null and let `audit.viewed`/etc. carry
 * the actor identity via the action handler's resolveActor. For
 * `audit.api_request`, the actor type is `api_key` because the request
 * was made by a credential, not by a logged-in user.
 */
function buildAuditContext(
	headers: Headers,
	key: VerifiedAuditApiKey,
): {
	headers: Headers;
	user: { id: string; email: string; name: string | null };
} {
	return {
		headers,
		user: {
			// The audit row's `user` FK points at the key owner so the
			// in-product viewer can show who-the-key-belongs-to. Snapshot
			// fields stay null (we don't fetch the User row here; the
			// underlying recordAudit helper will accept nulls).
			id: key.owner.userId,
			email: "",
			name: null,
		},
	};
}

/**
 * Fire-and-forget bump of `lastUsedAt` and `usageCount` for the API
 * key. Called from each REST request AFTER the response is built.
 * Failures are swallowed — they must never break the read.
 */
async function bumpUsage(key: VerifiedAuditApiKey): Promise<void> {
	try {
		const { db } = await import("@repo/database");
		if (key.owner.type === "user") {
			await db.userApiKey.update({
				where: { id: key.keyId },
				data: {
					lastUsedAt: new Date(),
					usageCount: { increment: 1 },
				},
			});
		} else {
			await db.organizationApiKey.update({
				where: { id: key.keyId },
				data: {
					lastUsedAt: new Date(),
					usageCount: { increment: 1 },
				},
			});
		}
	} catch (err) {
		logger.warn(
			{
				event: "audit.api_request.bump_usage_failed",
				keyId: key.keyId,
				keyPrefix: key.keyPrefix,
				error: err instanceof Error ? err.message : String(err),
			},
			"Failed to update API key usage stats",
		);
	}
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Build the Hono sub-app for the public audit-log REST endpoints.
 *
 * Mount this at `/api/v1` in the top-level app:
 *
 *   ```ts
 *   .route("/v1", createAuditLogRestRoutes())
 *   ```
 *
 * The exported app does NOT install any CORS middleware — these
 * endpoints are server-to-server only and must not be reachable from a
 * browser on a hostile origin with a stolen key.
 */
export function createAuditLogRestRoutes() {
	const app = new Hono<{ Variables: AuditApiVariables }>();

	// Auth + per-key rate limiting live in the shared `apiKeyRestAuth`
	// middleware, which every public read-only observability surface mounts. It
	// also audits REJECTED attempts (bad key, revoked key, insufficient scope,
	// rate-limited) — previously only successful reads left a row, so a key being
	// probed or replayed after revocation was invisible.
	app.use("*", apiKeyRestAuth());

	// =========================================================================
	// GET /audit-log — paginated list
	// =========================================================================
	app.get("/audit-log", async (c) => {
		const key = c.get("verifiedKey");

		// Scope check
		if (!hasAuditLogScope(key.scopes, AUDIT_LOG_SCOPES.READ)) {
			return insufficientScope(c, AUDIT_LOG_SCOPES.READ);
		}

		const qs = c.req.query();
		const filter = parseFilter(qs);

		if (
			filter.dateFrom &&
			filter.dateTo &&
			filter.dateFrom > filter.dateTo
		) {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message:
							"dateFrom must be less than or equal to dateTo",
					},
				},
				400,
			);
		}

		const limit = readPositiveIntParam(qs.limit, 1, 200, 50);
		const cursor =
			typeof qs.cursor === "string" && qs.cursor.length > 0
				? qs.cursor
				: null;
		const sort =
			qs.sort === "oldest" || qs.sort === "severity_desc"
				? qs.sort
				: "newest";

		const scope = scopeFromKey(key);

		let result: Awaited<ReturnType<typeof listAuditLog>>;
		try {
			result = await listAuditLog({
				scope,
				filter,
				cursor,
				limit,
				sort,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message === "Invalid cursor") {
				return c.json(
					{
						error: {
							code: "BAD_REQUEST",
							message: "Invalid cursor",
						},
					},
					400,
				);
			}
			throw err;
		}

		// Per-request audit emit. Once per call (D12-shape).
		// The actor's `nameSnapshot` is the human-friendly key name so the
		// viewer can show "SRE laptop" instead of the opaque prefix.
		const ctx = buildAuditContext(c.req.raw.headers, key);
		recordAuditFromRequest(ctx, {
			action: "audit.api_request",
			category: "audit",
			organizationId:
				key.owner.type === "org" ? key.owner.organizationId : null,
			outcome: "success",
			severity: "info",
			actor: {
				type: "api_key",
				nameSnapshot: key.keyName,
			},
			metadata: {
				endpoint: "/api/v1/audit-log",
				method: "GET",
				responseStatus: 200,
				// Field names intentionally avoid `apiKey*` — the audit-log
				// metadata redactor substring-matches `apikey` and would
				// strip values the operator legitimately needs to identify
				// which key issued the call. The prefix is non-secret by
				// design (12 chars, can't authenticate) and the keyId is a
				// CUID (already public via the management UI).
				keyPrefix: key.keyPrefix,
				keyId: key.keyId,
				keyName: key.keyName,
				resultCount: result.items.length,
				hasNextCursor: result.nextCursor !== null,
			},
		});

		// Fire-and-forget usage bump after response shape is known.
		void bumpUsage(key);

		return c.json({
			items: result.items,
			nextCursor: result.nextCursor,
			...(typeof result.totalCount === "number"
				? { totalCount: result.totalCount }
				: {}),
		});
	});

	// =========================================================================
	// GET /audit-log/export — CSV / NDJSON
	// =========================================================================
	app.get("/audit-log/export", async (c) => {
		const key = c.get("verifiedKey");

		if (!hasAuditLogScope(key.scopes, AUDIT_LOG_SCOPES.EXPORT)) {
			return insufficientScope(c, AUDIT_LOG_SCOPES.EXPORT);
		}

		const qs = c.req.query();
		const format = qs.format === "ndjson" ? "ndjson" : "csv";
		const filter = parseFilter(qs);

		if (
			filter.dateFrom &&
			filter.dateTo &&
			filter.dateFrom > filter.dateTo
		) {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message:
							"dateFrom must be less than or equal to dateTo",
					},
				},
				400,
			);
		}

		const scope = scopeFromKey(key);

		const count = await countAuditLog({ scope, filter });
		if (count > AUDIT_EXPORT_ROW_CAP) {
			return c.json(
				{
					error: {
						code: "BAD_REQUEST",
						message: `Result set exceeds ${AUDIT_EXPORT_ROW_CAP.toLocaleString()} rows. Refine your filter.`,
					},
				},
				400,
			);
		}

		const rows = await fetchAuditLogForExport({ scope, filter });
		const body =
			format === "csv"
				? serializeAuditLogToCsv(rows)
				: serializeAuditLogToNdjson(rows);

		// Audit emit BEFORE building the response body length headers
		// so a mid-flight transport error after this point still leaves
		// a record of the export attempt.
		const ctx = buildAuditContext(c.req.raw.headers, key);
		recordAuditFromRequest(ctx, {
			action: "audit.api_request",
			category: "audit",
			organizationId:
				key.owner.type === "org" ? key.owner.organizationId : null,
			outcome: "success",
			severity: "info",
			actor: {
				type: "api_key",
				nameSnapshot: key.keyName,
			},
			metadata: {
				endpoint: "/api/v1/audit-log/export",
				method: "GET",
				responseStatus: 200,
				keyPrefix: key.keyPrefix,
				keyId: key.keyId,
				keyName: key.keyName,
				format,
				rowCount: rows.length,
			},
		});

		void bumpUsage(key);

		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": exportContentType(format),
				"Content-Disposition": `attachment; filename="${exportFilename(format)}"`,
			},
		});
	});

	return app;
}
