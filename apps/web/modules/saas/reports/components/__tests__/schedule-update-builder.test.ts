import { describe, expect, it } from "vitest";
import { buildScheduleUpdate } from "../schedule-update-builder";

const base = {
	frequency: "weekly" as const,
	dayOfWeek: 1,
	dayOfMonth: 1,
	hour: 9,
	minute: 0,
	timezone: "UTC",
};

describe("buildScheduleUpdate", () => {
	it("returns undefined when not dirty", () => {
		expect(
			buildScheduleUpdate({ dirty: false, mode: "OFF", ...base }),
		).toBeUndefined();
	});

	it("returns {mode:'off'} when dirty and OFF", () => {
		expect(
			buildScheduleUpdate({ dirty: true, mode: "OFF", ...base }),
		).toEqual({ mode: "off" });
	});

	it("returns {mode:'inherit'} when dirty and INHERITED", () => {
		expect(
			buildScheduleUpdate({ dirty: true, mode: "INHERITED", ...base }),
		).toEqual({ mode: "inherit" });
	});

	it("includes dayOfWeek for weekly frequency", () => {
		const result = buildScheduleUpdate({
			dirty: true,
			mode: "CUSTOM",
			frequency: "weekly",
			dayOfWeek: 2,
			dayOfMonth: 1,
			hour: 9,
			minute: 0,
			timezone: "UTC",
		});
		expect(result).toEqual({
			mode: "custom",
			schedule: {
				frequency: "weekly",
				dayOfWeek: 2,
				hour: 9,
				minute: 0,
				timezone: "UTC",
			},
		});
	});

	it("includes dayOfMonth for monthly frequency", () => {
		const result = buildScheduleUpdate({
			dirty: true,
			mode: "CUSTOM",
			frequency: "monthly",
			dayOfWeek: 1,
			dayOfMonth: 15,
			hour: 9,
			minute: 0,
			timezone: "UTC",
		});
		expect(result).toEqual({
			mode: "custom",
			schedule: {
				frequency: "monthly",
				dayOfMonth: 15,
				hour: 9,
				minute: 0,
				timezone: "UTC",
			},
		});
	});

	it("includes dayOfWeek for biweekly frequency", () => {
		const result = buildScheduleUpdate({
			dirty: true,
			mode: "CUSTOM",
			frequency: "biweekly",
			dayOfWeek: 5,
			dayOfMonth: 1,
			hour: 8,
			minute: 30,
			timezone: "Europe/Berlin",
		});
		expect(result).toEqual({
			mode: "custom",
			schedule: {
				frequency: "biweekly",
				dayOfWeek: 5,
				hour: 8,
				minute: 30,
				timezone: "Europe/Berlin",
			},
		});
	});

	it("includes dayOfMonth for quarterly frequency", () => {
		const result = buildScheduleUpdate({
			dirty: true,
			mode: "CUSTOM",
			frequency: "quarterly",
			dayOfWeek: 1,
			dayOfMonth: 1,
			hour: 6,
			minute: 0,
			timezone: "America/New_York",
		});
		expect(result).toEqual({
			mode: "custom",
			schedule: {
				frequency: "quarterly",
				dayOfMonth: 1,
				hour: 6,
				minute: 0,
				timezone: "America/New_York",
			},
		});
	});

	it("does not include day fields for daily frequency", () => {
		const result = buildScheduleUpdate({
			dirty: true,
			mode: "CUSTOM",
			frequency: "daily",
			dayOfWeek: 1,
			dayOfMonth: 1,
			hour: 7,
			minute: 0,
			timezone: "UTC",
		});
		expect(result).toEqual({
			mode: "custom",
			schedule: {
				frequency: "daily",
				hour: 7,
				minute: 0,
				timezone: "UTC",
			},
		});
	});
});
