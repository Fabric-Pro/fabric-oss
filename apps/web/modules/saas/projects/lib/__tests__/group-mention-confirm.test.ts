import { describe, expect, it } from "vitest";
import { evaluateLargeGroupConfirm } from "../group-mention-confirm";

const counts = { DEVELOPER: 12, ARCHITECT: 3 } as Record<string, number>;

describe("evaluateLargeGroupConfirm", () => {
	it("flags confirm when an addressed group exceeds the threshold", () => {
		const r = evaluateLargeGroupConfirm("ping @@developers", counts, 10);
		expect(r.needsConfirm).toBe(true);
		expect(r.maxCount).toBe(12);
	});
	it("no confirm when addressed groups are small", () => {
		expect(
			evaluateLargeGroupConfirm("@@architects", counts, 10).needsConfirm,
		).toBe(false);
	});
	it("no confirm when no groups are addressed", () => {
		expect(
			evaluateLargeGroupConfirm("hi @alice", counts, 10).needsConfirm,
		).toBe(false);
	});
});
