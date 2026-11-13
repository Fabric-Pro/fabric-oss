"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ExecuteWithWeaveButton } from "@saas/weave/components";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckCircleIcon,
	ChevronDownIcon,
	ClockIcon,
	CloudIcon,
	FlaskConicalIcon,
	GitBranchIcon,
	LaptopIcon,
	SearchIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	type ExecutionChannel,
	type ExecutionProvider,
	getExecutionProviderDescription,
	getExecutionProviderPlatformLabel,
} from "../../lib/implementation-session-labels";
import { isStoryRunnable } from "../../lib/stories/readiness";
import type { UserStory } from "../../lib/stories/types";
import { StartImplementationSessionButton } from "../coding-runs/StartImplementationSessionButton";
import { RunDiscoveryDialog } from "./RunDiscoveryDialog";
import { RunSpikeDialog } from "./RunSpikeDialog";
import { useStoryReadiness } from "./useStoryReadiness";

type Props = {
	projectId: string;
	storyId: string;
	story: UserStory;
	projectName?: string;
	canExecuteAgents?: boolean;
	readOnlyMode?: boolean;
	hasActiveCodingRun?: boolean;
	implementationOpen?: boolean;
	onImplementationOpenChange?: (open: boolean) => void;
	focusedTaskId?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	defaultBranch?: string | null;
	repoUrl?: string;
	implementationDefaultChannel?: ExecutionChannel | null;
	implementationDefaultProvider?: ExecutionProvider | null;
	className?: string;
	size?: "default" | "sm" | "lg" | "icon";
	onImplementationStarted?: () => void;
};

