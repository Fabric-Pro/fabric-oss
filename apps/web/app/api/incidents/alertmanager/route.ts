/**
 * Alertmanager webhook receiver — incidents funnel.
 *
 * Accepts Alertmanager webhook payloads OR direct internal posts with a
 * `kind` discriminator routing to the matching incident table:
 *
 *   - `kind: "errorRate"`  → ErrorRateIncident (handled by the Temporal
 *                            poller; this endpoint is a no-op for that
 *                            kind in v1, kept for parity).
 *   - `kind: "integration"` → IntegrationIncident (also handled by the
 *                            Temporal status-page poller; no-op here).
 *   - `kind: "component"`  → ComponentIncident — Fabric subsystem outages
 *                            (Temporal worker stalled, Prisma migration
 *                            drift, RAG indexer queue backed up, agent
 *                            rail down, etc.). This is the new v3 path.
 *
 * Auth: the webhook is protected by a shared bearer secret in the
 * `Authorization` header, comparing against `ALERTMANAGER_WEBHOOK_SECRET`
 * with constant-time equality. When the secret is unset (local dev),
 * unauthenticated POSTs are accepted but logged as `auth=dev-bypass`.
 *
 * Payload shape (component kind):
 *   {
 *     "kind": "component",
 *     "status": "firing" | "resolved",
 *     "fingerprint": "<alertmanager fingerprint>",
 *     "labels": {
 *       "component_key": "temporal-worker",
 *       "component_name": "Temporal Worker",
 *       "severity": "sev1" | "sev2" | "sev3"
 *     },
 *     "annotations": {
 *       "summary": "Free-text description of the outage"
 *     }
 *   }
 */

import { timingSafeEqual } from "node:crypto";
import {
	closeComponentIncident,
	upsertAlertmanagerIncident,
	upsertComponentIncident,
} from "@repo/database";
import { logger } from "@repo/logs";
import { type NextRequest, NextResponse } from "next/server";

interface IncomingAlert {
	kind?: "errorRate" | "integration" | "component";
	status?: "firing" | "resolved";
	fingerprint?: string;
	/** Alertmanager wire fields, needed by the errorRate path. */
	startsAt?: string;
	endsAt?: string;
	labels?: Record<string, string | undefined>;
	annotations?: Record<string, string | undefined>;
}

/**
 * Drop `undefined` values so the record satisfies `Record<string, string>`.
 * Alertmanager sends absent labels as missing keys, but a hand-rolled poster can
 * send explicit `undefined`.
 *
 * Built with `Object.fromEntries` rather than by assigning `out[key] = value` —
 * js/remote-property-injection. Label and annotation names come off the wire, so
 * assignment would run them through `Object.prototype`'s setters; `fromEntries`
 * defines own data properties and never reaches the prototype chain.
 */
