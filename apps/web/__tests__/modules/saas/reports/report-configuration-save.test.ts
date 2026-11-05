import {
	organizationConfigurationChanges,
	projectConfigurationChanges,
	storedDefaultsForTemplate,
	templateConfigurationChanges,
} from "@saas/reports/lib/report-configuration-save";
import { defaultsWithReportValues } from "@saas/reports/lib/report-template-defaults";
import { describe, expect, it } from "vitest";

function report({
	parameterDefaults = {},
	connections = {},
	properties = {
		team: { type: "string" },
		weeks: { type: "number", default: 2 },
		boardId: { type: "string" },
		projectName: { type: "string" },
	},
}: {
	parameterDefaults?: Record<string, unknown>;
	connections?: Record<string, unknown>;
	properties?: Record<string, unknown>;
}) {
	return {
		connections,
		fabricConfig: null,
		parameterDefaults,
		template: {
			definition: { userPrompt: "Summarise the sprint." },
			parameters: { properties },
		},
	};
}

function stored(
	parameterDefaults: Record<string, string | number | boolean>,
	prompts: { userPrompt?: string; systemPrompt?: string } | null = null,
) {
	return { parameterDefaults, prompts };
}

const boardBinding = {
	resourceBindings: {
		fizzy: {
			resourceId: "board-7",
			resourceName: "Example board",
			resourceType: "board",
		},
	},
};

describe("values never handed on", () => {
	it("keeps a parameter whose template default is a placeholder out of every offer", () => {
		const dated = report({
			parameterDefaults: { weekStart: "2026-11-02" },
			properties: {
				weekStart: { type: "string", default: "{{WEEK_START}}" },
			},
		});

		expect(templateConfigurationChanges(dated)).toBeNull();
		expect(
			organizationConfigurationChanges(dated, null, {
				includePrompts: true,
			}),
		).toBeNull();
		expect(
			projectConfigurationChanges(dated, {
				organization: null,
				project: null,
			}),
		).toBeNull();
	});

	it("keeps a text longer than a default may hold out of the offer", () => {
		expect(
			templateConfigurationChanges(
				report({ parameterDefaults: { team: "x".repeat(2001) } }),
			),
		).toBeNull();
		expect(
			templateConfigurationChanges(
				report({ parameterDefaults: { team: "x".repeat(2000) } }),
			)?.parameterDefaults,
		).toEqual({ team: "x".repeat(2000) });
	});
});

describe("the report's system prompt", () => {
	const withSystemPrompt = (customSystemPrompt: string) => ({
		...report({}),
		fabricConfig: { customSystemPrompt },
		template: {
			...report({}).template,
			fabricConfig: { defaultSystemPrompt: "The template's own" },
		},
	});

	it("is handed on when it differs from the template's", () => {
		expect(
			templateConfigurationChanges(withSystemPrompt("Answer briefly"))
				?.prompts,
		).toEqual({ systemPrompt: "Answer briefly" });
		expect(
			organizationConfigurationChanges(
				withSystemPrompt("Answer briefly"),
				null,
				{ includePrompts: true },
			)?.prompts,
		).toEqual({ systemPrompt: "Answer briefly" });
	});

	it("is not offered when it is the template's own", () => {
		expect(
			templateConfigurationChanges(
				withSystemPrompt("The template's own"),
			),
		).toBeNull();
	});

	it("is not offered again once the scope's default already holds it", () => {
		expect(
			organizationConfigurationChanges(
				withSystemPrompt("Answer briefly"),
				stored({}, { systemPrompt: "Answer briefly" }),
				{ includePrompts: true },
			),
		).toBeNull();
	});
});

describe("storedDefaultsForTemplate", () => {
	const definition = {
		aiAgents: [
			{ agentId: "default", task: "Risks", outputVariable: "risks" },
		],
	};

	it("drops stored prompts for AI tasks the template no longer has", () => {
		expect(
			storedDefaultsForTemplate(
				{
					parameterDefaults: {},
					prompts: {
						userPrompt: "Kept",
						aiTasks: { risks: "Kept", dropped: "Stale" },
					},
				},
				definition,
			)?.prompts,
		).toEqual({ userPrompt: "Kept", aiTasks: { risks: "Kept" } });
	});

	it("leaves defaults without AI task prompts as they are", () => {
		const defaults = { parameterDefaults: {}, prompts: null };

		expect(storedDefaultsForTemplate(defaults, definition)).toBe(defaults);
		expect(storedDefaultsForTemplate(null, definition)).toBeNull();
	});
});

describe("templateConfigurationChanges", () => {
	it("has nothing to hand on while the report matches its template", () => {
		expect(templateConfigurationChanges(report({}))).toBeNull();
		expect(
			templateConfigurationChanges(
				report({ parameterDefaults: { weeks: "2", team: "  " } }),
			),
		).toBeNull();
	});

	it("hands on a parameter that differs from the template's default", () => {
		expect(
			templateConfigurationChanges(
				report({
					parameterDefaults: { team: " Example team ", weeks: 4 },
				}),
			),
		).toEqual({ parameterDefaults: { team: "Example team", weeks: 4 } });
	});

	it("ignores a stored value the template has no parameter for", () => {
		expect(
			templateConfigurationChanges(
				report({ parameterDefaults: { removed: "Old value" } }),
			),
		).toBeNull();
	});

	it("never hands on what a project answers, or a value from a bound resource", () => {
		expect(
			templateConfigurationChanges(
				report({
					connections: boardBinding,
					parameterDefaults: {
						projectName: "Example project",
						boardId: "board-7",
					},
				}),
			),
		).toBeNull();
	});
});

