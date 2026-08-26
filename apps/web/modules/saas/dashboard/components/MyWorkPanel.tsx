"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	ArrowRightIcon,
	CheckCircle2Icon,
	FileTextIcon,
	FolderIcon,
	PencilLineIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type MyWorkItemKind = "feature" | "document" | "project" | "task" | "pipeline";

interface MyWorkItem {
	id: string;
	kind: MyWorkItemKind;
	title: string;
	subtitle?: string | null;
	identifier?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	status?: string | null;
	href: string;
	updatedAt: string | Date;
}

interface MyWorkBucket {
	items: MyWorkItem[];
	total: number;
}

interface MyWorkData {
	inProgress: MyWorkBucket;
	needsReview: MyWorkBucket;
	blocked: MyWorkBucket;
	drafts: MyWorkBucket;
}

interface MyWorkPanelProps {
	organizationId?: string | null;
	organizationSlug?: string;
}

type TabKey = "inProgress" | "needsReview" | "blocked" | "drafts";

const TABS: Array<{ key: TabKey; label: string }> = [
	{ key: "inProgress", label: "In Progress" },
	{ key: "needsReview", label: "Needs Review" },
	{ key: "blocked", label: "Blocked" },
	{ key: "drafts", label: "Drafts" },
];

const EMPTY_STATES: Record<
	TabKey,
	{ icon: typeof CheckCircle2Icon; title: string; hint: string }
> = {
	inProgress: {
		icon: SparklesIcon,
		title: "Nothing in flight",
		hint: "Pick a feature or start a new one.",
	},
	needsReview: {
		icon: CheckCircle2Icon,
		title: "Nothing to review",
		hint: "Inbox zero.",
	},
	blocked: {
		icon: CheckCircle2Icon,
		title: "No blockers",
		hint: "Ship something.",
	},
	drafts: {
		icon: PencilLineIcon,
		title: "No drafts",
		hint: "Start a new project to capture an idea.",
	},
};

function kindIcon(kind: MyWorkItemKind) {
	switch (kind) {
		case "feature":
			return SparklesIcon;
		case "document":
			return FileTextIcon;
		case "project":
			return FolderIcon;
		case "task":
		case "pipeline":
			return AlertCircleIcon;
	}
}

function kindTone(kind: MyWorkItemKind, isBlocked: boolean): string {
	if (isBlocked) {
		return "text-destructive bg-destructive/10";
	}
	switch (kind) {
		case "feature":
			return "text-primary bg-primary/10";
		case "document":
			return "text-highlight bg-highlight/10";
		case "project":
			return "text-secondary bg-secondary/10";
		case "task":
		case "pipeline":
			return "text-muted-foreground bg-muted";
	}
}

