"use client";

/**
 * Customer-facing system health dashboard.
 *
 * Answers one question, in this order: is anything wrong right now, is it ours
 * or yours, and has it happened before. Everything on the page serves that
 * ordering — the headline verdict first, then what we have said about it, then
 * the component breakdown, then history.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	ExternalLinkIcon,
	RefreshCwIcon,
} from "lucide-react";
import { formatUtc } from "../lib/format-utc";
import {
	type HealthStatus,
	HealthStatusBadge,
	HealthStatusDot,
	healthStatusLabel,
} from "./HealthStatusBadge";
import {
	type StatusAnnouncement,
	StatusAnnouncementCard,
} from "./StatusAnnouncementCard";

const GROUP_LABEL: Record<string, string> = {
	CORE: "Core platform",
	AI: "AI",
	INTEGRATIONS: "Integrations",
	AUTOMATION: "Automation",
	DATA: "Data & storage",
};

/** Order groups deterministically rather than by object-key iteration order. */
const GROUP_ORDER = ["CORE", "AI", "AUTOMATION", "INTEGRATIONS", "DATA"];

interface ResolvedComponent {
	key: string;
	displayName: string;
	description: string;
	group: string;
	status: HealthStatus;
	detail: string;
}

interface ProviderIssue {
	providerKey: string;
	providerName: string;
	status: HealthStatus;
	startedAt: string | Date;
	statusPageUrl: string | null;
}

interface Overview {
	overallStatus: HealthStatus;
	components: ResolvedComponent[];
	announcements: StatusAnnouncement[];
	providerIssues: ProviderIssue[];
	generatedAt: string | Date;
}

/**
 * Headline copy per status. Written so a customer can act on it: "your side" vs
 * "our side" is the distinction the whole page exists to make.
 */
const OVERALL_COPY: Record<HealthStatus, { title: string; body: string }> = {
	OPERATIONAL: {
		title: "All systems operational",
		body: "We are not aware of any problems affecting your workspace right now.",
	},
	DEGRADED: {
		title: "Some features are degraded",
		body: "Part of the platform is slower or less reliable than usual. Details are below.",
	},
	PARTIAL_OUTAGE: {
		title: "Partial outage",
		body: "Some capabilities are substantially unavailable. Details are below.",
	},
	MAJOR_OUTAGE: {
		title: "Major outage",
		body: "A significant part of the platform is unavailable. We are working on it.",
	},
	MAINTENANCE: {
		title: "Maintenance in progress",
		body: "Planned maintenance is underway. Some features may be briefly unavailable.",
	},
	UNKNOWN: {
		title: "Status unavailable",
		body: "We cannot currently confirm the status of every component. This does not necessarily mean anything is wrong.",
	},
	// Only reachable if EVERY component were unmonitored, since
	// resolveOverallStatus filters NOT_CONFIGURED out of the rollup. Kept for
	// exhaustiveness, and worded so it never claims health we cannot see.
	NOT_CONFIGURED: {
		title: "Status unavailable",
		body: "We are not actively monitoring this environment, so we cannot report platform status here.",
	},
};

const BANNER_TONE: Record<HealthStatus, string> = {
	OPERATIONAL: "border-secondary/30 bg-secondary/5",
	DEGRADED: "border-highlight/30 bg-highlight/5",
	PARTIAL_OUTAGE: "border-highlight/30 bg-highlight/5",
	MAJOR_OUTAGE: "border-destructive/30 bg-destructive/5",
	MAINTENANCE: "border-border/60 bg-muted/50",
	UNKNOWN: "border-border/60 bg-muted/50",
	// Neutral, matching MAINTENANCE/UNKNOWN. This carried the green
	// OPERATIONAL tint while its copy was corrected to "Status unavailable",
	// so the colour was telling a customer the opposite of the sentence beside
	// it — colour actively misleading rather than merely redundant.
	NOT_CONFIGURED: "border-border/60 bg-muted/50",
};

