import { describe, expect, it } from "vitest";
import { resolveLookbackWindow } from "../meeting-transcript-sync";

describe("resolveLookbackWindow", () => {
	const now = new Date("2026-07-03T12:00:00.000Z");

	it("defaults to 30 days", () => {
		expect(resolveLookbackWindow(undefined, now)).toEqual({
			daysBack: 30,
			startDate: "2026-06-03T12:00:00.000Z",
		});
	});

	it("honors an explicit window", () => {
		expect(resolveLookbackWindow(90, now)).toEqual({
			daysBack: 90,
			startDate: "2026-04-04T12:00:00.000Z",
		});
	});

	it("clamps to the 1–180 range", () => {
		expect(resolveLookbackWindow(0, now).daysBack).toBe(1);
		expect(resolveLookbackWindow(9999, now).daysBack).toBe(180);
	});
});
