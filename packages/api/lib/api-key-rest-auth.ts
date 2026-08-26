/**
 * Shared Bearer-key authentication + rate limiting for the public read-only
 * observability REST surface (`/api/v1/audit-log*`, `/api/v1/system-health`,
 * `/api/v1/status-updates`).
 *
 * Extracted so every surface behaves identically. Two of the behaviours below
 * were previously implemented once, for the audit-log routes only, and adding a
 * second surface by copy-paste would have meant fixing each of them twice:
 *
 *   - **Failed attempts are audited, and readable.** Previously only SUCCESSFUL
 *     reads emitted a row, so a key being probed, replayed after revocation, or
 *     hammered past the rate limit left no trace at all — precisely the forensic
 *     question an operator asks first. Attempts whose secret verified are
 *     attributed to the owning tenant so they appear in that tenant's log; the
 *     rest are counted as a probing metric (see `auditFailedAttempt`).
 *   - **A permanently misconfigured rate limiter says so.** A production
 *     deployment with no Redis configured fails closed forever, and reporting
 *     that as "temporarily unavailable" sends an integrator hunting a transient
 *     that will never clear.
 *
 * Scope enforcement deliberately stays with each ROUTE rather than living here.
 * That is what keeps an `audit_log:read` key from reaching the system-health
 * endpoint even though both use this same verifier: isolation comes from the
 * per-route scope check, not from which verifier a route happens to mount.
 */

import { logger } from "@repo/logs";
import { apiKeyRestUnattributableRejections } from "@repo/observability";
import type { Context, Next } from "hono";
import {
	type AuditApiKeyError,
	type AuditApiKeyOwner,
	type VerifiedAuditApiKey,
	verifyAuditApiKey,
} from "../modules/audit/rest/verify-audit-key";
import { recordAuditFromRequest } from "./audit";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "./rate-limit";

export type ApiKeyRestVariables = {
	verifiedKey: VerifiedAuditApiKey;
};

interface MappedError {
	status: 401 | 403 | 429 | 503;
	code: string;
	message: string;
}

function mapVerificationError(error: AuditApiKeyError): MappedError {
	switch (error) {
		case "MISSING_HEADER":
			return {
				status: 401,
				code: "MISSING_AUTHORIZATION",
				message: "Missing Authorization header. Use: Bearer <api_key>",
			};
		case "INVALID_FORMAT":
			return {
				status: 401,
				code: "INVALID_API_KEY_FORMAT",
				message:
					"Invalid API key format. Keys must start with fab_ or org_.",
			};
		case "INACTIVE":
			return {
				status: 401,
				code: "API_KEY_REVOKED",
				message: "API key has been revoked.",
			};
		case "EXPIRED":
			return {
				status: 401,
				code: "API_KEY_EXPIRED",
				message: "API key has expired.",
			};
		case "NOT_FOUND":
		case "HASH_MISMATCH":
			// Collapsed on purpose so probing cannot distinguish "no such key
			// prefix" from "wrong secret".
			return {
				status: 401,
				code: "INVALID_API_KEY",
				message: "Invalid API key.",
			};
	}
}

/**
 * Emit an audit row for a REST attempt that never reached a handler.
 *
 * **Attribution follows proof, and only proof.** `owner` is passed exactly when
 * the presented secret matched the stored hash (see `provenOwner` on
 * `VerifyAuditApiKeyResult`) — success, `INACTIVE`, `EXPIRED`, and every
 * post-authentication rejection such as `INSUFFICIENT_SCOPE` or
 * `TOO_MANY_REQUESTS`. Those rows carry the owner's tenant and user FK, which is
 * what makes them readable: `buildAuditWhere` resolves personal scope to
 * `organizationId IS NULL AND userId = <caller>`, so a row with neither matches
 * no tenant-scoped query and is reachable only by direct SQL. That was the state
 * of every failure row before this change — audited in principle, invisible in
 * practice.
 *
 * When ownership is NOT proven (`NOT_FOUND`, `HASH_MISMATCH`, a malformed
 * header) the row stays tenant-less. Attributing on the strength of an
 * unverified 8-hex prefix would let prefix-guessing inject rows into a stranger's
 * audit trail, which is a worse defect than the one being fixed. Those attempts
 * are instead counted on `apiKeyRestUnattributableRejections` for alerting,
 * since no tenant-scoped surface can ever show them.
 */
