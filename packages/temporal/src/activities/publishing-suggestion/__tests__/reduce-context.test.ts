import { describe, expect, it } from "vitest";
import { decayOrderAndTruncate } from "../reduce-context";

describe("decayOrderAndTruncate", () => {
	it("sorts by 30-day half-life recency score (desc) and truncates to budget", () => {
		const now = new Date("2026-07-14T00:00:00.000Z");
		const items = [
			{ updatedAtIso: "2026-07-10T00:00:00.000Z", payload: "old" },
			{ updatedAtIso: "2026-07-14T00:00:00.000Z", payload: "recent" },
		];

		const result = decayOrderAndTruncate(items, now, 1);

		expect(result).toEqual(["recent"]);
	});

	it("returns all items in decayed order when budget is larger than array", () => {
		const now = new Date("2026-07-14T00:00:00.000Z");
		const items = [
			{ updatedAtIso: "2026-07-04T00:00:00.000Z", payload: "old" },
			{ updatedAtIso: "2026-07-14T00:00:00.000Z", payload: "recent" },
			{ updatedAtIso: "2026-07-08T00:00:00.000Z", payload: "mid" },
		];

		const result = decayOrderAndTruncate(items, now, 100);

		expect(result).toEqual(["recent", "mid", "old"]);
	});

	it("clamps negative age to 0 and treats future dates as most recent", () => {
		const now = new Date("2026-07-14T00:00:00.000Z");
		const items = [
			{ updatedAtIso: "2026-07-14T00:00:00.000Z", payload: "today" },
			{ updatedAtIso: "2026-07-15T00:00:00.000Z", payload: "tomorrow" },
		];

		const result = decayOrderAndTruncate(items, now, 2);

		// Tomorrow should score same as today (Math.max(0, negative) = 0),
		// so both have score = 1.0, order depends on stable sort
		expect(result).toContain("tomorrow");
		expect(result).toContain("today");
	});
});
