/**
 * Audit Log Sealing — tamper-evidence for the append-only audit_log
 * (SOC 2 CC7.1 / CC7.2).
 *
 * The `audit_log` table is already append-only at the DB layer: the
 * `audit_log_worm` trigger (migration 20260702130000) rejects every UPDATE
 * (except the FK ON DELETE SET NULL transition) and every DELETE that has not
 * opted into the in-transaction retention bypass GUC. That protects the log
 * *while the trigger is intact*. It does NOT, on its own, let an auditor prove
 * after the fact that nobody with direct database ownership dropped the
 * trigger, edited or deleted rows, and put the trigger back.
 *
 * Sealing closes that gap. A scheduled job periodically computes a
 * cryptographic "seal" over the immutable content of every audit_log row in a
 * time window, chains that seal to the previous one, and HMAC-signs it with a
 * key that lives OUTSIDE the database (Secrets Manager / env). This is the same
 * model AWS CloudTrail uses for log-file validation: the chain of signed
 * digests makes any modification, deletion, or insertion of a sealed row
 * detectable, because re-deriving the seal from the tampered rows no longer
 * reproduces the stored, signed value — and an attacker who cannot read the
 * signing key cannot forge a replacement seal.
 *
 * Design choices that matter:
 *  - **Async, off the hot path.** Sealing runs in a Temporal schedule, never on
 *    the audit insert path. `recordAudit` stays fire-and-forget and fast.
 *  - **Content, not the three nullable FKs.** The seal covers every immutable
 *    column but deliberately EXCLUDES `organizationId` / `userId` / `projectId`
 *    — see {@link SEALED_AUDIT_FIELDS}.
 *  - **Key rotation aware.** Each seal records the `keyId` (algorithm +
 *    fingerprint) it was signed with, so verification resolves the right key
 *    and keys can rotate without invalidating old seals.
 *  - **Prospective + retrospective.** The genesis seal covers all history
 *    (periodStart = epoch); every later seal covers `[prev.periodEnd, cutoff)`.
 *
 * Verify on demand: `pnpm --filter @repo/database verify:audit-seals`.
 */

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Seal format version. Bump when the sealed field set or the hashing scheme
 * changes so verification can dispatch by version and old seals stay valid.
 */
export const AUDIT_SEAL_VERSION = "v1";

/** Signature algorithm identifier recorded on every seal. */
export const AUDIT_SEAL_ALGORITHM = "HMAC-SHA256";

/** Domain-separation tag folded into the content hash. */
const CONTENT_HASH_DOMAIN = `fabric-audit-seal:${AUDIT_SEAL_VERSION}`;

/** HKDF `info` label used when deriving the fallback signing key. */
const SEAL_HKDF_INFO = "fabric-audit-log-seal-signing-v1";

/**
 * The immutable `audit_log` columns covered by a v1 seal, in a FIXED order.
 *
 * DELIBERATELY EXCLUDES `organizationId`, `userId`, and `projectId`. The
 * `audit_log_worm` trigger permits exactly one kind of mutation to an existing
 * audit row: those three foreign keys transitioning to NULL when their referent
 * (organization / user / project) is deleted (`ON DELETE SET NULL`, added by
 * the same migration so an org deletion preserves — rather than cascades away —
 * its audit trail). If the seal covered those columns, a perfectly legitimate
 * organization deletion would retroactively "break" every seal that had covered
 * that org's rows, producing a false tamper alarm. Their integrity — the fact
 * that they may ONLY move to NULL and never to a different value — is enforced
 * by the WORM trigger itself, not by the seal. Every other column is fully
 * immutable and is sealed here.
 */
export const SEALED_AUDIT_FIELDS = [
	"id",
	"createdAt",
	"actorType",
	"actorEmailSnapshot",
	"actorNameSnapshot",
	"impersonatedById",
	"action",
	"category",
	"severity",
	"outcome",
	"resourceType",
	"resourceId",
	"resourceName",
	"ipAddress",
	"userAgent",
	"requestId",
	"sessionId",
	"metadata",
	"durationMs",
] as const;

