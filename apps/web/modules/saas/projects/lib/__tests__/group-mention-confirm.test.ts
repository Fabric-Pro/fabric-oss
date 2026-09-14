import { describe, expect, it } from "vitest";
import {
	evaluateLargeGroupConfirm,
	LARGE_GROUP_THRESHOLD,
} from "../group-mention-confirm";

const counts = { DEVELOPER: 12, ARCHITECT: 3 } as Record<string, number>;

describe("LARGE_GROUP_THRESHOLD", () => {
	/**
	 * Fixture for Fix 4 (Fizzy #2457 follow-up): the CLI-connection ask's own
	 * confirmation threshold (`LARGE_ASK_THRESHOLD` in
	 * `@saas/projects/components/cli-connection/lib/cli-connection-nudge`) now
	 * imports this constant rather than restating the number ten. Exporting it
	 * with a value other than ten would silently change BOTH surfaces' behavior
	 * at once — this pins the number the two now share.
	 */
	it("is exported as ten, the number the CLI-connection ask now shares", () => {
		expect(LARGE_GROUP_THRESHOLD).toBe(10);
	});
});

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