export function StartWorkButton({
	projectId,
	storyId,
	story,
	projectName,
	canExecuteAgents = false,
	readOnlyMode = false,
	hasActiveCodingRun = false,
	implementationOpen: controlledImplementationOpen,
	onImplementationOpenChange: controlledOnImplementationOpenChange,
	focusedTaskId = null,
	repositoryOwner,
	repositoryName,
	defaultBranch,
	repoUrl,
	implementationDefaultChannel,
	implementationDefaultProvider,
	className,
	size,
	onImplementationStarted,
}: Props) {
	const { organizationId } = useOrganizationContext();
	const [internalImplementationOpen, setInternalImplementationOpen] =
		useState(false);
	const implementationOpen =
		controlledImplementationOpen ?? internalImplementationOpen;
	const setImplementationOpen =
		controlledOnImplementationOpenChange ?? setInternalImplementationOpen;
	const [weaveOpen, setWeaveOpen] = useState(false);
	const [discoveryOpen, setDiscoveryOpen] = useState(false);
	const [spikeOpen, setSpikeOpen] = useState(false);
	const tStories = useTranslations("tooltips.stories");
	const tSpike = useTranslations("projects.stories.spike.startWork");

	const hasRepositoryContext = !!repositoryOwner && !!repositoryName;

	// Readiness gate (plan §1.1 / Slice 5). Implementation items are disabled
	// until the feature is PUBLISHED and its enforced gaps are resolved;
	// advisory gaps are shown as a hint and never disable. DEFER hides the
	// menu entirely. While loading, fail closed (disabled) rather than guess.
	const tReadiness = useTranslations("projects.stories.readiness");
	const { data: readiness, isPending: readinessPending } = useStoryReadiness({
		projectId,
		storyId: story.id,
		organizationId,
		version: story.version,
	});
	const isDeferred =
		readiness?.effectiveTrack === "DEFER" ||
		story.deliveryTrack === "DEFER";
	// "Run a spike" (plan Slice 3): offered for SPIKE items only. It is not
	// gated by readiness because the spike is what produces the evidence the
	// gate asks for; DEFER already hides the whole menu.
	const isSpikeTrack =
		!isDeferred &&
		(story.deliveryTrack === "SPIKE" ||
			readiness?.effectiveTrack === "SPIKE");
	const runnable = isStoryRunnable(readiness);
	const runBlocked =
		readinessPending ||
		!runnable ||
		!canExecuteAgents ||
		readOnlyMode ||
		hasActiveCodingRun;
	const blockedReason = (() => {
		if (!canExecuteAgents) {
			return "You do not have permission to execute coding runs on this project.";
		}
		if (readOnlyMode) {
			return "Project is in read-only mode.";
		}
		if (hasActiveCodingRun) {
			return "An implementation session is already active on this feature.";
		}
		if (readinessPending) {
			return tReadiness("loading");
		}
		if (!readiness) {
			return tReadiness("gaps.EVIDENCE_UNAVAILABLE");
		}
		if (readiness.draftingStage !== "PUBLISHED") {
			return tReadiness("startWork.blockedNotPublished");
		}
		if (readiness.missing.length > 0) {
			return `${tReadiness("startWork.blocked")} ${readiness.missing
				.map((gap) => tReadiness(`gaps.${gap}`))
				.join(", ")}`;
		}
		return null;
	})();
	const advisoryHint =
		readiness && readiness.advisory.length > 0
			? tReadiness("startWork.advisoryHint", {
					gaps: readiness.advisory
						.map((gap) => tReadiness(`gaps.${gap}`))
						.join(", "),
				})
			: null;

	const kanbanQueue = story.latestKanbanQueue;
	const isQueued = kanbanQueue?.status === "PENDING";
	const isPulled = kanbanQueue?.status === "PULLED";
	const isCompleted = kanbanQueue?.status === "COMPLETED";

	return (
		<>
			<div className="flex items-center gap-2">
				{/* Queue status badge */}
				{isQueued && (
					<span className="flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-400">
						<ClockIcon className="size-3" />
						Queued
					</span>
				)}
				{isPulled && (
					<span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400">
						<CheckCircleIcon className="size-3" />
						Pulled locally
					</span>
				)}
				{isCompleted && (
					<span className="flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">
						<GitBranchIcon className="size-3" />
						{kanbanQueue?.branchName
							? `Ready for review · ${kanbanQueue.branchName}`
							: "Ready for review"}
					</span>
				)}

				{/* DEFER: nothing can start — hide the menu (plan §1.1). */}
				{!isDeferred && (
					<DropdownMenu modal={false}>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<Button
										size={size}
										className={cn("gap-2", className)}
									>
										<SparklesIcon className="size-4" />
										<span>Start work</span>
										<ChevronDownIcon className="size-4 opacity-70" />
									</Button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs text-xs leading-5">
								<p>
									{runBlocked && blockedReason
										? blockedReason
										: tStories("startWork")}
								</p>
								{/* One line per gap: what unblocks it, and whether the
								    gate is enforced or advisory on this project. */}
								{readiness &&
									(readiness.missing.length > 0 ||
										readiness.advisory.length > 0) && (
										<ul className="mt-1 space-y-0.5 text-muted-foreground">
											{readiness.missing.map((gap) => (
												<li key={`m-${gap}`}>
													{tStories(
														`readinessGap.${gap}`,
													)}{" "}
													{tStories(
														"readinessEnforced",
													)}
												</li>
											))}
											{readiness.advisory.map((gap) => (
												<li key={`a-${gap}`}>
													{tStories(
														`readinessGap.${gap}`,
													)}{" "}
													{tStories(
														"readinessAdvisory",
													)}
												</li>
											))}
										</ul>
									)}
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="end" className="w-80">
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
								Choose how to begin this feature
							</DropdownMenuLabel>
							{/* Readiness hint: blocking reason (disables items) or
						    advisory gaps (never disables). */}
							{runBlocked && blockedReason ? (
								<output className="block px-2 pb-1.5 text-xs leading-5 text-destructive">
									{blockedReason}
								</output>
							) : advisoryHint ? (
								<p className="px-2 pb-1.5 text-xs leading-5 text-muted-foreground">
									{advisoryHint}
								</p>
							) : null}
							<DropdownMenuSeparator />

							{/* Run a spike — SPIKE track only, never readiness-gated */}
							{isSpikeTrack && (
								<>
									<DropdownMenuItem
										onClick={() => setSpikeOpen(true)}
										data-testid="start-work-run-spike"
									>
										<div className="space-y-1">
											<p className="flex items-center gap-2 text-sm font-medium">
												<FlaskConicalIcon className="size-4" />
												{tSpike("runSpike")}
											</p>
											<p className="text-xs leading-5 text-muted-foreground">
												{tSpike("runSpikeDescription")}
											</p>
										</div>
									</DropdownMenuItem>
									<DropdownMenuSeparator />
								</>
							)}

							{/* Plan with Weave */}
							<DropdownMenuItem
								onClick={() => setWeaveOpen(true)}
							>
								<div className="space-y-1">
									<p className="text-sm font-medium">
										Plan with Weave
									</p>
									<p className="text-xs leading-5 text-muted-foreground">
										Plan, orchestrate, and monitor before
										handing implementation off.
									</p>
								</div>
							</DropdownMenuItem>

							<DropdownMenuSeparator />

							{/* Fabric Agents Remote Server */}
							<DropdownMenuItem
								disabled={runBlocked}
								aria-disabled={runBlocked}
								title={
									runBlocked
										? (blockedReason ?? undefined)
										: undefined
								}
								onClick={() => {
									if (!runBlocked) {
										setImplementationOpen(true);
									}
								}}
							>
								<div className="space-y-1">
									<p className="flex items-center gap-2 text-sm font-medium">
										<CloudIcon className="size-4" />
										Fabric Agents Remote Server
									</p>
									<p className="text-xs leading-5 text-muted-foreground">
										{getExecutionProviderDescription(
											"BACKGROUND_AGENTS",
										)}
									</p>
									<p className="text-[11px] leading-5 text-muted-foreground">
										Personal or Organization Fabric Agents
										Remote Server
									</p>
								</div>
							</DropdownMenuItem>

							{/* Fabric Agents Desktop */}
							<DropdownMenuItem
								disabled={runBlocked}
								aria-disabled={runBlocked}
								title={
									runBlocked
										? (blockedReason ?? undefined)
										: undefined
								}
								onClick={() => {
									if (!runBlocked) {
										setImplementationOpen(true);
									}
								}}
								data-testid="start-work-use-coding-tool"
							>
								<div className="space-y-1">
									<p className="flex items-center gap-2 text-sm font-medium">
										<LaptopIcon className="size-4" />
										Fabric Agents Desktop &amp; Subscription
										CLI
									</p>
									<p className="text-xs leading-5 text-muted-foreground">
										Launch Fabric Agents Desktop locally or
										copy an MCP prompt for Claude Code,
										Codex, Cursor, or Antigravity using your
										subscription tokens.
									</p>
									<p className="text-[11px] leading-5 text-muted-foreground">
										Powered by{" "}
										{getExecutionProviderPlatformLabel(
											"KANBAN_LOCAL",
										)}
									</p>
								</div>
							</DropdownMenuItem>
							{/* Discovery run (plan Slice 4): DISCOVERY-track features
							    draft an integration contract instead of code. */}
							{story.deliveryTrack === "DISCOVERY" && (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										onClick={() => setDiscoveryOpen(true)}
									>
										<div className="space-y-1">
											<p className="flex items-center gap-2 text-sm font-medium">
												<SearchIcon className="size-4" />
												Run discovery
											</p>
											<p className="text-xs leading-5 text-muted-foreground">
												Draft an integration contract
												from the repository, an OpenAPI
												spec and MCP servers, then post
												open questions.
											</p>
										</div>
									</DropdownMenuItem>
								</>
							)}
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>

			{story.deliveryTrack === "DISCOVERY" && (
				<RunDiscoveryDialog
					projectId={projectId}
					storyId={storyId}
					storyIdentifier={story.identifier}
					hasRepository={hasRepositoryContext || !!repoUrl}
					open={discoveryOpen}
					onOpenChange={setDiscoveryOpen}
				/>
			)}

			<StartImplementationSessionButton
				projectId={projectId}
				story={story}
				projectName={projectName}
				canExecuteAgents={canExecuteAgents}
				readOnlyMode={readOnlyMode}
				focusedTaskId={focusedTaskId}
				repositoryOwner={repositoryOwner}
				repositoryName={repositoryName}
				defaultBranch={defaultBranch}
				implementationDefaultChannel={implementationDefaultChannel}
				implementationDefaultProvider={implementationDefaultProvider}
				open={implementationOpen}
				onOpenChange={setImplementationOpen}
				hideTrigger
				variant="outline"
				size="sm"
				onStarted={onImplementationStarted}
			/>

			{isSpikeTrack && (
				<RunSpikeDialog
					open={spikeOpen}
					onOpenChange={setSpikeOpen}
					projectId={projectId}
					story={story}
					repositoryOwner={repositoryOwner}
					repositoryName={repositoryName}
					implementationDefaultProvider={
						implementationDefaultProvider
					}
					onStarted={() => onImplementationStarted?.()}
				/>
			)}

			<ExecuteWithWeaveButton
				projectId={projectId}
				implementationDefaultProvider={implementationDefaultProvider}
				storyId={storyId}
				repoUrl={repoUrl}
				open={weaveOpen}
				onOpenChange={setWeaveOpen}
				hideTrigger
				variant="default"
				size="sm"
				storyContext={{
					title: story.title,
					description: story.description ?? undefined,
					acceptanceCriteria: story.acceptanceCriteria ?? undefined,
				}}
			/>
		</>
	);
}
