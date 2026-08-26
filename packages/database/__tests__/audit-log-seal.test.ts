/**
 * Unit tests for the audit-log sealing crypto (`prisma/queries/audit-log-seal`).
 *
 * These are the correctness proof for the tamper-evidence feature: they exercise
 * canonicalization, per-row + window hashing, the FK-null tolerance that keeps a
 * legitimate org deletion from tripping a false alarm, key resolution + rotation,
 * and the full tamper matrix (modified / inserted / deleted row, broken chain,
 * sequence gap, forged header, forged signature, unavailable key). No database.
 *
 * Run with: pnpm --filter @repo/database test __tests__/audit-log-seal.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AUDIT_SEAL_GENESIS_START,
	auditSealKeyId,
	buildSignedSeal,
	ContentHasher,
	canonicalize,
	computeContentHash,
	hashAuditRow,
	resolveSigningKey,
	type SealableAuditRow,
	type SealCore,
	type StoredSeal,
	signSealHash,
	timingSafeEqualHex,
	verifySeal,
} from "../prisma/queries/audit-log-seal";

const EPOCH_ISO = AUDIT_SEAL_GENESIS_START.toISOString();
const KEY_A = "audit-signing-key-A-0123456789abcdef";
const KEY_B = "audit-signing-key-B-fedcba9876543210";

function row(overrides: Partial<SealableAuditRow> = {}): SealableAuditRow {
	return {
		id: "a1",
		createdAt: new Date("2026-07-03T10:00:00.000Z"),
		organizationId: "org1",
		userId: "user1",
		projectId: "proj1",
		actorType: "user",
		actorEmailSnapshot: "a@b.c",
		actorNameSnapshot: "Alice",
		impersonatedById: null,
		action: "auth.login.success",
		category: "auth",
		severity: "info",
		outcome: "success",
		resourceType: null,
		resourceId: null,
		resourceName: null,
		ipAddress: "1.2.3.4",
		userAgent: "UA/1.0",
		requestId: "req1",
		sessionId: "sess1",
		metadata: { foo: "bar", nested: { b: 2, a: 1 } },
		durationMs: 12,
		...overrides,
	};
}

/** Build a fully-signed StoredSeal from a core header (uses env key material). */
function sealFromCore(core: SealCore): StoredSeal {
	return { ...core, ...buildSignedSeal(core) };
}

/** Genesis seal covering `rows` (sequence 1, epoch start, null prev). */
function genesisSeal(
	rows: readonly SealableAuditRow[],
	periodEnd = "2026-07-03T12:00:00.000Z",
): StoredSeal {
	const { contentHash, rowCount } = computeContentHash(rows);
	return sealFromCore({
		sequence: 1,
		periodStart: EPOCH_ISO,
		periodEnd,
		rowCount,
		contentHash,
		prevSealHash: null,
	});
}

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {
		AUDIT_LOG_SIGNING_KEY: process.env.AUDIT_LOG_SIGNING_KEY,
		AUDIT_LOG_SIGNING_KEY_PREVIOUS:
			process.env.AUDIT_LOG_SIGNING_KEY_PREVIOUS,
		BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
	};
	// Default: a single dedicated key. Individual tests override as needed.
	process.env.AUDIT_LOG_SIGNING_KEY = KEY_A;
	delete process.env.AUDIT_LOG_SIGNING_KEY_PREVIOUS;
	delete process.env.BETTER_AUTH_SECRET;
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) {
			delete process.env[k];
		} else {
			process.env[k] = v;
		}
	}
});

describe("canonicalize", () => {
	it("is independent of object key insertion order", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
	});

	it("is independent of order in NESTED objects", () => {
		expect(canonicalize({ x: { d: 4, c: 3 } })).toBe(
			canonicalize({ x: { c: 3, d: 4 } }),
		);
	});

	it("preserves array order (arrays are ordered)", () => {
		expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
	});

	it("encodes Date as its ISO string", () => {
		const d = new Date("2026-01-02T03:04:05.678Z");
		expect(canonicalize({ at: d })).toBe(
			canonicalize({ at: "2026-01-02T03:04:05.678Z" }),
		);
	});

	it("distinguishes number 1 from string '1'", () => {
		expect(canonicalize({ v: 1 })).not.toBe(canonicalize({ v: "1" }));
	});
});

