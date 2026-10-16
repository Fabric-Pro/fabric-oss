import { describe, expect, it } from "vitest";
import { minimumCronIntervalMinutes } from "../cron-interval";

describe("minimumCronIntervalMinutes", () => {
	it.each([
		["* * * * *", 1],
		["*/5 * * * *", 5],
		["*/15 * * * *", 15],
		["0 * * * *", 60],
		["0 9 * * *", 24 * 60],
		["0 9 * * 1", 7 * 24 * 60],
	])("measures %s as %s minutes", (cron, minutes) => {
		expect(minimumCronIntervalMinutes(cron)).toBe(minutes);
	});

	it("finds the shortest gap in an uneven pattern", () => {
		expect(minimumCronIntervalMinutes("0,10 9 * * *")).toBe(10);
		expect(minimumCronIntervalMinutes("0 9 * * 1,2")).toBe(24 * 60);
	});

	it("reads Temporal's sixth field as a year, not as seconds", () => {
		expect(minimumCronIntervalMinutes("0 9 * * 1 2030")).toBe(7 * 24 * 60);
	});

	it("treats a schedule that fires once in years as having no short interval", () => {
		expect(minimumCronIntervalMinutes("0 0 29 2 *")).toBeGreaterThanOrEqual(
			365 * 24 * 60,
		);
	});

	it("returns null for an expression it cannot evaluate", () => {
		expect(minimumCronIntervalMinutes("99 * * * *")).toBeNull();
		expect(minimumCronIntervalMinutes("every morning")).toBeNull();
		expect(minimumCronIntervalMinutes("")).toBeNull();
	});
});
