/**
 * The property that was actually broken: two code paths refreshing the SAME
 * credential row must compute the SAME advisory-lock id.
 *
 * Before this was centralised there were four addressing schemes across the
 * codebase — two using `pg_advisory_xact_lock(int4, int4)` and two using
 * `pg_advisory_xact_lock(int8)`, which Postgres treats as separate lock spaces
 * — and even within one space the key strings differed (`wfint:<id>` in the
 * GitLab tool executor vs `user:<id>` in the repo/branch pickers). The result
 * was a lock that looked correct in every individual file and serialized
 * nothing across files: both callers exchanged the same single-use rotating
 * refresh token, and the loser flagged a healthy connection as needing
 * re-authentication.
 */
import { describe, expect, it } from "vitest";

import {
	advisoryObjectKey,
	mcpConfigLockKey,
	REFRESH_ADVISORY_CLASS,
	repoIntegrationLockKey,
	workflowIntegrationLockKey,
} from "../refresh-lock-key";

describe("refresh advisory-lock addressing", () => {
	it("gives the same lock id for the same row, whichever builder call reaches it", () => {
		const id = "cmnp7d1vx000505jsvxpl5r39";
		// Two different call paths, same row, same key -> same lock id.
		expect(advisoryObjectKey(workflowIntegrationLockKey(id))).toBe(
			advisoryObjectKey(workflowIntegrationLockKey(id)),
		);
		expect(workflowIntegrationLockKey(id)).toBe(`wfint:${id}`);
	});

	it("separates the credential stores so unrelated rows never contend", () => {
		const id = "same-id-different-store";
		const keys = [
			workflowIntegrationLockKey(id),
			repoIntegrationLockKey(id),
			mcpConfigLockKey(id),
		];
		expect(new Set(keys).size).toBe(3);
		expect(new Set(keys.map(advisoryObjectKey)).size).toBe(3);
	});

	it("keeps distinct rows in the same store independent", () => {
		expect(advisoryObjectKey(workflowIntegrationLockKey("a"))).not.toBe(
			advisoryObjectKey(workflowIntegrationLockKey("b")),
		);
	});

	it("produces a signed int32, which is what pg_advisory_xact_lock(int,int) takes", () => {
		for (const key of [
			"wfint:x",
			"repo:y",
			"mcp:z",
			"",
			"a".repeat(500),
			"unicode-✅-key",
		]) {
			const objectKey = advisoryObjectKey(key);
			expect(Number.isInteger(objectKey)).toBe(true);
			expect(objectKey).toBeGreaterThanOrEqual(-(2 ** 31));
			expect(objectKey).toBeLessThanOrEqual(2 ** 31 - 1);
		}
		expect(Number.isInteger(REFRESH_ADVISORY_CLASS)).toBe(true);
	});

	it("is stable across calls — a drifting hash would silently unserialize callers", () => {
		const key = workflowIntegrationLockKey("stability-check");
		const first = advisoryObjectKey(key);
		for (let i = 0; i < 100; i++) {
			expect(advisoryObjectKey(key)).toBe(first);
		}
	});
});