/** A subset of an audit_log row sufficient to seal it. */
export type SealableAuditRow = {
	id: string;
	createdAt: Date;
} & Record<string, unknown>;

/** The signable header of a seal (everything except the signature itself). */
export interface SealCore {
	sequence: number;
	/** ISO-8601, inclusive lower bound on covered rows' `createdAt`. */
	periodStart: string;
	/** ISO-8601, exclusive upper bound on covered rows' `createdAt`. */
	periodEnd: string;
	rowCount: number;
	contentHash: string;
	/** `sealHash` of sequence − 1; null only for the genesis seal. */
	prevSealHash: string | null;
}

/** A persisted seal, as read back from `audit_log_seal`. */
export interface StoredSeal extends SealCore {
	sealHash: string;
	signature: string;
	keyId: string;
	version: string;
}

// ---------------------------------------------------------------------------
// Canonicalization + hashing (pure)
// ---------------------------------------------------------------------------

/**
 * Deterministically serialize a value: object keys are sorted recursively so
 * two logically-equal values always produce byte-identical output regardless
 * of key insertion order (JSONB does not preserve key order). Dates are encoded
 * as ISO strings. This is the single source of truth for "canonical form".
 */
export function canonicalize(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
	if (v === null || typeof v !== "object") {
		return v;
	}
	if (v instanceof Date) {
		return v.toISOString();
	}
	if (Array.isArray(v)) {
		return v.map(sortValue);
	}
	const obj = v as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(obj).sort()) {
		const sorted = sortValue(obj[key]);
		// Drop undefined so it can't produce a key that JSON.stringify would
		// silently omit anyway — keeps the form stable and explicit.
		if (sorted !== undefined) {
			out[key] = sorted;
		}
	}
	return out;
}

/**
 * SHA-256 over the sealed (immutable) fields of a single audit row. `createdAt`
 * is normalized to its ISO string; any missing field is treated as `null` so a
 * row selected with a narrow projection hashes identically to the full row.
 */
export function hashAuditRow(row: SealableAuditRow): string {
	const picked: Record<string, unknown> = {};
	for (const field of SEALED_AUDIT_FIELDS) {
		const raw = row[field];
		if (field === "createdAt") {
			picked[field] =
				raw instanceof Date ? raw.toISOString() : (raw ?? null);
		} else {
			picked[field] = raw === undefined ? null : raw;
		}
	}
	return createHash("sha256").update(canonicalize(picked)).digest("hex");
}

/**
 * Incremental content hasher. Rows MUST be fed in the canonical order
 * (`createdAt` ASC, then `id` ASC) so sealing and verification agree. Streaming
 * keeps memory flat for the genesis seal that covers all history.
 */
export class ContentHasher {
	private readonly hash = createHash("sha256");
	private count = 0;

	constructor() {
		// Fold the domain tag in up front so an EMPTY window still yields a
		// stable, version-specific content hash (proving "no events here").
		this.hash.update(`${CONTENT_HASH_DOMAIN}\n`);
	}

	update(row: SealableAuditRow): void {
		this.hash.update(hashAuditRow(row));
		this.hash.update("\n");
		this.count += 1;
	}

	digest(): { contentHash: string; rowCount: number } {
		return { contentHash: this.hash.digest("hex"), rowCount: this.count };
	}
}

/** Convenience: content hash over an in-memory, pre-ordered row array. */
export function computeContentHash(rows: readonly SealableAuditRow[]): {
	contentHash: string;
	rowCount: number;
} {
	const hasher = new ContentHasher();
	for (const row of rows) {
		hasher.update(row);
	}
	return hasher.digest();
}

/** SHA-256 over the canonical seal header — the value that gets signed. */
export function computeSealHash(core: SealCore): string {
	return createHash("sha256")
		.update(canonicalize({ version: AUDIT_SEAL_VERSION, ...core }))
		.digest("hex");
}

// ---------------------------------------------------------------------------
// Key management (pure)
// ---------------------------------------------------------------------------

