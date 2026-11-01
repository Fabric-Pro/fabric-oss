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
	CpuIcon,
	GitBranchIcon,
	ListTodoIcon,
	Loader2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
	FABRIC_AGENT_CONNECTIONS,
	getExecutionProviderDescription,
	getExecutionProviderLabel,
} from "../../lib/implementation-session-labels";
import type { UserStory } from "../../lib/stories/types";

export interface StartCodingRunConfirmOptions {
	serverId?: string;
	llmConnection?: string;
	taskId?: string | null;
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	story: UserStory | null;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
	isLoading?: boolean;
	onConfirm: (options?: StartCodingRunConfirmOptions) => void;
	focusedTaskId?: string | null;
	initialConnection?: string;
	serverPicker?: ReactNode;
	serverId?: string;
	serverRequired?: boolean;
	serverLoading?: boolean;
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
	initialConnection = "default",
	serverPicker,
	serverId,
	serverRequired = false,
	serverLoading = false,
}: Props) {
	const [selectedConnection, setSelectedConnection] =
		useState<string>(initialConnection);
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
		focusedTaskId ?? null,
	);

	useEffect(() => {
		if (open) {
			setSelectedTaskId(focusedTaskId ?? null);
		}
	}, [open, focusedTaskId]);

	if (!story) {
		return null;
	}

	const incompleteTasks = story.tasks.filter((task) => !task.isCompleted);
	const focusedTask = selectedTaskId
		? (incompleteTasks.find((task) => task.id === selectedTaskId) ?? null)
		: null;
	const displayTasks = focusedTask
		? [
				focusedTask,
				...incompleteTasks.filter((task) => task.id !== focusedTask.id),
			]
		: incompleteTasks;
	const effectiveRepoOwner =
		focusedTask?.repositoryOwner || repositoryOwner || undefined;
	const effectiveRepoName =
		focusedTask?.repositoryName || repositoryName || undefined;
	const effectiveBranch =
		focusedTask?.targetBranch || defaultBranch || "main";
	const hasRepositoryContext = !!effectiveRepoOwner && !!effectiveRepoName;
	const activeConnectionOption =
		FABRIC_AGENT_CONNECTIONS.find((c) => c.value === selectedConnection) ??
		FABRIC_AGENT_CONNECTIONS[0];

	const handleConfirm = () => {
		const llmConnection =
			selectedConnection && selectedConnection !== "default"
				? selectedConnection
				: undefined;
		const taskChanged = selectedTaskId !== (focusedTaskId ?? null);

		if (llmConnection || taskChanged || serverId) {
			onConfirm({
				...(serverId ? { serverId } : {}),
				...(llmConnection ? { llmConnection } : {}),
				...(taskChanged ? { taskId: selectedTaskId } : {}),
			});
		} else {
			onConfirm();
		}
	};

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
								{getExecutionProviderDescription(
									"BACKGROUND_AGENTS",
								)}
							</DialogDescription>
						</div>
					</div>
				</DialogHeader>

				<div className="flex-1 space-y-4 overflow-y-auto py-1 pr-1">
					{serverPicker}
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
						{effectiveRepoOwner && effectiveRepoName && (
							<div className="rounded-2xl border border-border/60 bg-background p-4">
								<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
									Repository
								</p>
								<p className="mt-2 flex items-center gap-2 text-sm font-medium text-foreground">
									<GitBranchIcon className="size-4 text-primary" />
									<span className="truncate">
										{effectiveRepoOwner}/{effectiveRepoName}
									</span>
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Target branch: {effectiveBranch}
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

					<div className="rounded-2xl border border-border/60 bg-background p-4">
						<div className="flex items-center justify-between gap-2">
							<label
								htmlFor="fabric-agent-connection-select"
								className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
							>
								<CpuIcon className="size-3.5 text-primary" />
								Agent backend
							</label>
							<Badge
								variant="outline"
								className="rounded-full px-2 py-0.5 text-[10px]"
							>
								{activeConnectionOption.label}
							</Badge>
						</div>
						<select
							id="fabric-agent-connection-select"
							aria-label="Agent backend"
							value={selectedConnection}
							onChange={(event) =>
								setSelectedConnection(event.target.value)
							}
							disabled={isLoading}
							className="mt-2 flex h-9 w-full rounded-xl border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						>
							{FABRIC_AGENT_CONNECTIONS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
						<p className="mt-1.5 text-xs text-muted-foreground">
							{activeConnectionOption.description}
						</p>
					</div>

					{displayTasks.length > 0 && (
						<div className="rounded-2xl border border-border/60 bg-background p-4">
							<div className="flex items-center justify-between gap-3">
								<div>
									<p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
										Tasks to implement
									</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Click a task to assign it as the primary
										task, or run all open tasks in order.
									</p>
								</div>
								<div className="flex items-center gap-2">
									{focusedTask && (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="h-6 px-2 text-[11px]"
											onClick={() =>
												setSelectedTaskId(null)
											}
										>
											All open tasks
										</Button>
									)}
									<Badge
										variant="secondary"
										className="rounded-full px-2.5 py-1 text-[11px]"
									>
										{displayTasks.length}
									</Badge>
								</div>
							</div>
							<ul className="mt-3 max-h-[180px] space-y-2 overflow-y-auto pr-1 text-sm">
								{displayTasks.map((task) => {
									const isPrimary =
										focusedTask?.id === task.id;
									return (
										<li key={task.id}>
											<button
												type="button"
												onClick={() =>
													setSelectedTaskId(
														isPrimary
															? null
															: task.id,
													)
												}
												aria-pressed={isPrimary}
												className={`flex w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors ${
													isPrimary
														? "border-primary/40 bg-primary/[0.06]"
														: "border-border/50 bg-muted/20 hover:bg-muted/40"
												}`}
											>
												<span className="mt-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary">
													{task.identifier}
												</span>
												<div className="min-w-0 flex-1">
													<div className="flex items-center justify-between gap-2">
														<span className="leading-5 text-foreground/85">
															{task.title}
														</span>
														{isPrimary ? (
															<Badge
																variant="outline"
																className="shrink-0 rounded-full border-primary/25 bg-primary/5 px-2 py-0 text-[10px] text-primary"
															>
																Primary task
															</Badge>
														) : (
															<span className="shrink-0 text-[10px] text-muted-foreground">
																Assign primary
															</span>
														)}
													</div>
												</div>
											</button>
										</li>
									);
								})}
							</ul>
						</div>
					)}

					<p className="text-xs leading-5 text-muted-foreground">
						Your selected server creates an isolated worktree,
						implements the assigned work, and opens a pull request.
						Follow its progress and conversation from this project.
					</p>
				</div>

				<DialogFooter className="flex-shrink-0 gap-2 sm:justify-between">
					<p className="text-xs leading-5 text-muted-foreground sm:max-w-[55ch]">
						Fabric will pass the feature context, branch, and tasks
						to {getExecutionProviderLabel("BACKGROUND_AGENTS")}.
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
							onClick={handleConfirm}
							disabled={
								isLoading ||
								!hasRepositoryContext ||
								serverLoading ||
								(serverRequired && !serverId)
							}
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
