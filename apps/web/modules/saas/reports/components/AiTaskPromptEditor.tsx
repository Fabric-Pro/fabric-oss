"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	BrainCircuitIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	PencilIcon,
	RotateCcwIcon,
	SparklesIcon,
} from "lucide-react";
import { useState } from "react";

export type AiTask = {
	agentId: string;
	task: string;
	outputVariable?: string;
};

type Props = {
	tasks: AiTask[];
	customTasks: Record<string, string>;
	onCustomTaskChange: (key: string, value: string | null) => void;
	className?: string;
};

export function AiTaskPromptEditor({
	tasks,
	customTasks,
	onCustomTaskChange,
	className,
}: Props) {
	const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
	const [editingTask, setEditingTask] = useState<string | null>(null);

	if (tasks.length === 0) {
		return null;
	}

	const toggleExpanded = (key: string) => {
		const newExpanded = new Set(expandedTasks);
		if (newExpanded.has(key)) {
			newExpanded.delete(key);
		} else {
			newExpanded.add(key);
		}
		setExpandedTasks(newExpanded);
	};

	return (
		<div className={cn("space-y-4", className)}>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<BrainCircuitIcon className="h-5 w-5 text-primary" />
					<h3 className="font-semibold">AI Analysis Tasks</h3>
					<Badge variant="secondary" className="text-xs">
						{tasks.length} task{tasks.length !== 1 ? "s" : ""}
					</Badge>
				</div>
				<p className="text-xs text-muted-foreground">
					Customize prompts for this instance
				</p>
			</div>

			<div className="space-y-3">
				{tasks.map((task, index) => {
					const taskKey = task.outputVariable || `agent-${index}`;
					const isCustomized = taskKey in customTasks;
					const currentPrompt = customTasks[taskKey] ?? task.task;
					const isExpanded = expandedTasks.has(taskKey);
					const isEditing = editingTask === taskKey;

					return (
						<div
							key={taskKey}
							className={cn(
								"border rounded-lg overflow-hidden transition-all",
								isCustomized
									? "border-primary/50 bg-primary/5"
									: "border-border",
							)}
						>
							{/* Header */}
							{/* biome-ignore lint/a11y/noStaticElementInteractions: accordion header contains nested Button; cannot use <button> */}
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: accordion header contains nested Button; cannot use <button> */}
							<div
								className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-muted/50"
								onClick={() => toggleExpanded(taskKey)}
							>
								<div className="flex items-center gap-3">
									<div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted">
										<SparklesIcon className="h-4 w-4 text-primary" />
									</div>
									<div>
										<div className="flex items-center gap-2">
											<span className="font-medium text-sm">
												{task.agentId === "default"
													? "AI Analysis"
													: task.agentId}
											</span>
											{task.outputVariable && (
												<Badge
													variant="outline"
													className="text-xs font-mono"
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
										</div>
										<p className="text-xs text-muted-foreground line-clamp-1 max-w-md">
											{currentPrompt.slice(0, 80)}
											{currentPrompt.length > 80
												? "..."
												: ""}
										</p>
									</div>
								</div>
								<div className="flex items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={(e) => {
											e.stopPropagation();
											setEditingTask(
												isEditing ? null : taskKey,
											);
											if (!isExpanded) {
												toggleExpanded(taskKey);
											}
										}}
									>
										<PencilIcon className="h-3.5 w-3.5 mr-1" />
										{isEditing ? "Done" : "Edit"}
									</Button>
									{isExpanded ? (
										<ChevronDownIcon className="h-4 w-4 text-muted-foreground" />
									) : (
										<ChevronRightIcon className="h-4 w-4 text-muted-foreground" />
									)}
								</div>
							</div>

							{/* Expanded Content */}
							{isExpanded && (
								<div className="px-4 pb-4 space-y-3 border-t bg-muted/20">
									{isEditing ? (
										<>
											<div className="pt-3">
												<div className="flex items-center justify-between mb-2">
													<label
														className="text-sm font-medium"
														htmlFor={`custom-prompt-${taskKey}`}
													>
														Custom Prompt
													</label>
													{isCustomized && (
														<Button
															variant="ghost"
															size="sm"
															className="h-7 text-xs"
															onClick={() =>
																onCustomTaskChange(
																	taskKey,
																	null,
																)
															}
														>
															<RotateCcwIcon className="h-3 w-3 mr-1" />
															Reset to Default
														</Button>
													)}
												</div>
												<Textarea
													id={`custom-prompt-${taskKey}`}
													value={currentPrompt}
													onChange={(e) =>
														onCustomTaskChange(
															taskKey,
															e.target.value,
														)
													}
													rows={6}
													className="font-mono text-sm"
													placeholder="Enter custom AI analysis prompt..."
												/>
											</div>

											{/* Original prompt reference */}
											{isCustomized && (
												<div className="text-xs text-muted-foreground bg-muted/50 rounded p-3">
													<p className="font-medium mb-1">
														Original (template
														default):
													</p>
													<p className="italic">
														{task.task}
													</p>
												</div>
											)}
										</>
									) : (
										<div className="pt-3">
											<p className="text-sm whitespace-pre-wrap bg-muted/50 rounded p-3">
												{currentPrompt}
											</p>
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