describe("organizationConfigurationChanges", () => {
	it("offers only what new reports in the organization would not start with", () => {
		expect(
			organizationConfigurationChanges(
				report({
					parameterDefaults: {
						team: "Example team",
						weeks: "2",
						boardId: "board-1",
					},
				}),
				stored({ team: "Example team" }),
				{ includePrompts: true },
			),
		).toEqual({ parameterDefaults: { boardId: "board-1" } });
	});

	it("keeps a bound resource's value out", () => {
		expect(
			organizationConfigurationChanges(
				report({
					connections: boardBinding,
					parameterDefaults: { boardId: "board-7" },
				}),
				null,
				{ includePrompts: true },
			),
		).toBeNull();
	});

	it("withdraws prompts the organization already holds", () => {
		const withPrompt = {
			...report({}),
			connections: {
				promptOverride: "Summarise for leads.",
				promptOverrideSource: "user",
			},
		};

		expect(
			organizationConfigurationChanges(withPrompt, stored({}), {
				includePrompts: true,
			}),
		).toEqual({ prompts: { userPrompt: "Summarise for leads." } });
		expect(
			organizationConfigurationChanges(
				withPrompt,
				stored({}, { userPrompt: "Summarise for leads." }),
				{ includePrompts: true },
			),
		).toBeNull();
	});

	it("leaves prompts out where the organization may not hold them", () => {
		expect(
			organizationConfigurationChanges(
				{
					...report({}),
					connections: {
						promptOverride: "Summarise for leads.",
						promptOverrideSource: "user",
					},
				},
				null,
				{ includePrompts: false },
			),
		).toBeNull();
	});
});

describe("projectConfigurationChanges", () => {
	it("takes a bound resource's value, which belongs to the project", () => {
		expect(
			projectConfigurationChanges(
				report({
					connections: boardBinding,
					parameterDefaults: { boardId: "board-7" },
				}),
				{ organization: null, project: null },
			),
		).toEqual({ parameterDefaults: { boardId: "board-7" } });
	});

	it("reads project over organization over template, as a new report does", () => {
		expect(
			projectConfigurationChanges(
				report({
					parameterDefaults: { team: "Org team", weeks: "2" },
				}),
				{ organization: stored({ team: "Org team" }), project: null },
			),
		).toBeNull();
		expect(
			projectConfigurationChanges(
				report({ parameterDefaults: { team: "Org team" } }),
				{
					organization: stored({ team: "Org team" }),
					project: stored({ team: "Project team" }),
				},
			),
		).toEqual({ parameterDefaults: { team: "Org team" } });
	});

	describe("prompts", () => {
		const edited = {
			...report({}),
			connections: {
				promptOverride: "Summarise for leads.",
				promptOverrideSource: "user",
			},
		};
		const holding = (userPrompt: string) => ({
			parameterDefaults: {},
			prompts: { userPrompt },
		});

		it("carries a report's own prompts that no default holds", () => {
			expect(
				projectConfigurationChanges(edited, {
					organization: null,
					project: null,
				}),
			).toEqual({ prompts: { userPrompt: "Summarise for leads." } });
		});

		it("goes away once the project holds them", () => {
			expect(
				projectConfigurationChanges(edited, {
					organization: holding("Something else."),
					project: holding("Summarise for leads."),
				}),
			).toBeNull();
		});

		it("goes away when the organization's prompts already start new reports", () => {
			expect(
				projectConfigurationChanges(edited, {
					organization: holding("Summarise for leads."),
					project: null,
				}),
			).toBeNull();
		});

		it("still offers them over the organization's stale prompts on its own template", () => {
			expect(
				projectConfigurationChanges(edited, {
					organization: holding("Summarise for leads."),
					project: null,
					organizationPromptsApply: false,
				}),
			).toEqual({ prompts: { userPrompt: "Summarise for leads." } });
		});
	});
});

describe("defaultsWithReportValues", () => {
	const saved = {
		parameterDefaults: { region: "Example" },
		context: { team: "Example" },
		schedule: null,
		prompts: { userPrompt: "Stored." },
	};

	it("keeps what the report does not change, and leaves stored prompts alone", () => {
		const payload = defaultsWithReportValues(saved, {
			parameterDefaults: { weeks: 4 },
		});

		expect(payload).toEqual({
			parameterDefaults: { region: "Example", weeks: 4 },
			context: { team: "Example" },
			schedule: null,
		});
		expect(payload).not.toHaveProperty("prompts");
	});

	it("merges prompts over the stored ones when given", () => {
		expect(
			defaultsWithReportValues(saved, {
				prompts: { aiTasks: { risks: "Find risks." } },
			}).prompts,
		).toEqual({
			userPrompt: "Stored.",
			aiTasks: { risks: "Find risks." },
		});
	});
});
