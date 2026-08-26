/**
 * Public system-health REST routes.
 *
 *   - `GET /api/v1/system-health`  — component status + active announcements,
 *     scoped to the key's tenant (`system_health:read`).
 *   - `GET /api/v1/status-updates` — announcement history, no tenant data
 *     (`status_updates:read`).
 *
 * Auth: `Authorization: Bearer fab_*` (personal) or `org_*` (org), via the
 * shared `apiKeyRestAuth` middleware. The key encodes the tenant, so there is no
 * tenant parameter to tamper with — the same construction the audit-log routes
 * use.
 *
 * No CORS, deliberately: server-to-server only. A browser on a hostile origin
 * must not be able to fish platform or tenant status with a stolen key.
 *
 * The overview body is produced by the SAME `buildSystemHealthOverview` the
 * in-product procedure calls, so the external and internal surfaces cannot drift
 * into showing different fields.
 */

import { listStatusUpdateHistory } from "@repo/database";
import { Hono } from "hono";
import {
	type ApiKeyRestVariables,
	apiKeyRestAuth,
	insufficientScope,
} from "../../../lib/api-key-rest-auth";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	hasObservabilityScope,
	OBSERVABILITY_SCOPES,
} from "../../../lib/observability-scopes";
import { buildSystemHealthOverview } from "../lib/build-overview";

/**
 * Derive the audit-log scope from a verified key, mirroring the audit-log
 * routes: a user key sees its owner's personal context, an org key sees the org.
 */
function scopeFromKey(key: ApiKeyRestVariables["verifiedKey"]) {
	if (key.owner.type === "user") {
		return { organizationId: null, userId: key.owner.userId };
	}
	return { organizationId: key.owner.organizationId, userId: null };
}

export function createSystemHealthRestRoutes() {
	const app = new Hono<{ Variables: ApiKeyRestVariables }>();

	app.use("*", apiKeyRestAuth());

	app.get("/system-health", async (c) => {
		const key = c.get("verifiedKey");
		if (
			!hasObservabilityScope(
				key.scopes,
				OBSERVABILITY_SCOPES.SYSTEM_HEALTH_READ,
			)
		) {
			return insufficientScope(
				c,
				OBSERVABILITY_SCOPES.SYSTEM_HEALTH_READ,
			);
		}

		const overview = await buildSystemHealthOverview(scopeFromKey(key));

		recordAuditFromRequest(
			{
				headers: c.req.raw.headers,
				user: { id: key.owner.userId, email: "", name: null },
			},
			{
				action: "audit.api_request",
				category: "audit",
				organizationId:
					key.owner.type === "org" ? key.owner.organizationId : null,
				outcome: "success",
				severity: "info",
				actor: { type: "api_key", nameSnapshot: key.keyName },
				metadata: {
					endpoint: "/api/v1/system-health",
					method: "GET",
					responseStatus: 200,
					keyPrefix: key.keyPrefix,
					keyId: key.keyId,
					keyName: key.keyName,
					overallStatus: overview.overallStatus,
				},
			},
		);

		return c.json(overview);
	});

	app.get("/status-updates", async (c) => {
		const key = c.get("verifiedKey");
		if (
			!hasObservabilityScope(
				key.scopes,
				OBSERVABILITY_SCOPES.STATUS_UPDATES_READ,
			)
		) {
			return insufficientScope(
				c,
				OBSERVABILITY_SCOPES.STATUS_UPDATES_READ,
			);
		}

		const sinceDaysRaw = Number.parseInt(
			c.req.query("sinceDays") ?? "",
			10,
		);
		const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
		const updates = await listStatusUpdateHistory({
			sinceDays: Number.isFinite(sinceDaysRaw) ? sinceDaysRaw : 90,
			limit: Number.isFinite(limitRaw) ? limitRaw : 50,
		});

		recordAuditFromRequest(
			{
				headers: c.req.raw.headers,
				user: { id: key.owner.userId, email: "", name: null },
			},
			{
				action: "audit.api_request",
				category: "audit",
				organizationId:
					key.owner.type === "org" ? key.owner.organizationId : null,
				outcome: "success",
				severity: "info",
				actor: { type: "api_key", nameSnapshot: key.keyName },
				metadata: {
					endpoint: "/api/v1/status-updates",
					method: "GET",
					responseStatus: 200,
					keyPrefix: key.keyPrefix,
					keyId: key.keyId,
					keyName: key.keyName,
					resultCount: updates.length,
				},
			},
		);

		return c.json({ updates });
	});

	return app;
}
