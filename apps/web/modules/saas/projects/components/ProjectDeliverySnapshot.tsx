"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import type { TabId } from "@saas/projects/lib/project-tabs";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { ChevronRight, RefreshCw } from "lucide-react";
import Link from "next/link";

/** A short evidence-first project view; the existing tabs remain the places to do the work. */
export function ProjectDeliverySnapshot({
	projectId,
	onNavigateToTab,
}: {
	projectId: string;
	onNavigateToTab?: (tab: TabId) => void;
}) {
	const { basePath } = useOrganizationContext();
	const query = useQuery(
		orpc.projects.delivery.queryOptions({ input: { projectId } }),
	);
	if (query.isLoading) {
		return (
			<Skeleton
				className="h-28 w-full"
				aria-label="Loading delivery evidence"
			/>
		);
	}
	if (query.isError || !query.data) {
		return (
			<div className="rounded-lg border border-border p-4">
				<p className="text-sm text-muted-foreground">
					Delivery evidence is unavailable. Your work is still
					available in the project tabs.
				</p>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => query.refetch()}
				>
					Try again
				</Button>
			</div>
		);
	}
	const snapshot = query.data;
	const runs = snapshot.work.items.flatMap((item) => item.runs);
	const merged = runs.filter(
		(run) => run.deliveryEvidence === "PR_MERGED",
	).length;
	const active = runs.filter((run) =>
		["QUEUED", "STARTING", "RUNNING", "AWAITING_REVIEW"].includes(
			run.status,
		),
	).length;
	const target: TabId =
		snapshot.nextAction.kind === "REVIEW_CONTEXT" ||
		snapshot.nextAction.kind === "ADD_CONTEXT"
			? "context"
			: "stories";
	return (
		<section
			data-onboarding-target="overview-delivery-evidence"
			className="rounded-lg border border-border bg-card p-5"
			aria-labelledby="project-delivery-title"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 id="project-delivery-title" className="font-semibold">
						Delivery at a glance
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						Current project evidence, with the next useful action.
					</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => query.refetch()}
					aria-label="Refresh delivery evidence"
				>
					<RefreshCw className="size-4" />
				</Button>
			</div>
			<div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
				<span>
					{snapshot.work.available
						? `${snapshot.work.items.length}${snapshot.work.hasMore ? "+" : ""} recent work items`
						: "Work: unavailable"}
				</span>
				<span>
					{snapshot.work.runsAvailable
						? `${active} active implementation sessions`
						: "Implementation sessions: unavailable"}
				</span>
				<span>
					{snapshot.work.runsAvailable
						? `${merged} observed PR merges`
						: "PR merge evidence: unavailable"}
				</span>
				<span>
					{snapshot.context.available
						? `${snapshot.context.attention} sources need attention`
						: "Context: unavailable"}
				</span>
			</div>
			<p className="mt-2 text-xs text-muted-foreground">
				Recent evidence is a bounded sample. PR merge does not confirm
				deployment. External agent costs and delivery lead time are not
				yet reported.
			</p>
			<div className="mt-4 flex flex-wrap items-center gap-3">
				<Button
					variant="outline"
					size="sm"
					disabled={!onNavigateToTab}
					onClick={() => onNavigateToTab?.(target)}
				>
					{snapshot.nextAction.label}
					<ChevronRight className="ml-1 size-4" />
				</Button>
				<Button
					variant="ghost"
					size="sm"
					disabled={!onNavigateToTab}
					onClick={() => onNavigateToTab?.("daily-brief")}
				>
					Read the delivery brief
				</Button>
			</div>
			{snapshot.work.items.length > 0 && (
				<ul className="mt-4 divide-y divide-border">
					{snapshot.work.items.slice(0, 4).map((item) => (
						<li key={item.id} className="py-2">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<Link
									href={`${basePath}/projects/${projectId}/stories/${item.id}`}
									className="text-left text-sm font-medium hover:underline"
								>
									{item.identifier} · {item.title}
								</Link>
								<span className="text-xs text-muted-foreground">
									{item.runs[0]?.deliveryEvidence ===
									"PR_MERGED"
										? "PR merged · deployment unknown"
										: item.runs[0]
											? item.runs[0].status
													.replaceAll("_", " ")
													.toLowerCase()
											: snapshot.work.runsAvailable
												? "No implementation result"
												: "Implementation result unavailable"}
								</span>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								{
									item.tasks.filter(
										(task) => task.isCompleted,
									).length
								}
								/{item.tasks.length} sampled tasks complete
								{item.sourceRef
									? ` · Source ${item.sourceRef}`
									: ""}{" "}
								· Discuss and review files on the work item
							</p>
						</li>
					))}
				</ul>
			)}
			{snapshot.context.available &&
				snapshot.context.sources.length > 0 && (
					<details className="mt-4 border-t border-border pt-3">
						<summary className="cursor-pointer text-sm font-medium">
							Source health and freshness
						</summary>
						<p className="mt-2 text-xs text-muted-foreground">
							Stored extraction and indexing observations; no
							inferred accuracy score. A missing sync time is
							unknown.
						</p>
						<ul className="mt-2 space-y-2">
							{snapshot.context.sources.map((source) => (
								<li key={source.id}>
									<details>
										<summary className="cursor-pointer text-sm">
											{source.title}{" "}
											<span className="text-xs text-muted-foreground">
												·{" "}
												{source.state
													.replaceAll("_", " ")
													.toLowerCase()}
											</span>
										</summary>
										<div className="mt-1 space-y-1 pl-3 text-xs text-muted-foreground">
											<p>
												Updated: {source.updatedAt} ·
												Last sync:{" "}
												{source.lastSyncedAt ??
													"Unknown"}
											</p>
											<p>Source ID: {source.id}</p>
											<Button
												variant="ghost"
												size="sm"
												disabled={!onNavigateToTab}
												onClick={() =>
													onNavigateToTab?.("context")
												}
											>
												Inspect in project context
											</Button>
										</div>
									</details>
								</li>
							))}
						</ul>
					</details>
				)}
			<p className="mt-3 text-xs text-muted-foreground">
				{snapshot.decisions.available
					? `${snapshot.decisions.items.length} recent decisions`
					: "Decisions: unavailable"}{" "}
				·{" "}
				{snapshot.documents.available
					? `${snapshot.documents.items.length} recent documents`
					: "Documents: unavailable"}
			</p>
			{snapshot.documents.items.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-3 text-xs">
					{snapshot.documents.items.slice(0, 3).map((document) => (
						<Link
							key={document.id}
							className="text-primary underline-offset-2 hover:underline"
							href={`${basePath}/projects/${projectId}/documents/${document.id}`}
						>
							{document.title}
						</Link>
					))}
				</div>
			)}
		</section>
	);
}
