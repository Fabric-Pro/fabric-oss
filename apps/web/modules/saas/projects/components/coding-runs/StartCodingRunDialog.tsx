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
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckCircle2Icon,
	CodeIcon,
	CopyIcon,
	CpuIcon,
	GitBranchIcon,
	HelpCircleIcon,
	LaptopIcon,
	ListTodoIcon,
	Loader2Icon,
	RefreshCwIcon,
	ShieldCheckIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
	TerminalIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	buildFabricDesktopNewSessionUrl,
	buildFabricDesktopViewUrl,
	buildRemoteAgentServerDelegationUrl,
	FABRIC_AGENT_CONNECTIONS,
	FABRIC_AGENT_FALLBACK_POLICIES,
	type FabricAgentFallbackPolicy,
	getExecutionProviderDescription,
	getExecutionProviderLabel,
	getFabricAgentConnectionModels,
} from "../../lib/implementation-session-labels";
import type { UserStory } from "../../lib/stories/types";

export interface StartCodingRunConfirmOptions {
	serverId?: string;
	llmConnection?: string;
	model?: string;
	fallbackPolicy?: FabricAgentFallbackPolicy;
	taskId?: string | null;
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	story: UserStory | null;
	projectId?: string;
	projectName?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
	isLoading?: boolean;
	onConfirm: (options?: StartCodingRunConfirmOptions) => void;
	focusedTaskId?: string | null;
	initialConnection?: string;
	initialModel?: string;
	initialFallbackPolicy?: FabricAgentFallbackPolicy;
	bridgeEnabled?: boolean;
	readinessBlocked?: boolean;
	readinessReason?: string | null;
	selectedServerUrl?: string;
	serverPicker?: ReactNode;
	serverId?: string;
	serverRequired?: boolean;
	serverLoading?: boolean;
};