function definedOnly(
	input: Record<string, string | undefined> | undefined,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(input ?? {}).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/**
 * Alertmanager sends RFC3339 timestamps, and uses the zero time for "not ended".
 */
function parseAlertTime(raw: string | undefined): Date | null {
	if (!raw) return null;
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return null;
	// Alertmanager's "no end yet" sentinel.
	if (parsed.getUTCFullYear() <= 1) return null;
	return parsed;
}

function authorize(req: NextRequest): { ok: boolean; mode: string } {
	const expected = process.env.ALERTMANAGER_WEBHOOK_SECRET;
	if (!expected) {
		// Fail closed in deployed environments (SOC 2 CC6.1). Vercel sets
		// NODE_ENV=production on every deployment (staging and prod), so an
		// unset secret there must reject rather than accept unauthenticated
		// posts. The dev-bypass is retained for local development only.
		if (process.env.NODE_ENV === "production") {
			return { ok: false, mode: "no-secret-configured" };
		}
		return { ok: true, mode: "dev-bypass" };
	}
	const header = req.headers.get("authorization");
	if (!header || !header.startsWith("Bearer ")) {
		return { ok: false, mode: "missing-bearer" };
	}
	const presented = header.slice(7);
	try {
		const presentedBuf = Buffer.from(presented);
		const expectedBuf = Buffer.from(expected);
		if (presentedBuf.length !== expectedBuf.length) {
			return { ok: false, mode: "length-mismatch" };
		}
		return {
			ok: timingSafeEqual(presentedBuf, expectedBuf),
			mode: "bearer",
		};
	} catch {
		return { ok: false, mode: "comparison-failed" };
	}
}

function severityFromLabel(
	value: string | undefined,
): "SEV1" | "SEV2" | "SEV3" {
	if (value === "sev1" || value === "SEV1") {
		return "SEV1";
	}
	if (value === "sev2" || value === "SEV2") {
		return "SEV2";
	}
	return "SEV3";
}

export async function POST(request: NextRequest) {
	const auth = authorize(request);
	if (!auth.ok) {
		return NextResponse.json(
			{ error: "Unauthorized", reason: auth.mode },
			{ status: 401 },
		);
	}

	let body: IncomingAlert | { alerts?: IncomingAlert[] };
	try {
		body = (await request.json()) as
			| IncomingAlert
			| { alerts?: IncomingAlert[] };
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	// Alertmanager normally posts `{ alerts: [...] }` — handle both shapes.
	const alerts: IncomingAlert[] = Array.isArray(
		(body as { alerts?: IncomingAlert[] }).alerts,
	)
		? ((body as { alerts: IncomingAlert[] }).alerts ?? [])
		: [body as IncomingAlert];

	const results: Array<Record<string, unknown>> = [];

	for (const alert of alerts) {
		const kind = alert.kind ?? alert.labels?.kind ?? "errorRate";

		// `integration` IS owned by the Temporal poller: `upsert-integration-incident`
		// and `close-integration-incident` create, update and close those rows, so
		// writing them here too would double-handle the same alert.
		//
		// `errorRate` was NOT owned by anything. The comment here used to claim the
		// poller owned it as well, and Temporal only ever PRUNES that table
		// (`prune-incidents`) — nothing created a row. So every burn-rate alert was
		// accepted, acknowledged and dropped, and `ErrorRateIncident` stayed
		// permanently empty while the admin dashboard, the weekly digest and the
		// incident-event bridge all read from it.
		//
		// `upsertAlertmanagerIncident` already implements exactly this: fingerprint
		// dedupe, reopen-on-refire, incident events and the audit bridge. It was
		// written and tested and simply never called from production. Wiring it is
		// the whole fix.
		if (kind === "integration") {
			results.push({
				kind,
				accepted: true,
				handled: false,
				reason: "owned-by-temporal-poller",
			});
			continue;
		}

		if (kind === "errorRate") {
			const fingerprint = alert.fingerprint;
			if (!fingerprint) {
				// The fingerprint is the dedupe key. Without it a refire would
				// open a second incident for the same alert, so refuse rather
				// than create duplicates.
				results.push({
					kind,
					accepted: false,
					error: "fingerprint is required for errorRate alerts",
				});
				continue;
			}
			try {
				const out = await upsertAlertmanagerIncident({
					fingerprint,
					alertName: alert.labels?.alertname ?? "error_rate",
					severity: severityFromLabel(alert.labels?.severity),
					startsAt: parseAlertTime(alert.startsAt) ?? new Date(),
					endsAt:
						alert.status === "resolved"
							? (parseAlertTime(alert.endsAt) ?? new Date())
							: null,
					labels: definedOnly(alert.labels),
					annotations: definedOnly(alert.annotations),
				});
				results.push({
					kind,
					accepted: true,
					handled: true,
					incidentId: out.incidentId,
					action: alert.status === "resolved" ? "resolved" : "firing",
				});
			} catch (err) {
				logger.error(
					"[incidents/alertmanager] errorRate upsert failed",
					{
						error: err instanceof Error ? err.message : String(err),
						fingerprint,
					},
				);
				results.push({ kind, accepted: false, error: "upsert-failed" });
			}
			continue;
		}

		const componentKey =
			alert.labels?.component_key ?? alert.labels?.componentKey;
		const componentName =
			alert.labels?.component_name ??
			alert.labels?.componentName ??
			componentKey ??
			"unknown";
		const severity = severityFromLabel(alert.labels?.severity);
		const summary = alert.annotations?.summary ?? null;
		const fingerprint = alert.fingerprint ?? null;

		if (!componentKey) {
			results.push({
				kind,
				accepted: false,
				error: "labels.component_key is required",
			});
			continue;
		}

		try {
			if (alert.status === "resolved" && fingerprint) {
				// Find by fingerprint, then close.
				// We do an upsert-then-close so a "resolved" without a prior
				// fire still recorded in the DB doesn't blow up.
				const { incidentId } = await upsertComponentIncident({
					componentKey,
					componentName,
					severity,
					summary,
					alertmanagerFingerprint: fingerprint,
				});
				await closeComponentIncident({
					incidentId,
					autoResolved: true,
				});
				results.push({
					kind,
					accepted: true,
					handled: true,
					incidentId,
					action: "resolved",
				});
			} else {
				const out = await upsertComponentIncident({
					componentKey,
					componentName,
					severity,
					summary,
					alertmanagerFingerprint: fingerprint,
				});
				results.push({
					kind,
					accepted: true,
					handled: true,
					incidentId: out.incidentId,
					wasNew: out.wasNew,
					action: "firing",
				});
			}
		} catch (err) {
			logger.error("[incidents/alertmanager] component upsert failed", {
				componentKey,
				severity,
				error: err instanceof Error ? err.message : String(err),
			});
			results.push({
				kind,
				accepted: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return NextResponse.json({ ok: true, results });
}