function MyWorkList({
	bucket,
	tabKey,
	loading,
}: {
	bucket?: MyWorkBucket;
	tabKey: TabKey;
	loading: boolean;
}) {
	if (loading) {
		return (
			<div className="divide-y divide-border/40">
				{Array.from({ length: 4 }).map((_, i) => (
					<div
						key={`my-work-skeleton-${tabKey}-${i}`}
						className="flex items-center gap-3 px-5 py-3"
					>
						<div className="h-7 w-7 shrink-0 rounded-full bg-muted motion-safe:animate-pulse" />
						<div className="flex-1 space-y-1.5">
							<div className="h-3 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
							<div className="h-2.5 w-1/3 rounded bg-muted motion-safe:animate-pulse" />
						</div>
					</div>
				))}
			</div>
		);
	}

	const items = bucket?.items ?? [];
	if (items.length === 0) {
		const state = EMPTY_STATES[tabKey];
		const Icon = state.icon;
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 px-5 py-12 text-center">
				<Icon
					className="h-8 w-8 text-muted-foreground/30"
					aria-hidden="true"
				/>
				<p className="text-sm font-medium text-muted-foreground">
					{state.title}
				</p>
				<p className="text-xs text-muted-foreground/60">{state.hint}</p>
			</div>
		);
	}

	const isBlockedTab = tabKey === "blocked";

	return (
		<div className="divide-y divide-border/40">
			{items.map((item) => {
				const Icon = kindIcon(item.kind);
				const tone = kindTone(item.kind, isBlockedTab);
				const updated =
					typeof item.updatedAt === "string"
						? new Date(item.updatedAt)
						: item.updatedAt;
				const ariaLabel = `${item.kind}: ${item.title}${item.status ? ` — ${item.status}` : ""}`;
				return (
					<Link
						key={`${item.kind}-${item.id}`}
						href={item.href}
						aria-label={ariaLabel}
						className="group flex items-center gap-3 px-5 py-3 transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
					>
						<div
							className={cn(
								"flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
								tone,
							)}
						>
							<Icon className="h-3.5 w-3.5" aria-hidden="true" />
						</div>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								{item.identifier ? (
									<span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 shrink-0">
										{item.identifier}
									</span>
								) : null}
								<p className="truncate text-sm font-medium leading-tight transition-colors group-hover:text-primary">
									{item.title}
								</p>
							</div>
							<div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground/70">
								{item.projectName ? (
									<span className="truncate">
										{item.projectName}
									</span>
								) : null}
								{item.projectName && item.status ? (
									<span aria-hidden="true">·</span>
								) : null}
								{item.status ? (
									<span
										className={cn(
											"truncate",
											isBlockedTab && "text-destructive",
										)}
									>
										{item.status}
									</span>
								) : null}
								<span aria-hidden="true">·</span>
								<span className="shrink-0">
									{formatDistanceToNow(updated, {
										addSuffix: true,
									})}
								</span>
							</div>
						</div>
						<ArrowRightIcon
							className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100"
							aria-hidden="true"
						/>
					</Link>
				);
			})}
		</div>
	);
}

export function MyWorkPanel({
	organizationId,
	organizationSlug,
}: MyWorkPanelProps) {
	const router = useRouter();
	const basePath = organizationSlug ? `/app/${organizationSlug}` : "/app";

	const { data, isLoading } = useQuery<MyWorkData>({
		queryKey: ["dashboard", "myWork", organizationId ?? null],
		queryFn: async () =>
			(await orpcClient.dashboard.myWork({
				organizationId: organizationId ?? null,
				organizationSlug: organizationSlug ?? null,
				limit: 6,
			})) as MyWorkData,
		refetchInterval: 60000,
	});

	const counts: Record<TabKey, number> = {
		inProgress: data?.inProgress.total ?? 0,
		needsReview: data?.needsReview.total ?? 0,
		blocked: data?.blocked.total ?? 0,
		drafts: data?.drafts.total ?? 0,
	};

	return (
		<Card className="flex h-full flex-col">
			<CardHeader className="shrink-0 px-5 pb-3 pt-4">
				<div className="flex items-center justify-between gap-3">
					<CardTitle className="text-base font-semibold">
						My Work
					</CardTitle>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs text-muted-foreground"
						onClick={() => router.push(`${basePath}/projects`)}
					>
						View all projects
					</Button>
				</div>
			</CardHeader>

			<CardContent className="flex flex-1 min-h-0 flex-col p-0">
				<Tabs
					defaultValue="inProgress"
					className="flex flex-1 min-h-0 flex-col"
				>
					<TabsList className="px-5">
						{TABS.map((t) => (
							<TabsTrigger
								key={t.key}
								value={t.key}
								className="text-[11px] uppercase tracking-[0.15em]"
							>
								{t.label}
								{counts[t.key] > 0 ? (
									<span
										className={cn(
											"ml-2 rounded-full px-1.5 py-px text-[10px] font-mono",
											t.key === "blocked"
												? "bg-destructive/10 text-destructive"
												: "bg-muted text-muted-foreground",
										)}
									>
										{counts[t.key]}
									</span>
								) : null}
							</TabsTrigger>
						))}
					</TabsList>

					{TABS.map((t) => (
						<TabsContent
							key={t.key}
							value={t.key}
							className="flex-1 overflow-y-auto"
						>
							<MyWorkList
								bucket={data?.[t.key]}
								tabKey={t.key}
								loading={isLoading}
							/>
						</TabsContent>
					))}
				</Tabs>
			</CardContent>
		</Card>
	);
}
