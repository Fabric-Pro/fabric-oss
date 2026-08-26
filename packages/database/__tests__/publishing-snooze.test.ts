import { describe, expect, it } from "vitest";
import {
	PUBLISHING_SNOOZE_PRESETS,
	resolvePublishingSnoozeUntil,
} from "../src/publishing-snooze";

describe("resolvePublishingSnoozeUntil", () => {
	it("offers exactly the three presets FR6 allows", () => {
		expect(PUBLISHING_SNOOZE_PRESETS).toEqual([
			"ONE_WEEK",
			"ONE_MONTH",
			"THREE_MONTHS",
		]);
	});

	it("adds seven days for ONE_WEEK", () => {
		const now = new Date("2026-03-10T08:30:00.000Z");
		expect(
			resolvePublishingSnoozeUntil("ONE_WEEK", now).toISOString(),
		).toBe("2026-03-17T08:30:00.000Z");
	});

	it("adds one and three calendar months", () => {
		const now = new Date("2026-03-10T08:30:00.000Z");
		expect(
			resolvePublishingSnoozeUntil("ONE_MONTH", now).toISOString(),
		).toBe("2026-04-10T08:30:00.000Z");
		expect(
			resolvePublishingSnoozeUntil("THREE_MONTHS", now).toISOString(),
		).toBe("2026-06-10T08:30:00.000Z");
	});

	// The case naive setUTCMonth arithmetic gets wrong: Jan 31 + 1 month would
	// overflow into March 3 rather than clamping to the end of February.
	it("clamps to the last day when the target month is shorter", () => {
		const now = new Date("2026-01-31T12:00:00.000Z");
		expect(
			resolvePublishingSnoozeUntil("ONE_MONTH", now).toISOString(),
		).toBe("2026-02-28T12:00:00.000Z");
	});

	it("does not mutate the caller's date", () => {
		const now = new Date("2026-03-10T08:30:00.000Z");
		resolvePublishingSnoozeUntil("THREE_MONTHS", now);
		expect(now.toISOString()).toBe("2026-03-10T08:30:00.000Z");
	});
});
