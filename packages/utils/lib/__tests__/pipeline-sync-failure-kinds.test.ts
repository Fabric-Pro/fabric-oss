/**
 * What a classified sync-failure kind MEANS — whose fault it is (log level)
 * and whether reconnecting the repository is a real fix. Card #2383.
 *
 * `@repo/temporal`'s `sync-failure-classification.ts` re-exports
 * `classificationForKind`/`classificationForRawKind` from this module for its
 * own callers and adds `classifySyncFailure` (which needs `ProviderHttpError`
 * and therefore stays on the temporal side); its own test pins the HTTP→kind
 * mapping. This test pins the table itself: `UNKNOWN` is the only `error`
 * severity, and `reconnectFixes` is true for exactly the two credential
 * kinds — never for a missing permission or an SSO requirement, which
 * reconnecting cannot fix.
 */

import { describe, expect, it } from "vitest";
import {
	classificationForKind,
	classificationForRawKind,
	type SyncFailureKind,
} from "../pipeline-sync-failure-kinds";

const ALL_KINDS: SyncFailureKind[] = [
	"CREDENTIAL_MISSING",
	"CREDENTIAL_REJECTED",
	"PERMISSION_MISSING",
	"SSO_REQUIRED",
	"RATE_LIMITED",
	"NOT_FOUND",
	"MISCONFIGURED",
	"UNKNOWN",
];

describe("classificationForKind", () => {
	it("returns itself as `kind` for every classification", () => {
		for (const kind of ALL_KINDS) {
			expect(classificationForKind(kind).kind).toBe(kind);
		}
	});

	it("is `warn` for every kind except UNKNOWN", () => {
		for (const kind of ALL_KINDS) {
			const expected = kind === "UNKNOWN" ? "error" : "warn";
			expect(classificationForKind(kind).severity, kind).toBe(expected);
		}
	});

	it("sets reconnectFixes ONLY for the two credential kinds", () => {
		const reconnectable = new Set<SyncFailureKind>([
			"CREDENTIAL_MISSING",
			"CREDENTIAL_REJECTED",
		]);
		for (const kind of ALL_KINDS) {
			expect(classificationForKind(kind).reconnectFixes, kind).toBe(
				reconnectable.has(kind),
			);
		}
	});

	it("never says reconnecting fixes a missing permission or SSO requirement", () => {
		expect(classificationForKind("PERMISSION_MISSING").reconnectFixes).toBe(
			false,
		);
		expect(classificationForKind("SSO_REQUIRED").reconnectFixes).toBe(
			false,
		);
	});
});

describe("classificationForRawKind", () => {
	it("matches classificationForKind for every recognized kind", () => {
		for (const kind of ALL_KINDS) {
			expect(classificationForRawKind(kind)).toEqual(
				classificationForKind(kind),
			);
		}
	});

	it("returns undefined for null, undefined, and an unrecognized string", () => {
		expect(classificationForRawKind(null)).toBeUndefined();
		expect(classificationForRawKind(undefined)).toBeUndefined();
		expect(classificationForRawKind("SOME_STALE_VALUE")).toBeUndefined();
		expect(classificationForRawKind("")).toBeUndefined();
	});

	it("does not throw on an object-prototype-shaped string (Object.hasOwn safety)", () => {
		// Regression guard: a naive `CLASSIFICATIONS[value]` lookup without
		// Object.hasOwn would resolve "toString"/"constructor" to inherited
		// Object.prototype members instead of returning undefined.
		expect(classificationForRawKind("toString")).toBeUndefined();
		expect(classificationForRawKind("constructor")).toBeUndefined();
	});
});
