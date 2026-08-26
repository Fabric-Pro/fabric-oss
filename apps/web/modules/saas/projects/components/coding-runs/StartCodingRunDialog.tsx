"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	CodeIcon,
	GitBranchIcon,
	ListTodoIcon,
	Loader2Icon,
} from "lucide-react";
import { getExecutionProviderLabel } from "../../lib/implementation-session-labels";
import type { UserStory } from "../../lib/stories/types";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	story: UserStory | null;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
	isLoading?: boolean;
	onConfirm: () => void;
	focusedTaskId?: string | null;
};

export function StartCodingRunDialog({
	open,
	onOpenChange,
	story,
	repositoryOwner,
	repositoryName,
	defaultBranch = "main",
	isLoading = false,
	onConfirm,
	focusedTaskId,
}: Props) {
	if (!story) {
		return null;
	}

	const incompleteTasks = story.tasks.filter((task) => !task.isCompleted);
	const focusedTask = focusedTaskId
		? (incompleteTasks.find((task) => task.id === focusedTaskId) ?? null)
		: null;
	const displayTasks = focusedTask
		? [
				focusedTask,
				...incompleteTasks.filter((task) => task.id !== focusedTask.id),
			]
		: incompleteTasks;
	const hasRepositoryContext = !!repositoryOwner && !!repositoryName;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[640px]">
				<DialogHeader className="flex-shrink-0 space-y-4 text-left">
					<div className="flex items-start gap-3">
						<div className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 shadow-sm">
							<CodeIcon className="size-5 text-primary" />
						</div>
						<div className="min-w-0 flex-1 space-y-2 pr-8">
							<Badge
								variant="outline"
								className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] uppercase tracking-[0.16em] text-primary"
							>
								{getExecutionProviderLabel("BACKGROUND_AGENTS")}
							</Badge>
							<DialogTitle className="text-xl leading-tight sm:text-2xl">
								Send to{" "}
								{getExecutionProviderLabel("BACKGROUND_AGENTS")}
							</DialogTitle>
							<DialogDescription className="max-w-[60ch] text-sm leading-6">
								Fabric Agent will implement this feature in
								Fabric-managed remote infrastructure using{" "}
								{getExecutionProviderLabel("BACKGROUND_AGENTS")}
								. No local setup needed.
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<div className="flex-1 space-y-4 overflow-y-auto py-1 pr-1">
					{!hasRepositoryContext && (
						<div className="rounded-2xl border border-amber-300/40 bg-amber-50/70 p-4 dark:border-amber-700/50 dark:bg-amber-950/20">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								Repository required
							</p>
							<p className="mt-2 text-sm leading-6 text-foreground/85">
								Direct implementation sessions need a connected
								project repository before Fabric Agent can
								launch. Configure a repository on the project
								first.
							</p>
						</div>
					)}

					<div className="grid gap-4 sm:grid-cols-2">
						{repositoryOwner && repositoryName && (
							<div className="rounded-2xl border border-border/60 bg-background p-4">
								<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
									Repository
								</p>
								<p className="mt-2 flex items-center gap-2 text-sm font-medium text-foreground">
									<GitBranchIcon className="size-4 text-primary" />
									<span className="truncate">
										{repositoryOwner}/{repositoryName}
									</span>
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Target branch: {defaultBranch}
								</p>
							</div>
						)}

						<div className="rounded-2xl border border-border/60 bg-background p-4">
							<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
								Scope
							</p>
							<p className="mt-2 flex items-center gap-2 text-sm font-medium text-foreground">
								<ListTodoIcon className="size-4 text-primary" />
								{incompleteTasks.length} open{" "}
								{incompleteTasks.length === 1
									? "task"
									: "tasks"}
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								{focusedTask
									? `${focusedTask.identifier} is the primary task.`
									: "All open tasks will be included."}
							</p>
						</div>
					</div>

					{displayTasks.length > 0 && (
						<div className="rounded-2xl border border-border/60 bg-background p-4">
							<div className="flex items-center justify-between gap-3">
								<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
									Tasks to implement
								</p>
								<Badge
									variant="secondary"
									className="rounded-full px-2.5 py-1 text-[11px]"
								>
									{displayTasks.length}
								</Badge>
							</div>
							<ul className="mt-3 max-h-[180px] space-y-2 overflow-y-auto pr-1 text-sm">
								{displayTasks.map((task, index) => (
									<li
										key={task.id}
										className="flex items-start gap-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5"
									>
										<span className="mt-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
											{task.identifier}
										</span>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="leading-5 text-foreground/85">
													{task.title}
												</span>
												{focusedTask && index === 0 && (
													<Badge
														variant="outline"
														className="rounded-full border-primary/25 bg-primary/5 px-2 py-0 text-[10px] text-primary"
													>
														Primary task
													</Badge>
												)}
											</div>
										</div>
									</li>
								))}
							</ul>
						</div>
					)}
				</div>

				<DialogFooter className="flex-shrink-0 gap-2 sm:justify-between">
					<p className="text-xs leading-5 text-muted-foreground sm:max-w-[55ch]">
						Fabric Agent will pass the feature context, branch, and
						tasks to Background Agents.
					</p>
					<div className="flex items-center gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isLoading}
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={onConfirm}
							disabled={isLoading || !hasRepositoryContext}
						>
							{isLoading ? (
								<>
									<Loader2Icon className="mr-2 size-4 animate-spin" />
									Starting...
								</>
							) : (
								"Start implementation session"
							)}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
