import { describe, expect, it } from "vitest";
import {
	applyReportAiTaskOverrides,
	reportAiTaskKey,
} from "../src/activities/template-instance/report-ai-tasks";

const tasks = [
	{
		agentId: "summary",
		task: "Summarize the sprint.",
		outputVariable: "summary",
	},
	{ agentId: "risks", task: "List the risks." },
];

describe("reportAiTaskKey", () => {
	it("keys a task by its output variable, else by its position", () => {
		expect(reportAiTaskKey(tasks[0], 0)).toBe("summary");
		expect(reportAiTaskKey(tasks[1], 1)).toBe("agent-1");
	});
});

describe("applyReportAiTaskOverrides", () => {
	it("leaves the template's tasks unchanged without edits", () => {
		expect(applyReportAiTaskOverrides(tasks, {})).toEqual(tasks);
	});

	it("runs a customized task with the report's own prompt", () => {
		const result = applyReportAiTaskOverrides(tasks, {
			customAiTasks: {
				summary: "Summarize only blocked work.",
				"agent-1": "  ",
			},
		});
		expect(result[0].task).toBe("Summarize only blocked work.");
		expect(result[1].task).toBe("List the risks.");
		expect(result[0].outputVariable).toBe("summary");
	});

	it("adds report instructions that differ from the template's user prompt to every task", () => {
		const result = applyReportAiTaskOverrides(tasks, {
			customAiTasks: { summary: "Summarize only blocked work." },
			promptOverride: "Focus on the payments team.",
			promptOverrideSource: "user",
			templateUserPrompt: "Write a status report.",
		});
		expect(result[0].task).toBe(
			"Summarize only blocked work.\n\nReport instructions:\nFocus on the payments team.",
		);
		expect(result[1].task).toBe(
			"List the risks.\n\nReport instructions:\nFocus on the payments team.",
		);
	});

	it("does not repeat the template's own user prompt as report instructions", () => {
		expect(
			applyReportAiTaskOverrides(tasks, {
				promptOverride: "Write a status report.",
				promptOverrideSource: "user",
				templateUserPrompt: "Write a status report.",
			}),
		).toEqual(tasks);
	});

	it("leaves out an override nobody wrote, such as a copy of an older template prompt", () => {
		expect(
			applyReportAiTaskOverrides(tasks, {
				promptOverride: "Write last quarter's status report.",
				templateUserPrompt: "Write a status report.",
			}),
		).toEqual(tasks);
	});
});