export function SystemHealthDashboard() {
	const overview = useQuery({
		queryKey: ["systemHealth", "overview"],
		queryFn: async () => {
			return (await orpcClient.systemHealth.getOverview({})) as Overview;
		},
		// A status page that needs a manual refresh to show an outage is not doing
		// its job. 60s matches the incident-summary poll already in the app shell.
		refetchInterval: 60_000,
	});

	const history = useQuery({
		queryKey: ["systemHealth", "history"],
		queryFn: async () => {
			const result = await orpcClient.systemHealth.listHistory({
				sinceDays: 90,
				limit: 20,
			});
			return result as { updates: StatusAnnouncement[] };
		},
	});

	if (overview.isLoading) {
		return (
			<div
				className="space-y-4"
				aria-busy="true"
				aria-live="polite"
				aria-label="Loading platform status"
			>
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (overview.isError || !overview.data) {
		return (
			<Card className="border-border/60 bg-card p-6">
				<div className="flex items-start gap-3">
					<AlertTriangleIcon
						aria-hidden="true"
						className="mt-0.5 size-5 shrink-0 text-muted-foreground"
					/>
					<div>
						<p className="font-medium text-foreground text-sm">
							We could not load platform status
						</p>
						<p className="mt-1 text-muted-foreground text-sm">
							This page itself failed to load, which may mean the
							problem you are investigating is broader. Try again
							in a moment.
						</p>
						<button
							type="button"
							onClick={() => overview.refetch()}
							className="mt-3 inline-flex items-center gap-2 rounded-md border border-border/60 px-3 py-1.5 font-medium text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
						>
							<RefreshCwIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							Retry
						</button>
					</div>
				</div>
			</Card>
		);
	}

	const data = overview.data;
	const copy = OVERALL_COPY[data.overallStatus];
	const activeHistory = (history.data?.updates ?? []).filter(
		(u) => u.lifecycle === "RESOLVED" || u.lifecycle === "COMPLETED",
	);

	const grouped = GROUP_ORDER.map((group) => ({
		group,
		components: data.components.filter((c) => c.group === group),
	})).filter((entry) => entry.components.length > 0);

	return (
		<div className="space-y-8">
			<Card
				className={cn("border p-6", BANNER_TONE[data.overallStatus])}
				data-onboarding-target="system-health-overall"
			>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div className="flex items-center gap-3">
						<HealthStatusDot
							status={data.overallStatus}
							className="size-3"
						/>
						<h2 className="font-medium text-foreground text-lg">
							{copy.title}
						</h2>
					</div>
					<p className="text-muted-foreground text-xs">
						Checked {formatUtc(data.generatedAt)}
					</p>
				</div>
				<p className="mt-2 text-muted-foreground text-sm">
					{copy.body}
				</p>
			</Card>

			{data.announcements.length > 0 && (
				<section aria-labelledby="active-updates-heading">
					<h2
						id="active-updates-heading"
						className="app-editorial-label mb-3"
					>
						Active updates
					</h2>
					<div className="space-y-3">
						{data.announcements.map((announcement) => (
							<StatusAnnouncementCard
								key={announcement.id}
								announcement={announcement}
							/>
						))}
					</div>
				</section>
			)}

			<section
				aria-labelledby="components-heading"
				data-onboarding-target="system-health-components"
			>
				<h2
					id="components-heading"
					className="app-editorial-label mb-3"
				>
					Components
				</h2>
				<div className="space-y-6">
					{grouped.map(({ group, components }) => (
						<div key={group}>
							<p className="mb-2 font-medium text-muted-foreground text-xs">
								{GROUP_LABEL[group] ?? group}
							</p>
							<Card className="divide-y divide-border/60 border-border/60 bg-card">
								{components.map((component) => (
									<div
										key={component.key}
										className="flex flex-wrap items-start justify-between gap-3 p-4"
									>
										<div className="min-w-0 flex-1">
											<p className="font-medium text-foreground text-sm">
												{component.displayName}
											</p>
											<p className="mt-0.5 text-muted-foreground text-xs">
												{component.description}
											</p>
											<p className="mt-1 text-muted-foreground text-xs">
												{component.detail}
											</p>
										</div>
										<HealthStatusBadge
											status={component.status}
											className="shrink-0"
										/>
									</div>
								))}
							</Card>
						</div>
					))}
				</div>
			</section>

			{data.providerIssues.length > 0 && (
				<section
					aria-labelledby="provider-issues-heading"
					data-onboarding-target="system-health-providers"
				>
					<h2
						id="provider-issues-heading"
						className="app-editorial-label mb-3"
					>
						Your connected providers
					</h2>
					<Card className="divide-y divide-border/60 border-border/60 bg-card">
						{data.providerIssues.map((issue) => (
							<div
								key={issue.providerKey}
								className="flex flex-wrap items-center justify-between gap-3 p-4"
							>
								<div className="min-w-0">
									<p className="font-medium text-foreground text-sm">
										{issue.providerName}
									</p>
									<p className="mt-0.5 text-muted-foreground text-xs">
										Reporting{" "}
										{healthStatusLabel(issue.status)} since{" "}
										{formatUtc(issue.startedAt)}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-3">
									<HealthStatusBadge status={issue.status} />
									{issue.statusPageUrl && (
										<a
											href={issue.statusPageUrl}
											target="_blank"
											rel="noreferrer noopener"
											className="inline-flex items-center gap-1.5 text-primary text-xs underline-offset-4 transition-colors hover:underline"
										>
											Their status page
											<ExternalLinkIcon
												aria-hidden="true"
												className="size-3"
											/>
										</a>
									)}
								</div>
							</div>
						))}
					</Card>
					<p className="mt-2 text-muted-foreground text-xs">
						Only providers you have connected are listed here.
					</p>
				</section>
			)}

			<section
				aria-labelledby="history-heading"
				data-onboarding-target="system-health-history"
			>
				<h2 id="history-heading" className="app-editorial-label mb-3">
					Past 90 days
				</h2>
				{history.isLoading ? (
					<div
						aria-busy="true"
						aria-live="polite"
						aria-label="Loading status history"
					>
						<Skeleton className="h-24 w-full" />
					</div>
				) : activeHistory.length === 0 ? (
					<Card className="border-border/60 bg-muted/40 p-6">
						<p className="text-muted-foreground text-sm">
							No resolved incidents in the last 90 days.
						</p>
					</Card>
				) : (
					<div className="space-y-3">
						{activeHistory.map((announcement) => (
							<StatusAnnouncementCard
								key={announcement.id}
								announcement={announcement}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
