"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { RotateCcwIcon } from "lucide-react";
import type { AiTask } from "./AiTaskPromptEditor";

type Props = {
	userPrompt: string;
	onUserPromptChange: (value: string) => void;
	tasks: AiTask[];
	customTasks: Record<string, string>;
	/** `null` resets the task to the template's prompt. */
	onCustomTaskChange: (key: string, value: string | null) => void;
	readOnly: boolean;
};

/** Rows that show a prompt whole: one per line, within reason. */
function rowsFor(text: string, min: number): number {
	return Math.min(24, Math.max(min, text.split("\n").length + 1));
}

/** A prompt in full: editable text, or plain text a viewer can read and copy. */
function PromptText({
	id,
	value,
	onChange,
	readOnly,
	placeholder,
	describedBy,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	readOnly: boolean;
	placeholder: string;
	describedBy?: string;
}) {
	if (readOnly) {
		return (
			<div
				id={id}
				aria-describedby={describedBy}
				className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-sm text-foreground"
			>
				{value || (
					<span className="text-muted-foreground">
						No prompt set.
					</span>
				)}
			</div>
		);
	}
	return (
		<Textarea
			id={id}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			placeholder={placeholder}
			rows={rowsFor(value, 6)}
			className="font-mono text-sm"
			aria-describedby={describedBy}
		/>
	);
}

/**
 * The prompts that drive this report, shown in full and editable in place:
 * the instructions for what to do with the gathered data, then each AI
 * analysis task. Saved with the rest of the report's settings.
 */
export function ReportPromptCard({
	userPrompt,
	onUserPromptChange,
	tasks,
	customTasks,
	onCustomTaskChange,
	readOnly,
}: Props) {
	return (
		<Card>
			<CardHeader>
				<p className="app-editorial-label">Prompt</p>
				<CardTitle className="text-base">
					What the AI is asked to do
				</CardTitle>
				<CardDescription>
					{readOnly
						? "You can read this report's prompts. Ask an editor of this project to change them."
						: "Edit the prompts for this report. Changes apply when you save."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-2">
					<Label htmlFor="user-prompt">
						AI Instructions (User Prompt)
					</Label>
					<PromptText
						id="user-prompt"
						value={userPrompt}
						onChange={onUserPromptChange}
						readOnly={readOnly}
						placeholder="Describe what the AI should do with the gathered data..."
						describedBy="user-prompt-help"
					/>
					<p
						id="user-prompt-help"
						className="text-xs text-muted-foreground"
					>
						These instructions tell the AI what to do with the data
						gathered from your data sources. This is the main task
						prompt.
					</p>
				</div>

				{tasks.map((task, index) => {
					const taskKey = task.outputVariable || `agent-${index}`;
					const isCustomized = taskKey in customTasks;
					const prompt = customTasks[taskKey] ?? task.task;
					const id = `task-prompt-${taskKey}`;

					return (
						<div key={taskKey} className="space-y-2 border-t pt-4">
							<div className="flex flex-wrap items-center gap-2">
								<Label htmlFor={id}>
									{task.agentId === "default"
										? "AI Analysis"
										: task.agentId}
								</Label>
								{task.outputVariable && (
									<Badge
										variant="outline"
										className="font-mono text-xs"
									>
										{task.outputVariable}
									</Badge>
								)}
								{isCustomized && (
									<Badge
										variant="success"
										className="text-xs"
									>
										Customized
									</Badge>
								)}
								{isCustomized && !readOnly && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="ml-auto h-7 text-xs"
										onClick={() =>
											onCustomTaskChange(taskKey, null)
										}
									>
										<RotateCcwIcon className="mr-1 h-3 w-3" />
										Reset to template
									</Button>
								)}
							</div>
							<PromptText
								id={id}
								value={prompt}
								onChange={(value) =>
									onCustomTaskChange(taskKey, value)
								}
								readOnly={readOnly}
								placeholder="Enter the AI analysis prompt..."
							/>
						</div>
					);
				})}
			</CardContent>
		</Card>
	);
}
