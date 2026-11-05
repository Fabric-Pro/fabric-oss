import { savedReportPrompts } from "@saas/reports/lib/report-prompt-save";
import { describe, expect, it } from "vitest";

const definition = {
	userPrompt: "Summarise the sprint.",
	aiAgents: [
		{
			agentId: "default",
			task: "Find the risks.",
			outputVariable: "risks",
		},
		{ agentId: "default", task: "List the wins." },
	],
};

function report({
	connections = {},
	fabricConfig = null,
}: {
	connections?: Record<string, unknown>;
	fabricConfig?: Record<string, unknown> | null;
}) {
	return { connections, fabricConfig, template: { definition } };
}

describe("savedReportPrompts", () => {
	it("has nothing to hand on while the report uses the template's prompts", () => {
		expect(savedReportPrompts(report({}))).toBeNull();
	});

	it("hands on instructions a person wrote", () => {
		expect(
			savedReportPrompts(
				report({
					connections: {
						promptOverride: " Summarise the sprint for leads. ",
						promptOverrideSource: "user",
					},
				}),
			),
		).toEqual({ userPrompt: "Summarise the sprint for leads." });
	});

	it("leaves out an override copied from the template", () => {
		expect(
			savedReportPrompts(
				report({
					connections: {
						promptOverride: "An older template prompt.",
					},
				}),
			),
		).toBeNull();
		expect(
			savedReportPrompts(
				report({
					connections: {
						promptOverride: "Summarise the sprint.",
						promptOverrideSource: "user",
					},
				}),
			),
		).toBeNull();
	});

	it("hands on customized AI tasks under the template's task keys", () => {
		expect(
			savedReportPrompts(
				report({
					fabricConfig: {
						customAiTasks: {
							risks: "Find the delivery risks.",
							"agent-1": "List the wins by team.",
						},
					},
				}),
			),
		).toEqual({
			aiTasks: {
				risks: "Find the delivery risks.",
				"agent-1": "List the wins by team.",
			},
		});
	});

	it("drops tasks the template no longer has, blank ones and unchanged ones", () => {
		expect(
			savedReportPrompts(
				report({
					fabricConfig: {
						customAiTasks: {
							risks: "Find the risks.",
							"agent-1": "  ",
							removed: "A task the template dropped.",
						},
					},
				}),
			),
		).toBeNull();
	});
});
