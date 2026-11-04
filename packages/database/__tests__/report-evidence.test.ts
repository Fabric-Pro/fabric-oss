import { describe, expect, it } from "vitest";
import {
	assertPublicReportParameters,
	buildReportExecutionSnapshot,
	computeReportEvidenceWindow,
	reportEvidenceConfigSchema,
} from "../prisma/queries/lib/report-evidence";

const config = (overrides = {}) =>
	reportEvidenceConfigSchema.parse({
		version: 1,
		period: "quarterly",
		...overrides,
	});
describe("report evidence boundaries, independent from recurrence", () => {
	it("uses the last complete calendar quarter and a separate prior-period baseline", () => {
		expect(
			computeReportEvidenceWindow(
				config({ comparison: "previous_period" }),
				new Date("2026-11-02T14:00:00Z"),
			),
		).toEqual({
			start: "2026-07-01T00:00:00.000Z",
			end: "2026-10-01T00:00:00.000Z",
			cutoff: "2026-11-02T14:00:00.000Z",
			timezone: "UTC",
			comparison: {
				start: "2026-04-01T00:00:00.000Z",
				end: "2026-07-01T00:00:00.000Z",
			},
		});
	});
	it("aligns a fiscal quarter across year boundaries", () => {
		const window = computeReportEvidenceWindow(
			config({ calendar: "fiscal", fiscalYearStartMonth: 2 }),
			new Date("2026-02-01T00:00:00Z"),
		);
		expect([window.start, window.end]).toEqual([
			"2025-11-01T00:00:00.000Z",
			"2026-02-01T00:00:00.000Z",
		]);
	});
	it("uses local midnight over the DST spring transition (23-hour evidence day)", () => {
		const window = computeReportEvidenceWindow(
			config({ period: "daily", timezone: "America/New_York" }),
			new Date("2026-03-09T13:00:00Z"),
		);
		expect([window.start, window.end]).toEqual([
			"2026-03-08T05:00:00.000Z",
			"2026-03-09T04:00:00.000Z",
		]);
	});
	it("uses local midnight over the DST fall transition (25-hour evidence day)", () => {
		const window = computeReportEvidenceWindow(
			config({ period: "daily", timezone: "America/New_York" }),
			new Date("2026-11-02T13:00:00Z"),
		);
		expect(
			(Date.parse(window.end) - Date.parse(window.start)) / 3600000,
		).toBe(25);
	});
	it("covers leap February and previous-year baseline without month-end drift", () => {
		const window = computeReportEvidenceWindow(
			config({ period: "monthly", comparison: "previous_year" }),
			new Date("2024-03-01T00:00:00Z"),
		);
		expect([
			window.start,
			window.end,
			window.comparison?.start,
			window.comparison?.end,
		]).toEqual([
			"2024-02-01T00:00:00.000Z",
			"2024-03-01T00:00:00.000Z",
			"2023-02-01T00:00:00.000Z",
			"2023-03-01T00:00:00.000Z",
		]);
	});
	it("honors weekly boundaries and does not use a quarterly recurrence anchor as evidence", () => {
		const window = computeReportEvidenceWindow(
			config({ period: "weekly", weekStartsOn: 0 }),
			new Date("2026-11-02T13:00:00Z"),
		);
		expect([window.start, window.end]).toEqual([
			"2026-10-25T00:00:00.000Z",
			"2026-11-01T00:00:00.000Z",
		]);
	});
	it("rejects unsupported versions, invalid zones, unknown audience fields and reserved parameters", () => {
		for (const value of [
			{ version: 2, period: "daily" },
			{ version: 1, period: "daily", timezone: "bad/zone" },
			{ version: 1, period: "daily", organizationId: "other-org" },
		]) {
			expect(reportEvidenceConfigSchema.safeParse(value).success).toBe(
				false,
			);
		}
		expect(() =>
			assertPublicReportParameters({ __fabricReportExecution: {} }),
		).toThrow("Reserved");
	});
	it("bounds admitted configuration and rejects poisoned parameter defaults", () => {
		const input = {
			instance: {
				id: "report-1",
				name: "Delivery",
				templateId: "template-1",
				connections: {},
				template: {},
			},
			organizationId: "org-1",
			userId: "user-1",
			occurrenceAt: new Date("2026-11-02T00:00:00Z"),
			origin: "scheduled" as const,
		};
		expect(buildReportExecutionSnapshot(input).organizationId).toBe(
			"org-1",
		);
		expect(() =>
			buildReportExecutionSnapshot({
				...input,
				instance: {
					...input.instance,
					parameterDefaults: { __fabricReportExecution: {} },
				},
			}),
		).toThrow("Reserved");
		expect(() =>
			buildReportExecutionSnapshot({
				...input,
				instance: {
					...input.instance,
					template: { description: "x".repeat(128001) },
				},
			}),
		).toThrow("snapshot limit");
	});
});
