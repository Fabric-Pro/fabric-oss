import { describe, expect, it } from "vitest";
import {
	mergeReportTemplateOverrides,
	promptDefaultsWrittenByOthers,
	readReportTemplatePromptDefaults,
} from "../prisma/queries/lib/report-template-defaults";

describe("promptDefaultsWrittenByOthers", () => {
	const prompts = { userPrompt: "Example instructions" };
	const applies = { organizationPromptsApply: true };

	it("says so for a project's or an organization's prompts someone else wrote", () => {
		const row = { prompts, updatedById: "example-teammate" };

		expect(
			promptDefaultsWrittenByOthers(
				{ organization: null, project: row },
				"example-caller",
				applies,
			),
		).toBe(true);
		expect(
			promptDefaultsWrittenByOthers(
				{ organization: row, project: null },
				"example-caller",
				applies,
			),
		).toBe(true);
	});

	it("counts prompts whose writer is gone as someone else's", () => {
		expect(
			promptDefaultsWrittenByOthers(
				{
					organization: null,
					project: { prompts, updatedById: null },
				},
				"example-caller",
				applies,
			),
		).toBe(true);
	});

	it("says no for the caller's own prompts, and for none", () => {
		expect(
			promptDefaultsWrittenByOthers(
				{
					organization: null,
					project: { prompts, updatedById: "example-caller" },
				},
				"example-caller",
				applies,
			),
		).toBe(false);
		expect(
			promptDefaultsWrittenByOthers(
				{ organization: null, project: null },
				"example-caller",
				applies,
			),
		).toBe(false);
		expect(
			promptDefaultsWrittenByOthers(
				{
					organization: null,
					project: { prompts: null, updatedById: "example-teammate" },
				},
				"example-caller",
				applies,
			),
		).toBe(false);
	});

	it("still asks about someone else's project prompts when the caller also wrote the organization's", () => {
		expect(
			promptDefaultsWrittenByOthers(
				{
					organization: { prompts, updatedById: "example-caller" },
					project: { prompts, updatedById: "example-teammate" },
				},
				"example-caller",
				applies,
			),
		).toBe(true);
	});

	it("ignores an organization's prompts where they do not apply", () => {
		expect(
			promptDefaultsWrittenByOthers(
				{
					organization: { prompts, updatedById: "example-teammate" },
					project: null,
				},
				"example-caller",
				{ organizationPromptsApply: false },
			),
		).toBe(false);
	});
});

describe("the default system prompt", () => {
	const row = (systemPrompt: string) => ({
		parameterDefaults: null,
		context: null,
		schedule: null,
		prompts: { systemPrompt },
	});

	it("is read like the other prompts", () => {
		expect(
			readReportTemplatePromptDefaults({ systemPrompt: "Example" }),
		).toEqual({ systemPrompt: "Example" });
	});

	it("takes the project's over the organization's", () => {
		expect(
			mergeReportTemplateOverrides(
				row("Organization prompt"),
				row("Project prompt"),
			).prompts?.systemPrompt,
		).toBe("Project prompt");
		expect(
			mergeReportTemplateOverrides(row("Organization prompt"), null)
				.prompts?.systemPrompt,
		).toBe("Organization prompt");
	});
});

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

	it("takes a project's prompts over the organization's, each prompt on its own", () => {
		const merged = mergeReportTemplateOverrides(
			{
				parameterDefaults: null,
				context: null,
				schedule: null,
				prompts: {
					userPrompt: "Organization instructions",
					aiTasks: {
						summary: "Organization summary",
						risks: "Organization risks",
					},
				},
			},
			{
				parameterDefaults: null,
				context: null,
				schedule: null,
				prompts: {
					userPrompt: "Project instructions",
					aiTasks: { risks: "Project risks" },
				},
			},
		);

		expect(merged.prompts).toEqual({
			userPrompt: "Project instructions",
			aiTasks: {
				summary: "Organization summary",
				risks: "Project risks",
			},
		});
		expect(merged.projectPrompts).toEqual({
			userPrompt: "Project instructions",
			aiTasks: { risks: "Project risks" },
		});
	});

	it("keeps the organization's prompts where the project has none, and reads blanks as none", () => {
		const merged = mergeReportTemplateOverrides(
			{
				parameterDefaults: null,
				context: null,
				schedule: null,
				prompts: {
					userPrompt: "Lead with the risks.",
					aiTasks: {
						summary: "Summarize for leadership.",
						risks: "  ",
					},
				},
			},
			{
				parameterDefaults: null,
				context: null,
				schedule: null,
				prompts: null,
			},
		);

		expect(merged.prompts).toEqual({
			userPrompt: "Lead with the risks.",
			aiTasks: { summary: "Summarize for leadership." },
		});
		expect(merged.projectPrompts).toBeUndefined();
	});

	it("reads blank or malformed prompts as none", () => {
		expect(readReportTemplatePromptDefaults({ userPrompt: "  " })).toBe(
			undefined,
		);
		expect(readReportTemplatePromptDefaults({ aiTasks: { a: 1 } })).toBe(
			undefined,
		);
		expect(readReportTemplatePromptDefaults("text")).toBe(undefined);
		expect(readReportTemplatePromptDefaults(null)).toBe(undefined);
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