/**
 * Signing-key candidates, highest priority first:
 *   1. `AUDIT_LOG_SIGNING_KEY`          — the dedicated, independently
 *      rotatable key an operator SHOULD set (from Secrets Manager).
 *   2. `AUDIT_LOG_SIGNING_KEY_PREVIOUS` — the prior dedicated key, kept only so
 *      seals signed before a rotation still verify.
 *   3. A key HKDF-derived from `BETTER_AUTH_SECRET` with a dedicated `info`
 *      label — the zero-config fallback so sealing works out of the box while
 *      staying cryptographically separate from every other use of that secret.
 *
 * New seals are always signed with candidate #1 (or #3 if no dedicated key is
 * set). Verification resolves whichever candidate matches the seal's recorded
 * `keyId`, which is how rotation stays non-destructive.
 */
export function auditSealKeyCandidates(): Buffer[] {
	const candidates: Buffer[] = [];
	const current = process.env.AUDIT_LOG_SIGNING_KEY;
	const previous = process.env.AUDIT_LOG_SIGNING_KEY_PREVIOUS;
	if (current && current.length > 0) {
		candidates.push(Buffer.from(current, "utf8"));
	}
	if (previous && previous.length > 0) {
		candidates.push(Buffer.from(previous, "utf8"));
	}
	const secret = process.env.BETTER_AUTH_SECRET;
	if (secret && secret.length > 0) {
		candidates.push(
			Buffer.from(
				hkdfSync(
					"sha256",
					Buffer.from(secret, "utf8"),
					Buffer.alloc(0),
					Buffer.from(SEAL_HKDF_INFO, "utf8"),
					32,
				),
			),
		);
	}
	return candidates;
}

/**
 * Stable, non-secret identifier for a key: `HMAC-SHA256:<first 16 hex of
 * sha256(key)>`. Truncated so it reveals nothing useful about the key while
 * still letting verification pick the right candidate among a small set.
 */
export function auditSealKeyId(key: Buffer): string {
	const fingerprint = createHash("sha256")
		.update(key)
		.digest("hex")
		.slice(0, 16);
	return `${AUDIT_SEAL_ALGORITHM}:${fingerprint}`;
}

/** The key to sign NEW seals with. Throws if no key material is configured. */
export function resolveSigningKey(): { key: Buffer; keyId: string } {
	const [key] = auditSealKeyCandidates();
	if (!key) {
		throw new Error(
			"Audit-log sealing requires a signing key: set AUDIT_LOG_SIGNING_KEY " +
				"(preferred) or BETTER_AUTH_SECRET.",
		);
	}
	return { key, keyId: auditSealKeyId(key) };
}

/** Resolve the key matching a recorded `keyId`; null if unavailable. */
export function resolveKeyById(keyId: string): Buffer | null {
	for (const candidate of auditSealKeyCandidates()) {
		if (auditSealKeyId(candidate) === keyId) {
			return candidate;
		}
	}
	return null;
}

/** HMAC-SHA256(sealHash) as lowercase hex. */
export function signSealHash(sealHash: string, key: Buffer): string {
	return createHmac("sha256", key).update(sealHash).digest("hex");
}

/** Constant-time hex-string comparison; false on any length/format mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	const bufA = Buffer.from(a, "hex");
	const bufB = Buffer.from(b, "hex");
	// Node's hex decoder silently stops at the first invalid nibble, so a
	// malformed string decodes short (e.g. "zz" -> empty). Reject anything that
	// did not decode to exactly length/2 bytes, so two equal but malformed hex
	// strings never compare equal.
	if (bufA.length !== a.length / 2 || bufB.length !== b.length / 2) {
		return false;
	}
	try {
		return timingSafeEqual(bufA, bufB);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Verification (pure)
// ---------------------------------------------------------------------------

export type SealFailureReason =
	| "CHAIN_BROKEN"
	| "SEQUENCE_GAP"
	| "CONTENT_TAMPERED"
	| "SEAL_TAMPERED"
	| "SIGNATURE_INVALID"
	| "KEY_UNAVAILABLE"
	| "UNSUPPORTED_VERSION";

export type SealVerdict =
	| { ok: true }
	| { ok: false; reason: SealFailureReason; detail?: string };

/**
 * Verify one seal given the ALREADY-recomputed content of its window. Split out
 * from {@link verifySeal} so a caller streaming a huge window (the genesis seal
 * covers all history) can fold rows through a {@link ContentHasher} and verify
 * with flat memory.
 *
 * Checks, in order (first failure wins):
 *   1. version supported
 *   2. chain link + sequence contiguity
 *   3. covered content matches (detects modified / inserted / deleted rows)
 *   4. seal header integrity (detects tampering of sequence / window / prev)
 *   5. signature valid under the recorded key (detects a forged seal row)
 */