function auditFailedAttempt(
	c: Context,
	outcome: {
		code: string;
		status: number;
		keyPrefix?: string;
		owner?: AuditApiKeyOwner;
	},
): void {
	if (!outcome.owner) {
		apiKeyRestUnattributableRejections.inc({ error_code: outcome.code });
	}
	try {
		recordAuditFromRequest(
			{ headers: c.req.raw.headers },
			{
				action: "audit.api_request",
				category: "audit",
				organizationId: outcome.owner?.organizationId ?? null,
				outcome: "failure",
				severity: "warning",
				actor: {
					type: "api_key",
					...(outcome.owner ? { userId: outcome.owner.userId } : {}),
				},
				metadata: {
					endpoint: new URL(c.req.url).pathname,
					method: c.req.method,
					responseStatus: outcome.status,
					errorCode: outcome.code,
					// Non-secret by construction (12 chars, cannot authenticate) and
					// the only forensic handle on a rejected attempt. Absent when the
					// header was malformed enough that no prefix could be parsed.
					...(outcome.keyPrefix
						? { keyPrefix: outcome.keyPrefix }
						: {}),
				},
			},
		);
	} catch (error) {
		logger.warn(
			{
				event: "api_key_rest.audit_failed_attempt_error",
				error: error instanceof Error ? error.message : String(error),
			},
			"Failed to record audit row for rejected API request",
		);
	}
}

/**
 * Best-effort prefix read straight off the header, for the failure audit row.
 * Never validated — it is a forensic label, not a credential.
 */
function readKeyPrefixFromHeader(
	authHeader: string | undefined,
): string | undefined {
	if (!authHeader?.toLowerCase().startsWith("bearer ")) return undefined;
	const raw = authHeader.slice(7).trim();
	const parts = raw.split("_");
	if (parts.length < 3) return undefined;
	if (parts[0] !== "fab" && parts[0] !== "org") return undefined;
	return `${parts[0]}_${parts[1]}`;
}

/**
 * Hono middleware: verify the Bearer key, apply the per-key rate limit, and set
 * `verifiedKey` on the context. Mount with `app.use("*", ...)`.
 */
export function apiKeyRestAuth() {
	return async (c: Context, next: Next) => {
		const authHeader = c.req.header("Authorization");
		const rawKey = authHeader?.toLowerCase().startsWith("bearer ")
			? authHeader.slice(7).trim()
			: undefined;

		const verification = await verifyAuditApiKey(rawKey);
		if (!verification.ok || !verification.key) {
			const mapped = mapVerificationError(
				verification.error ?? "MISSING_HEADER",
			);
			auditFailedAttempt(c, {
				code: mapped.code,
				status: mapped.status,
				keyPrefix: readKeyPrefixFromHeader(authHeader),
				owner: verification.provenOwner,
			});
			return c.json(
				{ error: { code: mapped.code, message: mapped.message } },
				mapped.status,
			);
		}

		const key = verification.key;
		const { limit, windowMs } = RATE_LIMIT_PRESETS.auditExternal;
		const rl = await checkRateLimit(
			`audit-rest:${key.keyId}`,
			limit,
			windowMs,
		);

		if (rl.statusCode !== 503) {
			c.header("X-RateLimit-Limit", limit.toString());
			c.header("X-RateLimit-Remaining", rl.remaining.toString());
			c.header("X-RateLimit-Reset", rl.resetInSeconds.toString());
		}

		if (!rl.allowed) {
			const unavailable = rl.statusCode === 503;
			c.header("Retry-After", rl.resetInSeconds.toString());
			auditFailedAttempt(c, {
				code: unavailable ? "SERVICE_UNAVAILABLE" : "TOO_MANY_REQUESTS",
				status: unavailable ? 503 : 429,
				keyPrefix: key.keyPrefix,
				owner: key.owner,
			});
			return c.json(
				{
					error: unavailable
						? {
								code: "SERVICE_UNAVAILABLE",
								// Names the cause rather than implying a transient
								// blip: when Redis is simply not configured this
								// state never clears on its own, and "try again"
								// would send an integrator chasing nothing.
								message:
									"Rate limiting is unavailable, so requests are refused. If this persists, the deployment is missing its rate-limit store configuration (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).",
							}
						: {
								code: "TOO_MANY_REQUESTS",
								message: `Rate limit exceeded. Try again in ${rl.resetInSeconds}s.`,
							},
				},
				unavailable ? 503 : 429,
			);
		}

		c.set("verifiedKey", key);
		await next();
	};
}

/**
 * Standard 403 body for a key that authenticated but lacks the scope a route
 * requires. Also audited — an integration repeatedly hitting an endpoint it was
 * never granted is a configuration problem worth being able to see.
 */
export function insufficientScope(c: Context, required: string) {
	const key = c.get("verifiedKey") as VerifiedAuditApiKey | undefined;
	auditFailedAttempt(c, {
		code: "INSUFFICIENT_SCOPE",
		status: 403,
		keyPrefix: key?.keyPrefix,
		owner: key?.owner,
	});
	return c.json(
		{
			error: {
				code: "INSUFFICIENT_SCOPE",
				message: `Missing required scope: ${required}`,
			},
		},
		403,
	);
}
