"use client";

import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { ProjectInviteWelcomeWidget } from "@saas/dashboard/components/ProjectInviteWelcomeWidget";
import { PendingInvitationsBanner } from "@saas/shared/components/PendingInvitationsBanner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	FileTextIcon,
	FolderIcon,
	TrendingUpIcon,
	UsersIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DashboardHero, type TimeRange } from "./DashboardHero";
import { DashboardLineChart } from "./DashboardLineChart";
import { MetricCard } from "./MetricCard";
import { MyWorkPanel } from "./MyWorkPanel";
import { QuickActions } from "./QuickActions";
import { RecentChats } from "./RecentChats";

interface OrganizationDashboardProps {
	organizationId: string;
	organizationName: string;
	organizationSlug: string;
	brandColor?: string;
}

function timeRangeToSince(range: TimeRange): string | undefined {
	const now = new Date();
	switch (range) {
		case "today": {
			const d = new Date(now);
			d.setHours(0, 0, 0, 0);
			return d.toISOString();
		}
		case "7d":
			return new Date(
				now.getTime() - 7 * 24 * 60 * 60 * 1000,
			).toISOString();
		case "30d":
			return new Date(
				now.getTime() - 30 * 24 * 60 * 60 * 1000,
			).toISOString();
		case "90d":
			return new Date(
				now.getTime() - 90 * 24 * 60 * 60 * 1000,
			).toISOString();
		case "all":
			return undefined;
	}
}

function timeRangeToDays(range: TimeRange): number {
	switch (range) {
		case "today":
			return 1;
		case "7d":
			return 7;
		case "30d":
			return 30;
		case "90d":
			return 90;
		case "all":
			return 180;
	}
}

interface ActivityItem {
	timestamp: Date;
}