export function verifySealAgainstContent(
	seal: StoredSeal,
	computed: { contentHash: string; rowCount: number },
	prevSeal: StoredSeal | null,
): SealVerdict {
	if (seal.version !== AUDIT_SEAL_VERSION) {
		return {
			ok: false,
			reason: "UNSUPPORTED_VERSION",
			detail: `seal version ${seal.version} != ${AUDIT_SEAL_VERSION}`,
		};
	}

	const expectedPrevHash = prevSeal ? prevSeal.sealHash : null;
	if ((seal.prevSealHash ?? null) !== expectedPrevHash) {
		return {
			ok: false,
			reason: "CHAIN_BROKEN",
			detail: prevSeal
				? `prevSealHash does not match seal #${prevSeal.sequence}`
				: "genesis seal must have a null prevSealHash",
		};
	}
	if (prevSeal && seal.sequence !== prevSeal.sequence + 1) {
		return {
			ok: false,
			reason: "SEQUENCE_GAP",
			detail: `sequence ${seal.sequence} does not follow ${prevSeal.sequence}`,
		};
	}

	if (
		computed.rowCount !== seal.rowCount ||
		computed.contentHash !== seal.contentHash
	) {
		return {
			ok: false,
			reason: "CONTENT_TAMPERED",
			detail: `expected ${seal.rowCount} rows, recomputed ${computed.rowCount}`,
		};
	}

	const recomputedSealHash = computeSealHash({
		sequence: seal.sequence,
		periodStart: seal.periodStart,
		periodEnd: seal.periodEnd,
		rowCount: seal.rowCount,
		contentHash: seal.contentHash,
		prevSealHash: seal.prevSealHash,
	});
	if (recomputedSealHash !== seal.sealHash) {
		return {
			ok: false,
			reason: "SEAL_TAMPERED",
			detail: "seal header does not hash to the stored sealHash",
		};
	}

	const key = resolveKeyById(seal.keyId);
	if (!key) {
		return {
			ok: false,
			reason: "KEY_UNAVAILABLE",
			detail: `no configured key matches keyId ${seal.keyId}`,
		};
	}
	if (!timingSafeEqualHex(signSealHash(seal.sealHash, key), seal.signature)) {
		return { ok: false, reason: "SIGNATURE_INVALID" };
	}

	return { ok: true };
}

/**
 * Verify one seal against the actual rows in its window and the previous seal.
 * `windowRows` MUST be every audit_log row whose `createdAt` is in
 * `[periodStart, periodEnd)`, ordered `createdAt` ASC then `id` ASC.
 */
export function verifySeal(
	seal: StoredSeal,
	windowRows: readonly SealableAuditRow[],
	prevSeal: StoredSeal | null,
): SealVerdict {
	return verifySealAgainstContent(
		seal,
		computeContentHash(windowRows),
		prevSeal,
	);
}

/** Build a fully-signed seal from its core header. Used by the sealing job. */
export function buildSignedSeal(core: SealCore): {
	sealHash: string;
	signature: string;
	keyId: string;
	version: string;
} {
	const sealHash = computeSealHash(core);
	const { key, keyId } = resolveSigningKey();
	return {
		sealHash,
		signature: signSealHash(sealHash, key),
		keyId,
		version: AUDIT_SEAL_VERSION,
	};
}

/** Epoch — the genesis seal's periodStart, so the first seal covers all history. */
export const AUDIT_SEAL_GENESIS_START = new Date(0);
