/**
 * The month a time report covers: its first and last day, across year ends
 * and February in leap and common years.
 */

import { monthRange, shiftMonth } from "@saas/time-tracking/lib/report-month";
import { describe, expect, it } from "vitest";

describe("monthRange", () => {
	it("covers the whole month that contains the date", () => {
		expect(monthRange("2026-11-11")).toEqual({
			from: "2026-11-01",
			to: "2026-11-30",
		});
		expect(monthRange("2026-10-01")).toEqual({
			from: "2026-10-01",
			to: "2026-10-31",
		});
	});

	it("ends December on the 31st", () => {
		expect(monthRange("2026-12-31")).toEqual({
			from: "2026-12-01",
			to: "2026-12-31",
		});
	});

	it("ends February on the 29th in a leap year and the 28th otherwise", () => {
		expect(monthRange("2028-02-10").to).toBe("2028-02-29");
		expect(monthRange("2026-02-10").to).toBe("2026-02-28");
		// Divisible by 100 but not 400: not a leap year.
		expect(monthRange("2100-02-10").to).toBe("2100-02-28");
	});

	it("refuses a date that does not exist", () => {
		expect(() => monthRange("2026-02-30")).toThrow(RangeError);
	});
});

describe("shiftMonth", () => {
	it("steps across a year end in both directions", () => {
		expect(shiftMonth(monthRange("2026-12-15"), 1)).toEqual({
			from: "2027-01-01",
			to: "2027-01-31",
		});
		expect(shiftMonth(monthRange("2027-01-15"), -1)).toEqual({
			from: "2026-12-01",
			to: "2026-12-31",
		});
	});

	it("lands on February's real last day", () => {
		expect(shiftMonth(monthRange("2028-01-31"), 1)).toEqual({
			from: "2028-02-01",
			to: "2028-02-29",
		});
		expect(shiftMonth(monthRange("2026-03-31"), -1).to).toBe("2026-02-28");
	});

	it("moves by more than a year", () => {
		expect(shiftMonth(monthRange("2026-11-11"), -14).from).toBe(
			"2025-09-01",
		);
	});
});