describe("hashAuditRow", () => {
	it("EXCLUDES the three nullable FK columns (org/user/project)", () => {
		// The crux: nulling or changing organizationId/userId/projectId — the only
		// mutations the WORM trigger permits — must NOT change a row's hash, or a
		// legitimate org/user deletion would falsely 'break' every prior seal.
		const base = hashAuditRow(row());
		expect(
			hashAuditRow(
				row({ organizationId: null, userId: null, projectId: null }),
			),
		).toBe(base);
		expect(
			hashAuditRow(
				row({ organizationId: "other", userId: "x", projectId: "y" }),
			),
		).toBe(base);
	});

	it("changes when any SEALED field changes", () => {
		const base = hashAuditRow(row());
		expect(hashAuditRow(row({ action: "auth.login.failure" }))).not.toBe(
			base,
		);
		expect(hashAuditRow(row({ outcome: "failure" }))).not.toBe(base);
		expect(hashAuditRow(row({ metadata: { foo: "baz" } }))).not.toBe(base);
		expect(hashAuditRow(row({ durationMs: 13 }))).not.toBe(base);
		expect(hashAuditRow(row({ id: "a2" }))).not.toBe(base);
	});

	it("treats a missing sealed field as null", () => {
		expect(hashAuditRow(row({ resourceType: undefined }))).toBe(
			hashAuditRow(row({ resourceType: null })),
		);
	});

	it("is insensitive to metadata key order", () => {
		expect(hashAuditRow(row({ metadata: { a: 1, b: 2 } }))).toBe(
			hashAuditRow(row({ metadata: { b: 2, a: 1 } })),
		);
	});
});