// Returns YYYY-MM-DD in the user's LOCAL timezone (avoids UTC day-shift bugs)
function toLocalDateKey(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function generateTimeSeries(
	activities: ActivityItem[],
	days: number,
): { date: string; count: number }[] {
	const now = new Date();
	const dateMap = new Map<string, number>();

	for (let i = days; i >= 0; i--) {
		const d = new Date(now);
		d.setDate(d.getDate() - i);
		dateMap.set(toLocalDateKey(d), 0);
	}

	for (const activity of activities) {
		const key = toLocalDateKey(activity.timestamp);
		if (dateMap.has(key)) {
			dateMap.set(key, (dateMap.get(key) ?? 0) + 1);
		}
	}

	// Convert to cumulative totals for a smooth upward-trending line
	let cumulative = 0;
	return Array.from(dateMap.entries()).map(([date, count]) => {
		cumulative += count;
		return { date, count: cumulative };
	});
}

function normalizeTaskStatus(status: string): string {
	return status.toLowerCase();
}

export function OrganizationDashboard({
	organizationId,
	organizationName,
	organizationSlug,
	brandColor,
}: OrganizationDashboardProps) {
	const { user } = useSession();
	const router = useRouter();
	const queryClient = useQueryClient();
	const basePath = `/app/${organizationSlug}`;
	const [timeRange, setTimeRange] = useState<TimeRange>("90d");

	const since = useMemo(() => timeRangeToSince(timeRange), [timeRange]);
	const days = timeRangeToDays(timeRange);

	const handleRefresh = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["dashboard"] });
	}, [queryClient]);

	const { data: stats, isLoading: statsLoading } = useQuery({
		queryKey: ["dashboard", "stats", organizationId, timeRange],
		queryFn: async () =>
			await orpcClient.dashboard.stats({ organizationId, since }),
		refetchInterval: 5 * 60 * 1000, // was 30s; each poll fans out to ~11 DB queries
	});

	const { data: activity, isLoading: activityLoading } = useQuery({
		queryKey: ["dashboard", "activity", organizationId, timeRange],
		queryFn: async () =>
			await orpcClient.dashboard.activity({
				organizationId,
				limit: 50,
				since,
			}),
		refetchInterval: 5 * 60 * 1000, // was 30s; each poll fans out to ~11 DB queries
	});

	// Transform activity data for timeline
	const timelineActivities = useMemo(
		() =>
			activity
				? [
						...activity.projects.map((project: any) => ({
							id: project.id,
							type: "project" as const,
							title: project.name,
							subtitle: "Project",
							status: project.status,
							timestamp: new Date(project.updatedAt),
							user: project.user,
						})),
						...activity.tasks.map((task: any) => {
							const taskStatus = normalizeTaskStatus(task.status);
							const subtitle =
								taskStatus === "running"
									? `Stage: ${task.stage}`
									: taskStatus === "completed"
										? "Completed"
										: taskStatus === "failed"
											? "Failed"
											: taskStatus
													.charAt(0)
													.toUpperCase() +
												taskStatus.slice(1);

							const title =
								task.agentId === "orchestrator"
									? "Fabric AI"
									: task.agentId
											.replace(/_/g, " ")
											.replace(
												/\b\w/g,
												(letter: string) =>
													letter.toUpperCase(),
											);

							return {
								id: task.id,
								type: "task" as const,
								title,
								subtitle,
								status: taskStatus,
								timestamp: new Date(task.updatedAt),
								user: task.user,
								agentId: task.agentId,
							};
						}),
						...activity.documents.map((doc: any) => ({
							id: doc.id,
							type: "document" as const,
							title: doc.title,
							subtitle: doc.project.name,
							status: doc.status,
							timestamp: new Date(doc.updatedAt),
							user: doc.project.user,
							projectId: doc.project.id,
						})),
						...activity.prompts.map((prompt: any) => ({
							id: prompt.id,
							type: "prompt" as const,
							title: prompt.name,
							subtitle: prompt.category || "Prompt",
							status: undefined,
							timestamp: new Date(prompt.updatedAt),
						})),
						...activity.chats.map((chat: any) => ({
							id: chat.id,
							type: "chat" as const,
							title: chat.title || "Untitled Chat",
							subtitle: "AI Chat",
							status: undefined,
							timestamp: new Date(chat.updatedAt),
							user: chat.user,
						})),
						...activity.workflows.map((workflow: any) => ({
							id: workflow.id,
							type: "workflow" as const,
							title: workflow.name,
							subtitle:
								workflow.status.charAt(0) +
								workflow.status.slice(1).toLowerCase(),
							status: workflow.status,
							timestamp: new Date(workflow.updatedAt),
							user: workflow.user,
						})),
						...activity.agents.map((agent: any) => ({
							id: agent.id,
							type: "agent" as const,
							title: agent.displayName,
							subtitle: agent.status,
							status: agent.status,
							timestamp: new Date(agent.updatedAt),
							agentSlug: agent.agentId,
							user: agent.user,
						})),
						...activity.skills.map((skill: any) => ({
							id: skill.id,
							type: "skill" as const,
							title: skill.name,
							subtitle: skill.category || "Skill",
							status: undefined,
							timestamp: new Date(skill.updatedAt),
						})),
						...activity.mcpConfigs.map((config: any) => ({
							id: config.id,
							type: "mcp" as const,
							title:
								config.displayName ||
								config.mcpServer?.name ||
								"MCP Server",
							subtitle: "MCP Connection",
							status: undefined,
							timestamp: new Date(config.updatedAt),
							user: config.user,
						})),
						...activity.pipelines.map((pipeline: any) => ({
							id: pipeline.id,
							type: "pipeline" as const,
							title: pipeline.name,
							subtitle: pipeline.status,
							status: pipeline.status,
							timestamp: new Date(pipeline.updatedAt),
							user: pipeline.user,
						})),
					].sort(
						(a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
					)
				: [],
		[activity],
	);

	// Recent chats
	const recentChats =
		activity?.chats.map((chat: any) => ({
			id: chat.id,
			title: chat.title || "Untitled Chat",
			timestamp: new Date(chat.updatedAt),
		})) || [];

	// Time-series data for line chart
	const timeSeries = useMemo(
		() => generateTimeSeries(timelineActivities, days),
		[timelineActivities, days],
	);

	const orgStats = stats as (typeof stats & { members?: number }) | undefined;

	// KPI cards for org context
	const kpiCards = [
		{
			title: "Projects",
			value: stats?.projects.total ?? 0,
			subtitle: `${stats?.projects.active ?? 0} active · ${stats?.projects.draft ?? 0} draft`,
			icon: FolderIcon,
			iconClassName: "text-primary",
			onClick: () => router.push(`${basePath}/projects`),
		},
		{
			title: "Agent Tasks",
			value: stats?.tasks.total ?? 0,
			subtitle: `${stats?.tasks.running ?? 0} running · ${stats?.tasks.completed ?? 0} done`,
			icon: TrendingUpIcon,
			iconClassName: "text-secondary",
			onClick: () => router.push(`${basePath}/agents?tab=tasks`),
		},
		{
			title: "Documents",
			value: stats?.documents.total ?? 0,
			subtitle: `${stats?.documents.ready ?? 0} ready · ${stats?.documents.processing ?? 0} processing`,
			icon: FileTextIcon,
			iconClassName: "text-highlight",
			onClick: () => router.push(`${basePath}/projects`),
		},
		{
			title: "Team Members",
			value: orgStats?.members ?? 0,
			subtitle: "Organization members",
			icon: UsersIcon,
			iconClassName: "text-success",
			onClick: () => router.push(`${basePath}/settings/members`),
		},
	];

	return (
		<div className="space-y-5">
			{/* Banners */}
			{config.dashboard.inviteWelcomeWidget.enabled ? (
				<ProjectInviteWelcomeWidget
					organizationId={organizationId}
					organizationSlug={organizationSlug}
				/>
			) : (
				<PendingInvitationsBanner />
			)}

			{/* Hero */}
			<DashboardHero
				userName={user?.name}
				organizationName={organizationName}
				brandColor={brandColor}
				timeRange={timeRange}
				onTimeRangeChange={setTimeRange}
				onRefresh={handleRefresh}
			/>

			{/* The AI-provider notice moved to the app chrome (`AppWrapper`),
			 * which wraps this page and every other page in the organization.
			 * A tenant with no provider has nothing AI-shaped working
			 * anywhere, so the dashboard was the wrong place to be the only
			 * one saying so (Fizzy #1875, R5). */}

			{/* KPI cards */}
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{statsLoading
					? Array.from({ length: 4 }).map((_, i) => (
							<MetricCard
								key={`kpi-skeleton-${i}`}
								title=""
								value={0}
								loading
							/>
						))
					: kpiCards.map((card) => (
							<MetricCard
								key={card.title}
								{...card}
								loading={false}
							/>
						))}
			</div>

			{/* Full-width activity history line chart */}
			<DashboardLineChart
				data={timeSeries}
				title={`Cumulative Activity — ${timeRange === "today" ? "Today" : timeRange === "7d" ? "Last 7 Days" : timeRange === "30d" ? "Last 30 Days" : timeRange === "90d" ? "Last 90 Days" : "All Time"}`}
				loading={activityLoading}
			/>

			{/* Quick actions */}
			<QuickActions organizationSlug={organizationSlug} />

			{/* My Work (left) + Recent chats (right) */}
			<div className="grid gap-5 lg:grid-cols-5 lg:items-start">
				<div className="lg:col-span-3 lg:h-[480px]">
					<MyWorkPanel
						organizationId={organizationId}
						organizationSlug={organizationSlug}
					/>
				</div>
				<div className="lg:col-span-2 lg:h-[480px]">
					<RecentChats
						chats={recentChats}
						organizationSlug={organizationSlug}
						loading={activityLoading}
					/>
				</div>
			</div>
		</div>
	);
}
