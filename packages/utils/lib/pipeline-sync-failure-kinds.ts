/**
 * What a classified QA pipeline sync-failure kind MEANS — is this the
 * customer's problem or ours, and does telling them to reconnect the
 * repository actually fix it.
 *
 * Card #2383: the QA pipeline-results sync logged every per-source failure at
 * `error`, unconditionally, and the cron in `schedules.ts` re-runs it every 15
 * minutes forever. Across 9 projects that produced 624 error-level log lines in
 * 12 hours, every one of them a customer-side credential or permission problem
 * (an expired PAT, a token missing a scope, SSO enforcement) that no engineer
 * can do anything about. Paging on that is the noise this file exists to cut —
 * see `provider-http-error.ts`'s own module doc (in `@repo/temporal`) for the
 * same lesson learned about collapsing distinct HTTP failures into one
 * undifferentiated bucket.
 *
 * This lives in `@repo/utils` — not in `@repo/temporal`, where the failure is
 * first classified from a caught error — because the kind→meaning table is
 * shared vocabulary: a Temporal worker (`sync-pipeline-results.ts`, which
 * chooses a log level from it) and a `"use client"` bundle
 * (`SyncFailureBanner.tsx`, the Settings ▸ Development sync-health section,
 * which decide whether to offer a reconnect action) both need it, and `apps/web` does not depend on `@repo/temporal`
 * for runtime values — see `BacklogChat.tsx`'s module doc for the same rule
 * and the same remedy it names: collapse both sides onto a shared
 * `@repo/utils` constant. `@repo/temporal`'s `sync-failure-classification.ts`
 * imports this table and adds the one thing that has to stay server-side,
 * `classifySyncFailure`, which needs `ProviderHttpError`.
 *
 * Pure — no `db`, no network, no clock, no Node built-ins — so every branch is
 * unit-testable without a provider or a database, and safe to reach from a
 * browser bundle.
 */

export type SyncFailureKind =
	// No usable token could even be resolved (nothing stored, or the stored
	// row decrypted to nothing) — never a THROWN failure, see `UNKNOWN` below.
	| "CREDENTIAL_MISSING"
	// The provider answered 401: the credential is expired, revoked, or wrong.
	| "CREDENTIAL_REJECTED"
	// The provider answered 403 for a reason that is neither the rate limiter
	// nor SSO enforcement — a genuinely missing permission/scope/app install.
	| "PERMISSION_MISSING"
	// The provider answered 403 specifically because the credential has not
	// been authorised for the org's SAML SSO enforcement.
	| "SSO_REQUIRED"
	// The provider answered 429, or 403 with rate-limit headers.
	| "RATE_LIMITED"
	// The provider answered 404 — repo/branch missing, or invisible to this
	// credential (GitHub deliberately conflates the two under one status).
	| "NOT_FOUND"
	// The plan for this source could not even be derived — an unparseable
	// repository URL, or a provider this sync does not fetch.
	| "MISCONFIGURED"
	// Everything else: a plain `Error`, a 5xx, a network failure, an ingest/RCA
	// exception, a token-resolution THROW (as opposed to a clean "no token").
	// Treated as OUR fault — this is the one kind that must stay loud.
	| "UNKNOWN";

export interface SyncFailureClassification {
	kind: SyncFailureKind;
	/**
	 * Log level: `"warn"` when the remedy belongs to the customer (an
	 * expected, user-actionable state — reconnect, grant a permission, wait
	 * out a rate limit), `"error"` when it belongs to us. Every kind other
	 * than `UNKNOWN` is `"warn"`; a fault that is genuinely ours (a 5xx, a
	 * network failure, an internal exception) must never be downgraded, which
	 * is exactly what conflating "the customer's token expired" with "our
	 * ingest pipeline threw" would do.
	 */
	severity: "warn" | "error";
	/**
	 * True ONLY when reconnecting the repository integration actually fixes
	 * the failure. Limited to `CREDENTIAL_MISSING` and `CREDENTIAL_REJECTED`
	 * on purpose: `provider-http-error.ts` (in `@repo/temporal`) already
	 * reasons at length that a 403 that is not a rate limit and not SSO means
	 * the credential authenticated fine and was refused the resource, so
	 * reconnecting it changes nothing — the permission has to be granted
	 * elsewhere. Likewise SSO needs the authorize URL already embedded in the
	 * message, not a reconnect flow. Telling someone to reconnect a working
	 * credential is the exact regression that file's module doc describes
	 * fixing once already (PR #2303) — this flag must not reintroduce it from
	 * the other end.
	 */
	reconnectFixes: boolean;
}

const CLASSIFICATIONS: Record<SyncFailureKind, SyncFailureClassification> = {
	CREDENTIAL_MISSING: {
		kind: "CREDENTIAL_MISSING",
		severity: "warn",
		reconnectFixes: true,
	},
	CREDENTIAL_REJECTED: {
		kind: "CREDENTIAL_REJECTED",
		severity: "warn",
		reconnectFixes: true,
	},
	PERMISSION_MISSING: {
		kind: "PERMISSION_MISSING",
		severity: "warn",
		reconnectFixes: false,
	},
	SSO_REQUIRED: {
		kind: "SSO_REQUIRED",
		severity: "warn",
		reconnectFixes: false,
	},
	RATE_LIMITED: {
		kind: "RATE_LIMITED",
		severity: "warn",
		reconnectFixes: false,
	},
	NOT_FOUND: {
		kind: "NOT_FOUND",
		severity: "warn",
		reconnectFixes: false,
	},
	MISCONFIGURED: {
		kind: "MISCONFIGURED",
		severity: "warn",
		reconnectFixes: false,
	},
	UNKNOWN: {
		kind: "UNKNOWN",
		severity: "error",
		reconnectFixes: false,
	},
};

/**
 * Look up the fixed classification for a kind the caller already knows —
 * the non-HTTP failure paths (missing credential, a plan that could not be
 * derived) don't have a `ProviderHttpError` to classify, and inventing a fake
 * one just to run it back through `@repo/temporal`'s `classifySyncFailure`
 * would be a pointless round trip. Call sites should prefer this over
 * hand-building a `SyncFailureClassification` literal so the
 * kind→severity/reconnectFixes mapping has exactly one source of truth.
 */
export function classificationForKind(
	kind: SyncFailureKind,
): SyncFailureClassification {
	return CLASSIFICATIONS[kind];
}

/**
 * Same lookup as {@link classificationForKind}, but for a value the type
 * system cannot vouch for — `TestPipelineSyncState.lastErrorKind` is read back
 * from the database as a bare `string | null`, and a row written before this
 * classification existed (or edited by hand) is not guaranteed to still be a
 * member of `SyncFailureKind`. Returns `undefined` instead of throwing or
 * silently defaulting to some kind's rules, so a caller (the QA-tab banner,
 * the Settings ▸ Development sync-health section) can fall back to "no
 * reconnect link" rather than guessing.
 */
export function classificationForRawKind(
	value: string | null | undefined,
): SyncFailureClassification | undefined {
	if (value == null) {
		return undefined;
	}
	return Object.hasOwn(CLASSIFICATIONS, value)
		? CLASSIFICATIONS[value as SyncFailureKind]
		: undefined;
}
