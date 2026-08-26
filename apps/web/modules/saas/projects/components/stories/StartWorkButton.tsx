"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ExecuteWithWeaveButton } from "@saas/weave/components";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
	GitBranchIcon,
	LaptopIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	type ExecutionChannel,
	type ExecutionProvider,
	getExecutionProviderDescription,
	getExecutionProviderLabel,
	getExecutionProviderPlatformLabel,
} from "../../lib/implementation-session-labels";
import type { UserStory } from "../../lib/stories/types";
import { StartImplementationSessionButton } from "../coding-runs/StartImplementationSessionButton";

type Props = {
	projectId: string;
	storyId: string;
	story: UserStory;
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
	const queryClient = useQueryClient();
	const [implementationOpen, setImplementationOpen] = useState(false);
	const [weaveOpen, setWeaveOpen] = useState(false);
	const tStories = useTranslations("tooltips.stories");

	const hasRepositoryContext = !!repositoryOwner && !!repositoryName;

	const kanbanQueue = story.latestKanbanQueue;
	const isQueued = kanbanQueue?.status === "PENDING";
	const isPulled = kanbanQueue?.status === "PULLED";
	const isCompleted = kanbanQueue?.status === "COMPLETED";

	const queueMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.queueForKanban({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.queryKey({
						input: { projectId, organizationId },
					}),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.get.queryKey({
						input: {
							projectId,
							storyId: story.id,
							organizationId,
						},
					}),
				}),
			]);
			toast.success(
				`Queued for ${getExecutionProviderLabel("KANBAN_LOCAL")}`,
				{
					description:
						"Run `fabric-kanban` in your repository to pull queued items.",
				},
			);
			onImplementationStarted?.();
		},
		onError: (error) => {
			toast.error(
				`Failed to queue for ${getExecutionProviderLabel("KANBAN_LOCAL")}`,
				{
					description: error.message,
				},
			);
		},
	});

	const localDevelopmentDescription = (() => {
		if (!hasRepositoryContext) {
			return "Connect a repository first";
		}
		if (isQueued) {
			return "Queued — waiting to be pulled by fabric-kanban";
		}
		if (isPulled) {
			return "Pulled into local development. Queue again to re-implement.";
		}
		if (isCompleted) {
			return kanbanQueue?.branchName
				? `Ready for review on branch ${kanbanQueue.branchName}. Queue again to re-implement.`
				: "Ready for review. Queue again to re-implement.";
		}
		return "Queue for local development. Run `fabric-kanban` in your repo to pull.";
	})();

	return (
		<>
			<div className="flex items-center gap-2">
				{/* Queue status badge */}
				{isQueued && (
					<span className="flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
						<ClockIcon className="size-3" />
						Queued
					</span>
				)}
				{isPulled && (
					<span className="flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
						<CheckCircleIcon className="size-3" />
						Pulled locally
					</span>
				)}
				{isCompleted && (
					<span className="flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
						<GitBranchIcon className="size-3" />
						{kanbanQueue?.branchName
							? `Ready for review · ${kanbanQueue.branchName}`
							: "Ready for review"}
					</span>
				)}

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
						<TooltipContent>{tStories("startWork")}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent align="end" className="w-80">
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
							Choose how to begin this feature
						</DropdownMenuLabel>
						<DropdownMenuSeparator />

						{/* Plan with Weave */}
						<DropdownMenuItem onClick={() => setWeaveOpen(true)}>
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

						{/* Background Agents */}
						<DropdownMenuItem
							onClick={() => setImplementationOpen(true)}
						>
							<div className="space-y-1">
								<p className="flex items-center gap-2 text-sm font-medium">
									<CloudIcon className="size-4" />
									{getExecutionProviderLabel(
										"BACKGROUND_AGENTS",
									)}
								</p>
								<p className="text-xs leading-5 text-muted-foreground">
									{getExecutionProviderDescription(
										"BACKGROUND_AGENTS",
									)}
								</p>
							</div>
						</DropdownMenuItem>

						{/* Local development */}
						<DropdownMenuItem
							disabled={
								!hasRepositoryContext || queueMutation.isPending
							}
							onClick={() => {
								if (hasRepositoryContext) {
									queueMutation.mutate();
								}
							}}
						>
							<div className="space-y-1">
								<p className="flex items-center gap-2 text-sm font-medium">
									<LaptopIcon className="size-4" />
									{getExecutionProviderLabel("KANBAN_LOCAL")}
									{isQueued && (
										<span className="ml-auto text-[10px] text-amber-500">
											Re-queue
										</span>
									)}
									{isPulled && (
										<span className="ml-auto text-[10px] text-muted-foreground">
											Re-queue
										</span>
									)}
								</p>
								<p className="text-xs leading-5 text-muted-foreground">
									{localDevelopmentDescription}
								</p>
								<p className="text-[11px] leading-5 text-muted-foreground/80">
									Powered by{" "}
									{getExecutionProviderPlatformLabel(
										"KANBAN_LOCAL",
									)}
								</p>
							</div>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<StartImplementationSessionButton
				projectId={projectId}
				story={story}
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