describe("content hashing", () => {
	it("depends on row order", () => {
		const r1 = row({ id: "a1" });
		const r2 = row({ id: "a2" });
		expect(computeContentHash([r1, r2]).contentHash).not.toBe(
			computeContentHash([r2, r1]).contentHash,
		);
	});

	it("produces a stable, non-empty hash for an empty window", () => {
		const a = computeContentHash([]);
		const b = computeContentHash([]);
		expect(a.rowCount).toBe(0);
		expect(a.contentHash).toBe(b.contentHash);
		expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("streaming via ContentHasher equals the array helper", () => {
		const rows = [row({ id: "a1" }), row({ id: "a2" }), row({ id: "a3" })];
		const hasher = new ContentHasher();
		for (const r of rows) {
			hasher.update(r);
		}
		expect(hasher.digest()).toEqual(computeContentHash(rows));
	});

	it("counts rows", () => {
		expect(computeContentHash([row(), row({ id: "a2" })]).rowCount).toBe(2);
	});
});

describe("key management", () => {
	it("prefers the dedicated key over the derived fallback", () => {
		process.env.AUDIT_LOG_SIGNING_KEY = KEY_A;
		process.env.BETTER_AUTH_SECRET = "some-auth-secret";
		const { keyId } = resolveSigningKey();
		expect(keyId).toBe(auditSealKeyId(Buffer.from(KEY_A, "utf8")));
	});

	it("derives a key from BETTER_AUTH_SECRET when no dedicated key is set", () => {
		delete process.env.AUDIT_LOG_SIGNING_KEY;
		process.env.BETTER_AUTH_SECRET = "some-auth-secret";
		const { keyId } = resolveSigningKey();
		// Not the raw secret's fingerprint — it's HKDF-derived (domain separated).
		expect(keyId).not.toBe(
			auditSealKeyId(Buffer.from("some-auth-secret", "utf8")),
		);
		expect(keyId).toMatch(/^HMAC-SHA256:[0-9a-f]{16}$/);
	});

	it("throws when no key material is configured", () => {
		delete process.env.AUDIT_LOG_SIGNING_KEY;
		delete process.env.BETTER_AUTH_SECRET;
		expect(() => resolveSigningKey()).toThrow(/signing key/i);
	});

	it("gives distinct keyIds to distinct keys", () => {
		expect(auditSealKeyId(Buffer.from(KEY_A))).not.toBe(
			auditSealKeyId(Buffer.from(KEY_B)),
		);
	});
});

describe("timingSafeEqualHex", () => {
	it("true for equal hex, false for different or malformed", () => {
		expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
		expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
		expect(timingSafeEqualHex("abcd", "ab")).toBe(false);
		expect(timingSafeEqualHex("zz", "zz")).toBe(false); // not valid hex
	});
});

describe("verifySeal — happy paths", () => {
	it("verifies a genesis seal", () => {
		const rows = [row({ id: "a1" }), row({ id: "a2" })];
		expect(verifySeal(genesisSeal(rows), rows, null)).toEqual({ ok: true });
	});

	it("verifies a two-link chain", () => {
		const rows1 = [row({ id: "a1" })];
		const s1 = genesisSeal(rows1, "2026-07-03T11:00:00.000Z");
		const rows2 = [
			row({ id: "a2", createdAt: new Date("2026-07-03T11:30:00.000Z") }),
		];
		const { contentHash, rowCount } = computeContentHash(rows2);
		const s2 = sealFromCore({
			sequence: 2,
			periodStart: "2026-07-03T11:00:00.000Z",
			periodEnd: "2026-07-03T12:00:00.000Z",
			rowCount,
			contentHash,
			prevSealHash: s1.sealHash,
		});
		expect(verifySeal(s1, rows1, null)).toEqual({ ok: true });
		expect(verifySeal(s2, rows2, s1)).toEqual({ ok: true });
	});

	it("TOLERATES the covered rows' FK columns being nulled after sealing", () => {
		// Seal with FKs populated, then verify after an org/user/project delete
		// nulled them. This is the false-positive guard that matters most.
		const rows = [row({ id: "a1" }), row({ id: "a2" })];
		const s = genesisSeal(rows);
		const afterOrgDelete = rows.map((r) => ({
			...r,
			organizationId: null,
			userId: null,
			projectId: null,
		}));
		expect(verifySeal(s, afterOrgDelete, null)).toEqual({ ok: true });
	});

	it("round-trips buildSignedSeal → verify", () => {
		const rows = [row()];
		const s = genesisSeal(rows);
		// Signature is a real HMAC over the sealHash under the configured key.
		expect(s.signature).toBe(
			signSealHash(s.sealHash, Buffer.from(KEY_A, "utf8")),
		);
		expect(verifySeal(s, rows, null).ok).toBe(true);
	});
});

describe("verifySeal — tamper matrix", () => {
	it("detects a MODIFIED covered row", () => {
		const rows = [row({ id: "a1" }), row({ id: "a2" })];
		const s = genesisSeal(rows);
		const tampered = [
			rows[0],
			{ ...rows[1], action: "auth.login.failure" },
		];
		expect(verifySeal(s, tampered, null)).toMatchObject({
			ok: false,
			reason: "CONTENT_TAMPERED",
		});
	});

	it("detects a DELETED covered row", () => {
		const rows = [row({ id: "a1" }), row({ id: "a2" })];
		const s = genesisSeal(rows);
		expect(verifySeal(s, [rows[0]], null)).toMatchObject({
			ok: false,
			reason: "CONTENT_TAMPERED",
		});
	});

	it("detects an INSERTED row", () => {
		const rows = [row({ id: "a1" })];
		const s = genesisSeal(rows);
		const withInsert = [...rows, row({ id: "a2" })];
		expect(verifySeal(s, withInsert, null)).toMatchObject({
			ok: false,
			reason: "CONTENT_TAMPERED",
		});
	});

	it("detects a BROKEN chain link", () => {
		const rows1 = [row({ id: "a1" })];
		const s1 = genesisSeal(rows1, "2026-07-03T11:00:00.000Z");
		const rows2 = [row({ id: "a2" })];
		const { contentHash, rowCount } = computeContentHash(rows2);
		const s2 = sealFromCore({
			sequence: 2,
			periodStart: "2026-07-03T11:00:00.000Z",
			periodEnd: "2026-07-03T12:00:00.000Z",
			rowCount,
			contentHash,
			prevSealHash: "deadbeef".repeat(8), // wrong
		});
		expect(verifySeal(s2, rows2, s1)).toMatchObject({
			ok: false,
			reason: "CHAIN_BROKEN",
		});
	});

	it("flags the genesis seal if its prevSealHash is not null", () => {
		const rows = [row()];
		const { contentHash, rowCount } = computeContentHash(rows);
		const bad = sealFromCore({
			sequence: 1,
			periodStart: EPOCH_ISO,
			periodEnd: "2026-07-03T12:00:00.000Z",
			rowCount,
			contentHash,
			prevSealHash: "0".repeat(64),
		});
		expect(verifySeal(bad, rows, null)).toMatchObject({
			ok: false,
			reason: "CHAIN_BROKEN",
		});
	});

	it("detects a SEQUENCE gap", () => {
		const rows1 = [row({ id: "a1" })];
		const s1 = genesisSeal(rows1, "2026-07-03T11:00:00.000Z");
		const rows2 = [row({ id: "a2" })];
		const { contentHash, rowCount } = computeContentHash(rows2);
		const s3 = sealFromCore({
			sequence: 3, // skips 2
			periodStart: "2026-07-03T11:00:00.000Z",
			periodEnd: "2026-07-03T12:00:00.000Z",
			rowCount,
			contentHash,
			prevSealHash: s1.sealHash,
		});
		expect(verifySeal(s3, rows2, s1)).toMatchObject({
			ok: false,
			reason: "SEQUENCE_GAP",
		});
	});

	it("detects a TAMPERED seal header (window edited, sealHash not)", () => {
		const rows = [row()];
		const s = genesisSeal(rows);
		const forged: StoredSeal = {
			...s,
			periodEnd: "2099-01-01T00:00:00.000Z",
		};
		expect(verifySeal(forged, rows, null)).toMatchObject({
			ok: false,
			reason: "SEAL_TAMPERED",
		});
	});

	it("detects a FORGED signature", () => {
		const rows = [row()];
		const s = genesisSeal(rows);
		const forged: StoredSeal = { ...s, signature: "00".repeat(32) };
		expect(verifySeal(forged, rows, null)).toMatchObject({
			ok: false,
			reason: "SIGNATURE_INVALID",
		});
	});

	it("rejects an unsupported seal version", () => {
		const rows = [row()];
		const s = genesisSeal(rows);
		const future: StoredSeal = { ...s, version: "v999" };
		expect(verifySeal(future, rows, null)).toMatchObject({
			ok: false,
			reason: "UNSUPPORTED_VERSION",
		});
	});
});

describe("verifySeal — key rotation", () => {
	it("still verifies a seal signed with the PREVIOUS key after rotation", () => {
		// Sign under KEY_A.
		process.env.AUDIT_LOG_SIGNING_KEY = KEY_A;
		const rows = [row()];
		const s = genesisSeal(rows);
		// Rotate: KEY_B current, KEY_A demoted to previous.
		process.env.AUDIT_LOG_SIGNING_KEY = KEY_B;
		process.env.AUDIT_LOG_SIGNING_KEY_PREVIOUS = KEY_A;
		expect(verifySeal(s, rows, null)).toEqual({ ok: true });
	});

	it("reports KEY_UNAVAILABLE when the signing key is gone", () => {
		process.env.AUDIT_LOG_SIGNING_KEY = KEY_A;
		const rows = [row()];
		const s = genesisSeal(rows);
		// KEY_A no longer configured anywhere.
		process.env.AUDIT_LOG_SIGNING_KEY = KEY_B;
		delete process.env.AUDIT_LOG_SIGNING_KEY_PREVIOUS;
		delete process.env.BETTER_AUTH_SECRET;
		expect(verifySeal(s, rows, null)).toMatchObject({
			ok: false,
			reason: "KEY_UNAVAILABLE",
		});
	});

	it("verifies a derived-key seal when the same BETTER_AUTH_SECRET is present", () => {
		delete process.env.AUDIT_LOG_SIGNING_KEY;
		process.env.BETTER_AUTH_SECRET = "shared-auth-secret";
		const rows = [row()];
		const s = genesisSeal(rows);
		expect(verifySeal(s, rows, null)).toEqual({ ok: true });
	});
});
