/**
 * Audit-log REST API key verification.
 *
 * Verifies `Authorization: Bearer <key>` for the public audit-log REST
 * endpoints (`GET /api/v1/audit-log`, `GET /api/v1/audit-log/export`).
 *
 * Why a dedicated verifier rather than reusing
 * `verifyOrganizationApiKey` / `verifyUserApiKey`?
 *
 *   1. **Constant-time hash comparison.** The existing verifiers do a
 *      direct `findFirst({ where: { keyHash } })` lookup — Postgres
 *      indexes a byte-by-byte equality plan and the query latency
 *      leaks one bit per probe. For the public audit-log API, where an
 *      attacker can hammer the endpoint from outside the tenant, we
 *      do a prefix-indexed lookup followed by `crypto.timingSafeEqual`
 *      on the SHA-256 digest in application memory.
 *
 *   2. **Narrow, read-only scope vocabulary.** The public observability
 *      surface uses scopes (`audit_log:read`, `audit_log:export`,
 *      `system_health:read`, `status_updates:read`) that are NOT in the
 *      MCP/agent scope sets. Keeping the check out of the broader
 *      external-API path stops one of these keys being escalated into
 *      another surface accidentally.
 *
 *      This verifier now backs several read-only routes, not just the
 *      audit-log ones. The isolation guarantee does NOT come from which
 *      routes mount this verifier — it comes from each ROUTE checking the
 *      specific scope it requires. An `audit_log:read` key authenticates
 *      here and is then refused by the system-health route's own scope
 *      check.
 *
 *   3. **Resolved tenant context.** The verifier returns a normalized
 *      `{ owner: "user" | "org", userId, organizationId }` shape that the
 *      route handler hands to the audit-list query as the
 *      `AuditLogScope`. The verifier itself does NOT update usage stats
 *      — that is the route handler's job (fire-and-forget after the read
 *      succeeds, see `usage-tracking.ts`).
 *
 * Spec: see the public audit-log REST API spec in
 * `fabric/specs/.../spec.md` and the worktree instructions for this
 * change.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
	getOrganizationApiKeyByPrefixIncludingRevoked,
	getUserApiKeyByPrefixIncludingRevoked,
	isOrganizationMember,
} from "@repo/database";

export type AuditApiKeyOwner =
	| { type: "user"; userId: string; organizationId: null }
	| { type: "org"; userId: string; organizationId: string };

export interface VerifiedAuditApiKey {
	keyId: string;
	keyPrefix: string;
	/**
	 * Human-friendly name set at key creation time (e.g., "SRE laptop").
	 * Surfaced in the audit row as `actorNameSnapshot` so the in-product
	 * viewer can show "Created by: <name>" instead of the opaque prefix.
	 */
	keyName: string;
	owner: AuditApiKeyOwner;
	scopes: string[];
}

export type AuditApiKeyError =
	| "MISSING_HEADER"
	| "INVALID_FORMAT"
	| "NOT_FOUND"
	| "EXPIRED"
	| "INACTIVE"
	// The key is live and the secret matched, but its creator no longer
	// belongs to the organization it speaks for. Distinct from INACTIVE on
	// purpose: the credential was never revoked, the person was, and an
	// operator reading the audit trail wants to see which of the two happened.
	| "NOT_A_MEMBER"
	| "HASH_MISMATCH";

export interface VerifyAuditApiKeyResult {
	ok: boolean;
	key?: VerifiedAuditApiKey;
	error?: AuditApiKeyError;
	/**
	 * Set ONLY when the presented secret matched the stored hash — i.e. on
	 * success, and on the `INACTIVE` / `EXPIRED` rejections that are reached
	 * after the compare. It is the caller's licence to attribute the attempt to
	 * a tenant: holding the correct secret proves ownership even when the key is
	 * no longer usable.
	 *
	 * Absent on `NOT_FOUND` / `HASH_MISMATCH` / malformed input, where the
	 * request has proven nothing and any attribution would be a guess.
	 */
	provenOwner?: AuditApiKeyOwner;
}

/**
 * Hash an API key with SHA-256 hex. Same algorithm the existing
 * key-creation code uses (`packages/api/modules/organizations/procedures/
 * api-keys/create.ts`, `packages/api/modules/v1/routes.ts`). Keep this
 * helper local so the algorithm choice is colocated with the verifier
 * for review.
 */
