/**
 * Workflow-safe (pure) helper that applies a report instance's prompt edits to
 * its template's AI tasks. Safe to import from the Temporal workflow — keep
 * this file free of side-effecting imports.
 */

export type ReportAiTask = {
	agentId: string;
	task: string;
	outputVariable?: string;
};

/**
 * The key a task's custom prompt is saved under; the report page writes
 * `fabricConfig.customAiTasks` with the same key.
 */
export function reportAiTaskKey(task: ReportAiTask, index: number): string {
	return task.outputVariable || `agent-${index}`;
}

/**
 * The template's AI tasks as this report runs them: a task the report
 * customized uses its own prompt, and report instructions a person wrote
 * (`promptOverrideSource: "user"`) that differ from the template's own user
 * prompt are added to every task. An unmarked override is a copy of the
 * template's prompt from when the report was made, so it is left out: the
 * template's current tasks already say what it said.
 */
export function applyReportAiTaskOverrides(
	tasks: ReportAiTask[],
	overrides: {
		customAiTasks?: Record<string, string>;
		promptOverride?: string;
		promptOverrideSource?: string;
		templateUserPrompt?: string;
	},
): ReportAiTask[] {
	const instructions =
		overrides.promptOverrideSource === "user"
			? overrides.promptOverride?.trim()
			: undefined;
	const extraInstructions =
		instructions && instructions !== overrides.templateUserPrompt?.trim()
			? instructions
			: undefined;
	return tasks.map((task, index) => {
		const customTask =
			overrides.customAiTasks?.[reportAiTaskKey(task, index)]?.trim();
		const baseTask = customTask || task.task;
		return {
			...task,
			task: extraInstructions
				? `${baseTask}\n\nReport instructions:\n${extraInstructions}`
				: baseTask,
		};
	});
}
