/**
 * The prompts a saved report can hand on: its own report instructions, AI task
 * prompts and system prompt where they differ from the template's, written to the template
 * ("Update template") or kept as the organization's default for new reports
 * ("Set as organization default"). Pure, so `report-configuration-save` and
 * its tests read the same rules. The API checks who may do either.
 */

import { reportAiTaskKey } from "@repo/temporal/report-ai-tasks";
import type { ReportPromptDefaults } from "./report-template-defaults";
import { templateSystemPrompt } from "./report-template-definition";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The template's AI task prompts by the key a report customizes them under. */
export function templateTaskPrompts(definition: unknown): Map<string, string> {
	const agents =
		isRecord(definition) && Array.isArray(definition.aiAgents)
			? definition.aiAgents
			: [];
	return new Map(
		agents.map((agent, index) => {
			const task = isRecord(agent) ? agent : {};
			return [
				reportAiTaskKey(
					{
						agentId: text(task.agentId),
						task: text(task.task),
						outputVariable: text(task.outputVariable) || undefined,
					},
					index,
				),
				text(task.task),
			];
		}),
	);
}

/**
 * The report's saved prompts that differ from its template's: the
 * instructions a person wrote (`promptOverrideSource: "user"`), and each
 * customized AI task the template still has. `null` when there is nothing to
 * hand on. Read from the saved report, so unsaved edits are never sent.
 */
export function savedReportPrompts(report: {
	connections: unknown;
	fabricConfig: unknown;
	template: { definition: unknown; fabricConfig?: unknown };
}): ReportPromptDefaults | null {
	const definition = report.template.definition;
	const templatePrompt = isRecord(definition)
		? text(definition.userPrompt).trim()
		: "";
	const connections = isRecord(report.connections) ? report.connections : {};
	const override = text(connections.promptOverride).trim();
	const userPrompt =
		override &&
		connections.promptOverrideSource === "user" &&
		override !== templatePrompt
			? override
			: undefined;

	const taskPrompts = templateTaskPrompts(definition);
	const custom =
		isRecord(report.fabricConfig) &&
		isRecord(report.fabricConfig.customAiTasks)
			? report.fabricConfig.customAiTasks
			: {};
	const aiTasks = Object.fromEntries(
		Object.entries(custom)
			.map(([key, value]) => [key, text(value).trim()] as const)
			.filter(
				([key, value]) =>
					value.length > 0 &&
					taskPrompts.has(key) &&
					value !== taskPrompts.get(key)?.trim(),
			),
	);
	const hasAiTasks = Object.keys(aiTasks).length > 0;

	const customSystemPrompt = isRecord(report.fabricConfig)
		? text(report.fabricConfig.customSystemPrompt).trim()
		: "";
	const systemPrompt =
		customSystemPrompt &&
		customSystemPrompt !==
			templateSystemPrompt(report.template.fabricConfig)?.trim()
			? customSystemPrompt
			: undefined;

	if (!userPrompt && !hasAiTasks && !systemPrompt) {
		return null;
	}
	return {
		...(userPrompt ? { userPrompt } : {}),
		...(hasAiTasks ? { aiTasks } : {}),
		...(systemPrompt ? { systemPrompt } : {}),
	};
}