export function hashApiKey(rawKey: string): string {
	return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Constant-time hex comparison. Both strings are expected to be the same
 * length (SHA-256 hex = 64 chars). Returns false for mismatched length
 * without leaking timing through the length compare itself — we always
 * call `timingSafeEqual` once we've matched buffer sizes.
 */
function constantTimeHexEqual(a: string, b: string): boolean {
	if (typeof a !== "string" || typeof b !== "string") {
		return false;
	}
	if (a.length !== b.length) {
		return false;
	}
	const aBuf = Buffer.from(a, "hex");
	const bBuf = Buffer.from(b, "hex");
	if (aBuf.length !== bBuf.length) {
		return false;
	}
	return timingSafeEqual(aBuf, bBuf);
}

/**
 * Extract the prefix portion of an API key for indexed lookup.
 *
 * Personal keys: `fab_<8hex>_<secret>` -> `fab_<8hex>`.
 * Org keys: `org_<8hex>_<secret>` -> `org_<8hex>`.
 *
 * Returns null when the format doesn't match either of those shapes.
 */
function extractPrefix(rawKey: string): string | null {
	const parts = rawKey.split("_");
	if (parts.length < 3) {
		return null;
	}
	const sigil = parts[0];
	const prefixHex = parts[1];
	if (sigil !== "fab" && sigil !== "org") {
		return null;
	}
	if (!prefixHex || prefixHex.length === 0) {
		return null;
	}
	return `${sigil}_${prefixHex}`;
}

/**
 * Verify an API key for the public audit-log REST surface.
 *
 *   1. Look up by `keyPrefix` (indexed).
 *   2. Compare the SHA-256 digest in app memory using
 *      `crypto.timingSafeEqual`.
 *   3. Check `isActive`.
 *   4. Check `expiresAt > now()` (null = never expires).
 *   5. Return a normalized tenant context.
 *
 * **The hash compare comes before the state checks, and the order matters
 * twice.** It stops a caller who guessed only a 8-hex prefix from learning that
 * the key exists and is revoked, which the previous order told them without
 * their ever presenting the secret. And it means a request that reaches
 * `INACTIVE` or `EXPIRED` has *proven* which tenant it belongs to, so the
 * rejection can be recorded in that tenant's audit trail (`provenOwner`) —
 * whereas one rejected by the compare cannot be attributed to anyone.
 *
 * Scope checks are intentionally NOT performed here — the route handler
 * checks `audit_log:read` vs `audit_log:export` depending on the
 * endpoint being hit.
 *
 * Never throws. Returns a uniform `{ ok, error }` shape so the caller
 * can map directly to HTTP status codes without unwinding exceptions.
 */
export async function verifyAuditApiKey(
	rawKey: string | undefined,
): Promise<VerifyAuditApiKeyResult> {
	if (!rawKey || typeof rawKey !== "string" || rawKey.trim().length === 0) {
		return { ok: false, error: "MISSING_HEADER" };
	}
	const prefix = extractPrefix(rawKey);
	if (!prefix) {
		return { ok: false, error: "INVALID_FORMAT" };
	}

	const expectedHash = hashApiKey(rawKey);
	const now = new Date();

	if (prefix.startsWith("fab_")) {
		const record = await getUserApiKeyByPrefixIncludingRevoked(prefix);
		if (!record) {
			return { ok: false, error: "NOT_FOUND" };
		}
		if (!constantTimeHexEqual(expectedHash, record.keyHash)) {
			return { ok: false, error: "HASH_MISMATCH" };
		}
		const owner: AuditApiKeyOwner = {
			type: "user",
			userId: record.userId,
			organizationId: null,
		};
		if (!record.isActive) {
			return { ok: false, error: "INACTIVE", provenOwner: owner };
		}
		if (record.expiresAt && record.expiresAt <= now) {
			return { ok: false, error: "EXPIRED", provenOwner: owner };
		}
		return {
			ok: true,
			key: {
				keyId: record.id,
				keyPrefix: record.keyPrefix,
				keyName: record.name,
				owner,
				scopes: record.scopes,
			},
			provenOwner: owner,
		};
	}

	// org_ key
	const record = await getOrganizationApiKeyByPrefixIncludingRevoked(prefix);
	if (!record) {
		return { ok: false, error: "NOT_FOUND" };
	}
	if (!constantTimeHexEqual(expectedHash, record.keyHash)) {
		return { ok: false, error: "HASH_MISMATCH" };
	}
	const owner: AuditApiKeyOwner = {
		type: "org",
		userId: record.createdByUserId,
		organizationId: record.organizationId,
	};
	if (!record.isActive) {
		return { ok: false, error: "INACTIVE", provenOwner: owner };
	}
	if (record.expiresAt && record.expiresAt <= now) {
		return { ok: false, error: "EXPIRED", provenOwner: owner };
	}
	// Membership is read live, never from the key row. An organization key
	// speaks for its creator, and the day that person is removed is the day it
	// should stop speaking — not the day someone remembers to delete the row.
	if (
		!(await isOrganizationMember(
			record.createdByUserId,
			record.organizationId,
		))
	) {
		return { ok: false, error: "NOT_A_MEMBER", provenOwner: owner };
	}
	return {
		ok: true,
		key: {
			keyId: record.id,
			keyPrefix: record.keyPrefix,
			keyName: record.name,
			owner,
			scopes: record.scopes,
		},
		provenOwner: owner,
	};
}

/**
 * Scope-vocabulary constants for the public audit-log REST API.
 *
 *   - `audit_log:read`   — required for `GET /api/v1/audit-log`.
 *   - `audit_log:export` — required for `GET /api/v1/audit-log/export`.
 *
 * Kept separate so an integration that only ingests events cannot bulk-
 * export the entire trail. `*` (wildcard, already in the org-key vocabulary)
 * grants both.
 */
export const AUDIT_LOG_SCOPES = {
	READ: "audit_log:read",
	EXPORT: "audit_log:export",
} as const;

export type AuditLogScopeName =
	(typeof AUDIT_LOG_SCOPES)[keyof typeof AUDIT_LOG_SCOPES];

/**
 * Does the key's `scopes` array grant the required audit-log scope?
 * The `*` wildcard (already used by the org-key vocabulary for full
 * access) implicitly grants both audit-log scopes.
 */
export function hasAuditLogScope(
	scopes: readonly string[],
	required: AuditLogScopeName,
): boolean {
	return scopes.includes(required) || scopes.includes("*");
}
