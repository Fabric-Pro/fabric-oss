/**
 * `deriveIdempotentRunId` — the pure id derivation behind a dispatch's
 * idempotency key (Fizzy #2233 follow-up).
 *
 * What matters is the property, not the exact digits: SAME triple always
 * produces the SAME id, and a different project or a different user turns
 * the SAME key into a DIFFERENT id — that is what stops one caller's key
 * from ever addressing another caller's run.
 */

import { describe, expect, it } from "vitest";
import { deriveIdempotentRunId } from "../agentic-run-idempotency";

const BASE = {
	projectId: "proj-1",
	userId: "user-1",
	idempotencyKey: "11111111-1111-1111-1111-111111111111",
};

describe("deriveIdempotentRunId", () => {
	it("is stable for the same (project, user, key) triple", () => {
		expect(deriveIdempotentRunId(BASE)).toBe(deriveIdempotentRunId(BASE));
	});

	it("matches a cuid's shape: 25 lowercase alphanumeric characters starting with 'c'", () => {
		const id = deriveIdempotentRunId(BASE);
		expect(id).toHaveLength(25);
		expect(id).toMatch(/^c[a-z0-9]{24}$/);
	});

	it("produces a different id for a different project", () => {
		expect(deriveIdempotentRunId(BASE)).not.toBe(
			deriveIdempotentRunId({ ...BASE, projectId: "proj-2" }),
		);
	});

	it("produces a different id for a different user — the SAME key cannot address another user's run", () => {
		expect(deriveIdempotentRunId(BASE)).not.toBe(
			deriveIdempotentRunId({ ...BASE, userId: "user-2" }),
		);
	});

	it("produces a different id for a different idempotency key", () => {
		expect(deriveIdempotentRunId(BASE)).not.toBe(
			deriveIdempotentRunId({
				...BASE,
				idempotencyKey: "22222222-2222-2222-2222-222222222222",
			}),
		);
	});

	it("does not let concatenation ambiguity collide two different triples", () => {
		// Without a separator, ("ab", "c") and ("a", "bc") would hash the same
		// way. The null-byte join must keep them apart.
		const a = deriveIdempotentRunId({
			projectId: "ab",
			userId: "c",
			idempotencyKey: "k",
		});
		const b = deriveIdempotentRunId({
			projectId: "a",
			userId: "bc",
			idempotencyKey: "k",
		});
		expect(a).not.toBe(b);
	});
});
