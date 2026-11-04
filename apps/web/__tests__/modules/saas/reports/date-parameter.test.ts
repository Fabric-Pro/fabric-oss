import {
	classifyDateParameter,
	findPeriodPreset,
	formatPeriodRange,
	getPeriodPresets,
	isDateParameter,
	parameterNameWords,
	parsePeriodRange,
} from "@saas/reports/lib/date-parameter";
import { describe, expect, it } from "vitest";

describe("parameterNameWords", () => {
	it("splits camelCase, snake_case and kebab-case names", () => {
		expect(parameterNameWords("startDate")).toEqual(["start", "date"]);
		expect(parameterNameWords("updated_at")).toEqual(["updated", "at"]);
		expect(parameterNameWords("report-period")).toEqual([
			"report",
			"period",
		]);
		expect(parameterNameWords("ISODate")).toEqual(["iso", "date"]);
	});
});

describe("classifyDateParameter", () => {
	it("trusts an explicit date format whatever the name", () => {
		expect(classifyDateParameter("format", { format: "date" })).toBe(
			"date",
		);
		expect(classifyDateParameter("value", { format: "date-time" })).toBe(
			"date",
		);
	});

	it.each([
		"startDate",
		"endDate",
		"dueDate",
		"deadline",
		"createdAt",
		"updated_at",
		"since",
		"until",
		"from",
		"to",
		"start",
		"end",
	])("treats %s as a date", (name) => {
		expect(classifyDateParameter(name, {})).toBe("date");
	});

	it.each([
		"period",
		"reportPeriod",
		"periodStart",
		"period_end",
		"timeframe",
		"dateRange",
	])("treats %s as a reporting period", (name) => {
		expect(classifyDateParameter(name, {})).toBe("period");
	});

	// Names the old substring heuristic took for dates.
	it.each([
		"format",
		"trend",
		"backend",
		"frontend",
		"chat",
		"repeat",
		"endpoint",
		"sendTo",
		"assignedTo",
		"replyTo",
		"startWith",
		"startIndex",
		"projectName",
	])("does not treat %s as a date", (name) => {
		expect(classifyDateParameter(name, {})).toBeNull();
		expect(isDateParameter(name, {})).toBe(false);
	});
});

describe("getPeriodPresets", () => {
	it("offers the relative presets, without Current sprint by default", () => {
		const labels = getPeriodPresets({}).map((p) => p.label);
		expect(labels).toEqual([
			"Last 7 days",
			"Last 2 weeks",
			"Last 30 days",
			"This month",
			"Last month",
			"This quarter",
		]);
	});

	it("offers Current sprint where the template speaks of sprints", () => {
		const fromDescription = getPeriodPresets({
			description: "e.g. 'Sprint 42', 'Last 2 weeks', 'March 2026'",
		});
		expect(fromDescription.map((p) => p.id)).toContain("current-sprint");

		const fromDefault = getPeriodPresets({ default: "Current Sprint" });
		expect(fromDefault.map((p) => p.id)).toContain("current-sprint");
	});

	it("stores each preset as the text the report reads", () => {
		const presets = getPeriodPresets({ description: "sprint" });
		const values = Object.fromEntries(presets.map((p) => [p.id, p.value]));
		expect(values["last-2-weeks"]).toBe("Last 2 weeks");
		expect(values["current-sprint"]).toBe("Current Sprint");
		expect(values["this-quarter"]).toBe("This quarter");
	});
});

describe("findPeriodPreset", () => {
	const presets = getPeriodPresets({ description: "sprint" });

	it("matches a stored value regardless of case and surrounding space", () => {
		expect(findPeriodPreset(presets, "  current sprint ")?.id).toBe(
			"current-sprint",
		);
		expect(findPeriodPreset(presets, "Last 7 days")?.id).toBe(
			"last-7-days",
		);
	});

	it("matches nothing for free text or a custom range", () => {
		expect(findPeriodPreset(presets, "Sprint 42")).toBeUndefined();
		expect(
			findPeriodPreset(presets, "2026-03-01 to 2026-03-31"),
		).toBeUndefined();
	});
});

describe("period ranges", () => {
	it("formats a range as two ISO days and parses it back", () => {
		const value = formatPeriodRange(
			new Date(2026, 2, 1),
			new Date(2026, 2, 31),
		);
		expect(value).toBe("2026-03-01 to 2026-03-31");

		const range = parsePeriodRange(value);
		expect(range?.from.getFullYear()).toBe(2026);
		expect(range?.from.getMonth()).toBe(2);
		expect(range?.from.getDate()).toBe(1);
		expect(range?.to.getDate()).toBe(31);
	});

	it("parses nothing that is not a range", () => {
		expect(parsePeriodRange("Last 2 weeks")).toBeNull();
		expect(parsePeriodRange("2026-03-01")).toBeNull();
		expect(parsePeriodRange("")).toBeNull();
	});
});