export function StartCodingRunDialog({
	open,
	onOpenChange,
	story,
	projectId,
	projectName,
	repositoryOwner,
	repositoryName,
	defaultBranch = "main",
	isLoading = false,
	onConfirm,
	focusedTaskId,
	initialConnection = "default",
	initialModel = "default",
	initialFallbackPolicy = "subscription_harnesses",
	bridgeEnabled = true,
	readinessBlocked = false,
	readinessReason = null,
	selectedServerUrl,
	serverPicker,
	serverId,
	serverRequired = false,
	serverLoading = false,
}: Props) {
	const [selectedConnection, setSelectedConnection] =
		useState<string>(initialConnection);
	const [selectedModel, setSelectedModel] = useState<string>(initialModel);
	const [selectedFallbackPolicy, setSelectedFallbackPolicy] =
		useState<FabricAgentFallbackPolicy>(initialFallbackPolicy);
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
		focusedTaskId ?? null,
	);

	useEffect(() => {
		if (open) {
			setSelectedTaskId(focusedTaskId ?? null);
			setSelectedConnection(initialConnection);
			setSelectedModel(initialModel);
			setSelectedFallbackPolicy(initialFallbackPolicy);
		}
	}, [
		open,
		focusedTaskId,
		initialConnection,
		initialModel,
		initialFallbackPolicy,
	]);

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
	const availableModels = getFabricAgentConnectionModels(selectedConnection);
	const activeModelOption =
		availableModels.find((m) => m.id === selectedModel) ?? null;

	const handleConnectionChange = (nextConnection: string) => {
		setSelectedConnection(nextConnection);
		setSelectedModel("default");
	};

	const handleConfirm = () => {
		const llmConnection =
			bridgeEnabled &&
			selectedConnection &&
			selectedConnection !== "default"
				? selectedConnection
				: undefined;
		const model =
			bridgeEnabled && selectedModel && selectedModel !== "default"
				? selectedModel
				: undefined;
		const fallbackPolicy =
			bridgeEnabled && selectedFallbackPolicy !== "subscription_harnesses"
				? selectedFallbackPolicy
				: undefined;
		const effectiveServerId = bridgeEnabled ? serverId : undefined;
		const taskChanged = selectedTaskId !== (focusedTaskId ?? null);

		if (
			llmConnection ||
			model ||
			fallbackPolicy ||
			taskChanged ||
			effectiveServerId
		) {
			onConfirm({
				...(effectiveServerId ? { serverId: effectiveServerId } : {}),
				...(llmConnection ? { llmConnection } : {}),
				...(model ? { model } : {}),
				...(fallbackPolicy ? { fallbackPolicy } : {}),
				...(taskChanged ? { taskId: selectedTaskId } : {}),
			});
		} else {
			onConfirm();
		}
	};

	const buildMcpImplementationPrompt = () => {
		const lines = [
			`Implement feature ${story.identifier} ("${story.title}")${projectName ? ` in project "${projectName}"` : ""}${projectId ? ` (projectId: ${projectId}, featureId: ${story.id})` : ` (featureId: ${story.id})`}.`,
			effectiveRepoOwner && effectiveRepoName
				? `Repository: ${effectiveRepoOwner}/${effectiveRepoName} (base branch: ${effectiveBranch}).`
				: "",
			focusedTask
				? `Primary task: ${focusedTask.identifier} (taskId: ${focusedTask.id}) — ${focusedTask.title}`
				: incompleteTasks.length > 0
					? `Open tasks:\n${incompleteTasks.map((t) => `- ${t.identifier} (taskId: ${t.id}): ${t.title}`).join("\n")}`
					: "",
			"",
			"Use the Fabric MCP server tools to stay in sync:",
			"1. Call `fabric_get_feature` with `projectId` and `featureId` to read the latest feature specification, acceptance criteria, and task list.",
			"2. As you complete each task, call `fabric_complete_task` with `projectId` and `taskId`.",
			"3. Call `fabric_get_project_statuses` and `fabric_update_feature_status` when moving the feature status.",
		];
		return lines.filter(Boolean).join("\n");
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[90vh] flex-col sm:max-w-[640px]">
				<DialogHeader className="flex-shrink-0 space-y-4 text-left">
					<div className="flex items-start gap-3">
						<div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 shadow-sm">
							<CodeIcon className="size-5 text-primary" />
						</div>
						<div className="min-w-0 flex-1 space-y-2 pr-8">
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant="outline"
									className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-primary"
								>
									{getExecutionProviderLabel(
										"BACKGROUND_AGENTS",
									)}
								</Badge>
								<TooltipProvider delayDuration={150}>
									<Tooltip>
										<TooltipTrigger asChild>
											<a
												href="/docs/features/projects#delegating-coding-runs-to-fabric-agents"
												target="_blank"
												rel="noopener noreferrer"
												data-testid="start-coding-run-docs-link"
												aria-label="Delegating Coding Runs to Fabric Agents documentation"
												className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
											>
												<HelpCircleIcon className="size-3" />
												Delegation Guide
											</a>
										</TooltipTrigger>
										<TooltipContent className="max-w-xs space-y-1 text-xs leading-relaxed">
											<p className="font-semibold">
												Delegating Coding Runs to Fabric
												Agents
											</p>
											<p>
												Learn how to configure Personal
												or Organization Remote Servers,
												assign specific tasks, use
												subscription harnesses, and
												watch the live Server Web UI
												inside the portal.
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							</div>
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
					{readinessBlocked && readinessReason && (
						<div
							role="alert"
							className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-5 text-destructive"
						>
							{readinessReason}
						</div>
					)}
					{!hasRepositoryContext && (
						<div className="rounded-lg border border-amber-300/40 bg-amber-50/70 p-4 dark:border-amber-700/50 dark:bg-amber-950/20">
							<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
							<div className="rounded-lg border border-border/60 bg-background p-4">
								<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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

						<div className="rounded-lg border border-border/60 bg-background p-4">
							<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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

					<div className="space-y-3 rounded-lg border border-border/60 bg-background p-4">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<label
								htmlFor="fabric-agent-connection-select"
								className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
							>
								<CpuIcon className="size-3.5 text-primary" />
								Subscription harness &amp; agent backend
							</label>
							<div className="flex items-center gap-1.5">
								<Badge
									variant="secondary"
									className="rounded-full px-2 py-0.5 text-[10px]"
								>
									{activeConnectionOption.subscriptionBadge}
								</Badge>
								<Badge
									variant="outline"
									className="rounded-full px-2 py-0.5 text-[10px]"
								>
									{activeConnectionOption.label}
								</Badge>
							</div>
						</div>

						{/* Quick-select harness pills */}
						<div className="flex flex-wrap gap-1.5">
							{FABRIC_AGENT_CONNECTIONS.map((option) => {
								const isSelected =
									selectedConnection === option.value;
								return (
									<button
										key={option.value}
										aria-pressed={isSelected}
										type="button"
										disabled={isLoading}
										onClick={() =>
											handleConnectionChange(option.value)
										}
										className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
											isSelected
												? "border-primary bg-primary/10 text-primary"
												: "border-border/70 bg-muted/20 text-foreground/80 hover:border-border hover:bg-muted/40"
										}`}
									>
										<span>{option.shortLabel}</span>
									</button>
								);
							})}
						</div>

						<div className="grid gap-3 sm:grid-cols-2">
							<div>
								<span className="text-[11px] font-medium text-muted-foreground">
									Harness connection
								</span>
								<select
									id="fabric-agent-connection-select"
									aria-label="Agent backend"
									value={selectedConnection}
									onChange={(event) =>
										handleConnectionChange(
											event.target.value,
										)
									}
									disabled={isLoading}
									className="mt-1 flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
								>
									{FABRIC_AGENT_CONNECTIONS.map((option) => (
										<option
											key={option.value}
											value={option.value}
										>
											{option.label}
										</option>
									))}
								</select>
							</div>

							<div>
								<label
									htmlFor="fabric-agent-model-select"
									className="flex items-center justify-between text-[11px] font-medium text-muted-foreground"
								>
									<span>Model (defaults pre-configured)</span>
									<SparklesIcon className="size-3 text-primary" />
								</label>
								<select
									id="fabric-agent-model-select"
									aria-label="Agent model"
									value={selectedModel}
									onChange={(event) =>
										setSelectedModel(event.target.value)
									}
									disabled={isLoading}
									className="mt-1 flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
								>
									<option value="default">
										{selectedConnection === "default"
											? "Server default model (Auto)"
											: `Harness default (${activeConnectionOption.defaultModel})`}
									</option>
									{selectedConnection !== "default" &&
										availableModels.map((modelOption) => (
											<option
												key={modelOption.id}
												value={modelOption.id}
											>
												{modelOption.label} —{" "}
												{modelOption.tierLabel}
											</option>
										))}
								</select>
							</div>
						</div>

						<p className="text-xs text-muted-foreground">
							{activeModelOption
								? `${activeModelOption.label}: ${activeModelOption.description}`
								: activeConnectionOption.description}
						</p>
					</div>

					{/* Quota & Rate-Limit Fallback Policy */}
					<div className="space-y-2.5 rounded-lg border border-border/60 bg-background p-4">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<RefreshCwIcon className="size-3.5 text-primary" />
								<p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
									Browser fallback preference
								</p>
							</div>
							<Badge
								variant="outline"
								className="rounded-full border-primary/25 bg-primary/5 px-2 py-0.5 text-[10px] text-primary"
							>
								Saved preference only
							</Badge>
						</div>

						<fieldset className="grid gap-2">
							<legend className="sr-only">
								Fallback preference (saved in this browser; not
								applied to execution)
							</legend>
							{FABRIC_AGENT_FALLBACK_POLICIES.map((policy) => {
								const isSelected =
									selectedFallbackPolicy === policy.value;
								return (
									<label
										key={policy.value}
										className={`flex cursor-pointer items-start justify-between gap-3 rounded-lg border p-3 text-left transition-all ${
											isSelected
												? "border-primary bg-primary/[0.05] ring-1 ring-primary/25"
												: "border-border/60 bg-muted/15 hover:border-border hover:bg-muted/35"
										}`}
									>
										<input
											type="radio"
											name="fabric-agent-fallback-policy"
											value={policy.value}
											checked={isSelected}
											disabled={isLoading}
											onChange={() =>
												setSelectedFallbackPolicy(
													policy.value,
												)
											}
											className="sr-only"
										/>
										<div className="min-w-0 flex-1 space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<span className="text-xs font-semibold text-foreground">
													{policy.label}
												</span>
												<Badge
													variant={
														isSelected
															? "default"
															: "secondary"
													}
													className="rounded-full px-2 py-0 text-[10px]"
												>
													{policy.badge}
												</Badge>
											</div>
											<p className="text-xs leading-5 text-muted-foreground">
												{policy.description}
											</p>
										</div>
										<div className="mt-0.5 shrink-0">
											{isSelected ? (
												<CheckCircle2Icon className="size-4 text-primary" />
											) : (
												<ShieldCheckIcon className="size-4 text-muted-foreground/40" />
											)}
										</div>
									</label>
								);
							})}
						</fieldset>
					</div>

					{displayTasks.length > 0 && (
						<div className="rounded-lg border border-border/60 bg-background p-4">
							<div className="flex items-center justify-between gap-3">
								<div>
									<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
												className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
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

					{/* Direct Assignment to Fabric Agents Desktop / CLI */}
					<div className="space-y-2.5 rounded-lg border border-border bg-muted/20 p-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2 text-xs">
								<TerminalIcon className="size-3.5 text-primary" />
								<span className="font-semibold text-foreground">
									Assign to Fabric Agents Desktop or
									Subscription CLI
								</span>
							</div>
							<Badge
								variant="outline"
								className="rounded-full px-2 py-0 text-[10px] text-muted-foreground"
							>
								Uses your selected subscription harness &amp;
								model
							</Badge>
						</div>
						<p className="text-xs leading-5 text-muted-foreground">
							Prefer to run Claude Code, Codex, Cursor,
							Antigravity, or Fabric Desktop directly? Copy the
							MCP-ready prompt or launch your local Fabric Agents
							Desktop app with your chosen subscription harness
							pre-selected.
						</p>
						<div className="flex flex-wrap items-center gap-1.5">
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="h-7 px-2.5 text-xs"
								data-testid="dialog-copy-mcp-prompt"
								onClick={async () => {
									try {
										await navigator.clipboard.writeText(
											buildMcpImplementationPrompt(),
										);
										toast.success(
											"Copied implementation prompt with Fabric MCP instructions",
										);
									} catch {
										toast.error("Failed to copy prompt");
									}
								}}
							>
								<CopyIcon className="mr-1.5 size-3" />
								Copy implementation prompt
							</Button>
							<Button
								asChild
								variant="outline"
								size="sm"
								className="h-7 px-2.5 text-xs"
							>
								<a
									href={buildFabricDesktopNewSessionUrl({
										projectName:
											projectName ||
											repositoryName ||
											story.title ||
											"Fabric Project",
										projectId,
										origin:
											typeof window !== "undefined"
												? window.location.origin
												: null,
										connection: selectedConnection,
										model: selectedModel,
										fallbackPolicy: selectedFallbackPolicy,
										prompt: `Implement feature ${story.identifier} ("${story.title}")${focusedTask ? ` — primary task ${focusedTask.identifier}: ${focusedTask.title}` : ""}${effectiveRepoOwner && effectiveRepoName ? ` in ${effectiveRepoOwner}/${effectiveRepoName}` : ""}${effectiveBranch ? ` (base branch: ${effectiveBranch})` : ""}.`,
									})}
									data-testid="dialog-launch-fabric-desktop"
								>
									<LaptopIcon className="mr-1.5 size-3" />
									Open in Fabric Agents Desktop
								</a>
							</Button>
							{selectedServerUrl && (
								<Button
									asChild
									variant="outline"
									size="sm"
									className="h-7 px-2.5 text-xs"
								>
									<a
										href={buildRemoteAgentServerDelegationUrl(
											{
												serverUrl: selectedServerUrl,
												projectName:
													projectName ||
													repositoryName ||
													story.title ||
													"Fabric Project",
												projectId,
												origin:
													typeof window !==
													"undefined"
														? window.location.origin
														: null,
												prompt: `Implement feature "${story.title}"${effectiveRepoOwner && effectiveRepoName ? ` in ${effectiveRepoOwner}/${effectiveRepoName}` : ""}${effectiveBranch ? ` (base branch: ${effectiveBranch})` : ""}.`,
												connection: selectedConnection,
												model: selectedModel,
												fallbackPolicy:
													selectedFallbackPolicy,
											},
										)}
										target="_blank"
										rel="noopener noreferrer"
										data-testid="dialog-delegate-remote-server"
									>
										<CpuIcon className="mr-1.5 size-3" />
										Open Selected Fabric Agents Remote
										Server
									</a>
								</Button>
							)}
							<Button
								asChild
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
							>
								<a
									href={buildFabricDesktopViewUrl("settings")}
									data-testid="dialog-fabric-desktop-ai-settings"
								>
									<SlidersHorizontalIcon className="mr-1 size-3" />
									AI Connections
								</a>
							</Button>
						</div>
					</div>
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
								readinessBlocked ||
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
