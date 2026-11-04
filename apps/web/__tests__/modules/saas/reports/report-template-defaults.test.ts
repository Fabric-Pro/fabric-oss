import {
	defaultsFromDraft,
	draftFromDefaults,
	templateParameterFields,
} from "@saas/reports/lib/report-template-defaults";
import { describe, expect, it } from "vitest";

describe("templateParameterFields", () => {
	it("lists the template's parameters with their titles and whether they are required", () => {
		expect(
			templateParameterFields({
				required: ["team"],
				properties: {
					team: {
						type: "string",
						title: "Team",
						description: " The team the report covers ",
					},
					sprintId: { type: "string" },
				},
			}),
		).toEqual([
			{
				key: "team",
				title: "Team",
				required: true,
				description: "The team the report covers",
			},
			{ key: "sprintId", title: "sprintId", required: false },
		]);
	});

	it("has nothing to list for a template without parameters", () => {
		expect(templateParameterFields(null)).toEqual([]);
	});
});

describe("defaultsFromDraft", () => {
	it("sends the filled parameters and the schedule, keeping the saved context", () => {
		const saved = {
			parameterDefaults: { team: "Example team" },
			context: { boardName: "Example board" },
			schedule: null,
		};
		const draft = draftFromDefaults(saved);

		expect(
			defaultsFromDraft(
				{
					parameters: { ...draft.parameters, sprintId: "  " },
					frequency: "weekly",
				},
				saved,
			),
		).toEqual({
			parameterDefaults: { team: "Example team" },
			context: { boardName: "Example board" },
			schedule: { frequency: "weekly" },
		});
	});

	it("clears the scope when nothing is left", () => {
		expect(
			defaultsFromDraft(
				{ parameters: { team: "" }, frequency: null },
				{
					parameterDefaults: { team: "Old" },
					context: {},
					schedule: null,
				},
			),
		).toBeNull();
	});

	it("shows a saved number as text in the form", () => {
		expect(
			draftFromDefaults({
				parameterDefaults: { limit: 10 },
				context: {},
				schedule: { frequency: "monthly" },
			}),
		).toEqual({ parameters: { limit: "10" }, frequency: "monthly" });
	});
});
