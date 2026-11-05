import {
	defaultsFromDraft,
	defaultsWithoutPrompts,
	defaultsWithPrompts,
	draftFromDefaults,
	mergeReportPromptDefaults,
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

	it("sends the saved schedule whole when its frequency is unchanged", () => {
		const schedule = {
			frequency: "weekly" as const,
			hour: 7,
			minute: 30,
			timezone: "Europe/Paris",
			dayOfWeek: 2,
		};
		const saved = { parameterDefaults: {}, context: {}, schedule };

		expect(
			defaultsFromDraft(draftFromDefaults(saved), saved)?.schedule,
		).toEqual(schedule);
		expect(
			defaultsFromDraft({ parameters: {}, frequency: "daily" }, saved)
				?.schedule,
		).toEqual({ frequency: "daily" });
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

	it("keeps the scope, and leaves its prompts out, while it holds default prompts", () => {
		const saved = {
			parameterDefaults: { team: "Old" },
			context: {},
			schedule: null,
			prompts: { userPrompt: "Summarise for leads." },
		};

		const defaults = defaultsFromDraft(
			{ parameters: { team: "" }, frequency: null },
			saved,
		);

		expect(defaults).toEqual({
			parameterDefaults: null,
			context: null,
			schedule: null,
		});
		// Omitted, so the API keeps the stored prompts.
		expect(defaults).not.toHaveProperty("prompts");
	});
});

describe("mergeReportPromptDefaults", () => {
	it("puts the report's prompts over the stored ones", () => {
		expect(
			mergeReportPromptDefaults(
				{
					userPrompt: "Stored instructions.",
					aiTasks: { risks: "Stored risks.", wins: "Stored wins." },
				},
				{
					userPrompt: "Report instructions.",
					aiTasks: { risks: "Report risks." },
				},
			),
		).toEqual({
			userPrompt: "Report instructions.",
			aiTasks: { risks: "Report risks.", wins: "Stored wins." },
		});
	});

	it("keeps the stored instructions when the report has none", () => {
		expect(
			mergeReportPromptDefaults(
				{ userPrompt: "Stored instructions." },
				{ aiTasks: { risks: "Report risks." } },
			),
		).toEqual({
			userPrompt: "Stored instructions.",
			aiTasks: { risks: "Report risks." },
		});
	});

	it("is the report's prompts when nothing is stored", () => {
		expect(
			mergeReportPromptDefaults(null, {
				userPrompt: "Report instructions.",
			}),
		).toEqual({ userPrompt: "Report instructions." });
	});
});

describe("default prompts", () => {
	const saved = {
		parameterDefaults: { team: "Example team", limit: 10 },
		context: { boardName: "Example board" },
		schedule: { frequency: "weekly" as const },
		prompts: { userPrompt: "Older prompt." },
	};

	it("sends new prompts with the scope's other defaults unchanged", () => {
		expect(
			defaultsWithPrompts(saved, {
				userPrompt: "Summarise for leads.",
				aiTasks: { risks: "Find the delivery risks." },
			}),
		).toEqual({
			parameterDefaults: { team: "Example team", limit: 10 },
			context: { boardName: "Example board" },
			schedule: { frequency: "weekly" },
			prompts: {
				userPrompt: "Summarise for leads.",
				aiTasks: { risks: "Find the delivery risks." },
			},
		});
	});

	it("sets prompts for a scope with no defaults yet", () => {
		expect(defaultsWithPrompts(null, { userPrompt: "Summarise." })).toEqual(
			{
				parameterDefaults: null,
				context: null,
				schedule: null,
				prompts: { userPrompt: "Summarise." },
			},
		);
	});

	it("keeps the stored prompts this report does not change", () => {
		const stored = {
			...saved,
			prompts: {
				userPrompt: "Stored instructions.",
				aiTasks: {
					risks: "Stored risks prompt.",
					wins: "Stored wins prompt.",
				},
			},
		};

		expect(
			defaultsWithPrompts(stored, {
				aiTasks: { risks: "Find the delivery risks." },
			}).prompts,
		).toEqual({
			// The report has no instructions of its own: the stored ones stay.
			userPrompt: "Stored instructions.",
			aiTasks: {
				// The report's task wins...
				risks: "Find the delivery risks.",
				// ...and a task it does not carry keeps its stored default.
				wins: "Stored wins prompt.",
			},
		});
	});

	it("clears only the prompts", () => {
		expect(defaultsWithoutPrompts(saved)).toEqual({
			parameterDefaults: { team: "Example team", limit: 10 },
			context: { boardName: "Example board" },
			schedule: { frequency: "weekly" },
			prompts: null,
		});
	});
});
