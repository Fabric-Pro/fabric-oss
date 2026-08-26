"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	BotIcon,
	FilePenLineIcon,
	ListChecksIcon,
	MessageSquareReplyIcon,
	PlayIcon,
	SparklesIcon,
	WorkflowIcon,
} from "lucide-react";

interface AgentActivityTabProps {
	projectId: string;
}

const ACTIVITY_CONFIG = {
	task_created: {
		label: "Task",
		icon: ListChecksIcon,
		className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
	},
	project_update_draft_saved: {
		label: "Update draft",
		icon: FilePenLineIcon,
		className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
	},
	implementation_session_started: {
		label: "Implementation",
		icon: PlayIcon,
		className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
	skill_saved: {
		label: "Skill",
		icon: SparklesIcon,
		className: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
	},
	automation_trigger_saved: {
		label: "Automation",
		icon: WorkflowIcon,
		className: "bg-primary/10 text-primary",
	},
	agent_comment_replied: {
		label: "Agent reply",
		icon: MessageSquareReplyIcon,
		className: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
	},
} as const;

export function AgentActivityTab({ projectId }: AgentActivityTabProps) {
	const { organizationId } = useOrganizationContext();
	const { data, isLoading } = useQuery(
		orpc.agents.activity.list.queryOptions({
			input: {
				projectId,
				organizationId: organizationId ?? null,
				limit: 50,
			},
		}),
	);

	const activities = data?.activity ?? [];

	return (
		<div className="space-y-6">
			<div
				data-onboarding-target="agent-activity-header"
				className="rounded-2xl border border-border/70 bg-card/70 p-5 shadow-sm"
			>
				<div className="flex items-start justify-between gap-4">
					<div>
						<div className="mb-2 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-2.5 py-1 text-xs font-medium text-primary">
							<BotIcon className="size-3.5" />
							Agent Activity
						</div>
						<div className="flex items-center gap-1.5">
							<h2 className="text-xl font-semibold tracking-tight">
								Approved Fabric Agent actions
							</h2>
							<PageTourButton pageId="agent-activity" />
						</div>
						<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
							Review task creation, update drafts, implementation
							sessions, saved Skills, and automation triggers
							created through human-approved Fabric Agent flows.
						</p>
					</div>
					<Badge variant="outline" className="shrink-0">
						{activities.length} events
					</Badge>
				</div>
			</div>

			<div
				data-onboarding-target="agent-activity-list"
				className="rounded-2xl border border-border/70 bg-background/70 shadow-sm"
			>
				{isLoading ? (
					<div className="space-y-4 p-5">
						{Array.from({ length: 5 }).map((_, index) => (
							<div key={index} className="flex gap-3">
								<Skeleton className="size-9 rounded-full" />
								<div className="flex-1 space-y-2">
									<Skeleton className="h-4 w-2/3" />
									<Skeleton className="h-3 w-1/2" />
								</div>
							</div>
						))}
					</div>
				) : activities.length === 0 ? (
					<div className="flex flex-col items-center justify-center px-6 py-16 text-center">
						<div className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
							<BotIcon className="size-6 text-muted-foreground" />
						</div>
						<h3 className="font-medium">
							No approved agent actions yet
						</h3>
						<p className="mt-1 max-w-md text-sm text-muted-foreground">
							Use Fabric Agent to draft updates, create tasks,
							start implementation sessions, or save reusable
							Skills. Approved actions will appear here.
						</p>
					</div>
				) : (
					<ol className="divide-y divide-border/70">
						{activities.map((activity) => {
							const config =
								ACTIVITY_CONFIG[
									activity.type as keyof typeof ACTIVITY_CONFIG
								] ?? ACTIVITY_CONFIG.skill_saved;
							const Icon = config.icon;
							return (
								<li key={activity.id} className="p-5">
									<div className="flex gap-3">
										<div
											className={cn(
												"mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
												config.className,
											)}
										>
											<Icon className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<p className="font-medium text-sm text-foreground">
													{activity.title}
												</p>
												<Badge
													variant="secondary"
													className="text-[10px]"
												>
													{config.label}
												</Badge>
											</div>
											{activity.description && (
												<p className="mt-1 text-sm text-muted-foreground">
													{activity.description}
												</p>
											)}
											<p className="mt-2 text-xs text-muted-foreground/70">
												{formatRelativeTime(
													activity.createdAt,
												)}
											</p>
										</div>
									</div>
								</li>
							);
						})}
					</ol>
				)}
			</div>
		</div>
	);
}
