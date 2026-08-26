"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { formatRelativeTime } from "@saas/shared/lib/format-time";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	BotIcon,
	CheckCircle2Icon,
	ClockIcon,
	Code2Icon,
	ExternalLinkIcon,
	FilePenLineIcon,
	InboxIcon,
	MessageSquareReplyIcon,
	PlayCircleIcon,
	RocketIcon,
	ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

type InboxStatus =
	| "all"
	| "running"
	| "needs_review"
	| "failed"
	| "completed"
	| "agent_replies";

interface AgentInboxViewProps {
	organizationId?: string | null;
	basePath?: string;
}

const FILTERS: Array<{ value: InboxStatus; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "needs_review", label: "Needs review" },
	{ value: "failed", label: "Failed" },
	{ value: "completed", label: "Completed" },
	{ value: "agent_replies", label: "Agent replies" },
];

const TYPE_CONFIG = {
	agent_reply: {
		label: "Agent reply",
		icon: MessageSquareReplyIcon,
		className: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
	},
	coding_run: {
		label: "Coding run",
		icon: Code2Icon,
		className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
	agent_task: {
		label: "Agent task",
		icon: BotIcon,
		className: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
	},
	deployment_execution: {
		label: "Deployment",
		icon: RocketIcon,
		className: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
	},
	project_update_draft: {
		label: "Update draft",
		icon: FilePenLineIcon,
		className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
	},
} as const;

const STATUS_CONFIG = {
	running: {
		label: "Running",
		icon: PlayCircleIcon,
		className: "text-blue-600",
	},
	needs_review: {
		label: "Needs review",
		icon: ShieldCheckIcon,
		className: "text-amber-600",
	},
	failed: {
		label: "Failed",
		icon: AlertTriangleIcon,
		className: "text-red-600",
	},
	completed: {
		label: "Completed",
		icon: CheckCircle2Icon,
		className: "text-emerald-600",
	},
} as const;

function buildProjectHref(
	basePath: string,
	item: {
		project?: { id: string; name: string | null } | null;
		target?: { storyId?: string; taskId?: string } | null;
	},
) {
	if (!item.project?.id) {
		return null;
	}
	const params = new URLSearchParams();
	if (item.target?.storyId) {
		params.set("story", item.target.storyId);
	}
	if (item.target?.taskId) {
		params.set("task", item.target.taskId);
	}
	const suffix = params.toString() ? `?${params.toString()}` : "";
	return `${basePath}/projects/${item.project.id}${suffix}`;
}

export function AgentInboxView({
	organizationId: organizationIdProp,
	basePath: basePathProp,
}: AgentInboxViewProps) {
	const orgContext = useOrganizationContext();
	const organizationId =
		organizationIdProp ?? orgContext.organizationId ?? null;
	const basePath = basePathProp ?? orgContext.basePath ?? "/app";
	const [status, setStatus] = useState<InboxStatus>("all");

	const { data, isLoading } = useQuery(
		orpc.agents.inbox.list.queryOptions({
			input: { organizationId, status, limit: 50 },
		}),
	);
	const items = data?.items ?? [];

	return (
		<div className="space-y-6">
			<div className="rounded-2xl border border-border/70 bg-card/70 p-6 shadow-sm">
				<div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
					<div>
						<div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-2.5 py-1 text-primary text-xs font-medium">
							<InboxIcon className="size-3.5" />
							Workspace Agent Inbox
						</div>
						<h1 className="text-2xl font-semibold tracking-tight">
							What your agents are doing
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
							Track Fabric Agent replies, implementation sessions,
							agent tasks, deployment runs, and generated project
							update drafts across this workspace.
						</p>
					</div>
					<Badge variant="outline" className="w-fit">
						{items.length} visible
					</Badge>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
				{FILTERS.map((filter) => (
					<Button
						key={filter.value}
						variant={
							status === filter.value ? "default" : "outline"
						}
						size="sm"
						onClick={() => setStatus(filter.value)}
					>
						{filter.label}
					</Button>
				))}
			</div>

			<div className="rounded-2xl border border-border/70 bg-background/70 shadow-sm">
				{isLoading ? (
					<div className="space-y-4 p-5">
						{Array.from({ length: 6 }).map((_, index) => (
							<div key={index} className="flex gap-3">
								<Skeleton className="size-10 rounded-full" />
								<div className="flex-1 space-y-2">
									<Skeleton className="h-4 w-2/3" />
									<Skeleton className="h-3 w-1/2" />
								</div>
							</div>
						))}
					</div>
				) : items.length === 0 ? (
					<div className="flex flex-col items-center justify-center px-6 py-16 text-center">
						<div className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
							<InboxIcon className="size-6 text-muted-foreground" />
						</div>
						<h3 className="font-medium">
							No agent inbox items yet
						</h3>
						<p className="mt-1 max-w-md text-muted-foreground text-sm">
							Agent replies, implementation sessions, deployment
							runs, and update drafts will appear here as they
							happen.
						</p>
					</div>
				) : (
					<ol className="divide-y divide-border/70">
						{items.map((item) => {
							const typeConfig =
								TYPE_CONFIG[
									item.type as keyof typeof TYPE_CONFIG
								] ?? TYPE_CONFIG.agent_task;
							const statusConfig =
								STATUS_CONFIG[
									item.status as keyof typeof STATUS_CONFIG
								] ?? STATUS_CONFIG.running;
							const TypeIcon = typeConfig.icon;
							const StatusIcon = statusConfig.icon;
							const href = buildProjectHref(basePath, item);

							return (
								<li key={item.id} className="p-5">
									<div className="flex gap-3">
										<div
											className={cn(
												"mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full",
												typeConfig.className,
											)}
										>
											<TypeIcon className="size-4" />
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<p className="font-medium text-foreground text-sm">
													{item.title}
												</p>
												<Badge
													variant="secondary"
													className="text-[10px]"
												>
													{typeConfig.label}
												</Badge>
												<span
													className={cn(
														"inline-flex items-center gap-1 text-xs",
														statusConfig.className,
													)}
												>
													<StatusIcon className="size-3" />
													{statusConfig.label}
												</span>
											</div>
											{item.description && (
												<p className="mt-1 text-muted-foreground text-sm">
													{item.description}
												</p>
											)}
											<div className="mt-2 flex flex-wrap items-center gap-3 text-muted-foreground/75 text-xs">
												<span className="inline-flex items-center gap-1">
													<ClockIcon className="size-3" />
													{formatRelativeTime(
														item.updatedAt ??
															item.createdAt,
													)}
												</span>
												{item.project?.name && (
													<span>
														{item.project.name}
													</span>
												)}
												{href && (
													<Link
														href={href}
														className="inline-flex items-center gap-1 text-primary hover:underline"
													>
														Open project
														<ExternalLinkIcon className="size-3" />
													</Link>
												)}
											</div>
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
