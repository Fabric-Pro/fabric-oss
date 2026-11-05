"use client";

import { templateTaskPrompts } from "@saas/reports/lib/report-prompt-save";
import type { ReportPromptDefaults } from "@saas/reports/lib/report-template-defaults";
import { templateSystemPrompt } from "@saas/reports/lib/report-template-definition";

/**
 * The prompts behind a template's AI Analysis, in full, before the report
 * exists: the template's, with the project's or the organization's default
 * prompts where they apply, as a new report takes them. A report's copy of them
 * is edited on its page once it is created.
 */
export function TemplatePromptPreview({
	definition,
	fabricConfig,
	promptDefaults,
}: {
	definition: unknown;
	fabricConfig: unknown;
	promptDefaults?: ReportPromptDefaults | null;
}) {
	const tasks = [...templateTaskPrompts(definition).entries()]
		.map(([key, task]): [string, string] => [
			key,
			promptDefaults?.aiTasks?.[key] ?? task,
		])
		.filter(([, task]) => task.trim());
	const systemPrompt =
		promptDefaults?.systemPrompt ?? templateSystemPrompt(fabricConfig);
	const defaultInstructions = promptDefaults?.userPrompt;
	const usesDefaultPrompts =
		Boolean(promptDefaults?.systemPrompt) ||
		tasks.some(([key]) => promptDefaults?.aiTasks?.[key] !== undefined);
	if (tasks.length === 0 && !systemPrompt && !defaultInstructions) {
		return null;
	}

	return (
		<section aria-label="AI Analysis prompt" className="min-w-0 space-y-3">
			<div>
				<h3 className="font-medium">AI Analysis prompt</h3>
				<p className="text-sm text-muted-foreground">
					What the AI is asked to do with the data. You can edit this
					report's copy on its page once it is created.
				</p>
				{usesDefaultPrompts && (
					<p className="text-sm text-muted-foreground">
						This includes default prompts someone set for this
						template in this project or organization.
					</p>
				)}
			</div>
			{systemPrompt && <PromptBody>{systemPrompt}</PromptBody>}
			{tasks.map(([key, task]) => (
				<PromptBody key={key}>{task}</PromptBody>
			))}
			{defaultInstructions && (
				<div className="space-y-1">
					<p className="text-sm text-muted-foreground">
						New reports here start with these default instructions,
						unless you write your own.
					</p>
					<PromptBody>{defaultInstructions}</PromptBody>
				</div>
			)}
		</section>
	);
}

function PromptBody({ children }: { children: string }) {
	return (
		<div className="min-w-0 whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-sm text-foreground [overflow-wrap:anywhere]">
			{children}
		</div>
	);
}
