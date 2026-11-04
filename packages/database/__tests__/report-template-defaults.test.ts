import { describe, expect, it } from "vitest";
import { mergeReportTemplateOverrides } from "../prisma/queries/lib/report-template-defaults";

describe("mergeReportTemplateOverrides", () => {
	it("takes project values over organization values, key by key", () => {
		const merged = mergeReportTemplateOverrides(
			{
				parameterDefaults: { team: "Org team", period: "weekly" },
				context: { boardName: "Org board", teamName: "Org team" },
				schedule: { frequency: "monthly", dayOfMonth: 1 },
			},
			{
				parameterDefaults: { team: "Project team" },
				context: { boardName: "Project board" },
				schedule: { frequency: "weekly", dayOfWeek: 1 },
			},
		);

		expect(merged).toEqual({
			parameterDefaults: { team: "Project team", period: "weekly" },
			context: { boardName: "Project board", teamName: "Org team" },
			schedule: { frequency: "weekly", dayOfWeek: 1 },
		});
	});

	it("falls back to the organization's schedule when the project sets none", () => {
		const merged = mergeReportTemplateOverrides(
			{
				parameterDefaults: null,
				context: null,
				schedule: { frequency: "daily" },
			},
			{ parameterDefaults: null, context: null, schedule: null },
		);

		expect(merged.schedule).toEqual({ frequency: "daily" });
	});

	it("leaves everything to the template when neither scope sets anything", () => {
		expect(mergeReportTemplateOverrides(null, null)).toEqual({
			parameterDefaults: {},
			context: {},
			schedule: undefined,
		});
	});

	it("drops values a report cannot hold", () => {
		const merged = mergeReportTemplateOverrides(
			{
				parameterDefaults: {
					team: "Example",
					nested: { a: 1 },
					size: 3,
				},
				context: { boardName: "Example", count: 2 },
				schedule: null,
			},
			null,
		);

		expect(merged.parameterDefaults).toEqual({ team: "Example", size: 3 });
		expect(merged.context).toEqual({ boardName: "Example" });
	});
});
