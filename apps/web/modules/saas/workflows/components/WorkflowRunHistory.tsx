"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	ChevronRightIcon,
	HistoryIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";
import { formatDuration } from "../lib/format-duration";
import { workflowExecutionsKey } from "../lib/query-keys";

type ExecutionStatus =
	| "PENDING"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "TIMED_OUT";

interface WorkflowRunHistoryProps {
	workflowId: string;
	organizationId?: string | null;
	selectedExecutionId?: string | null;
	onSelectExecution: (executionId: string) => void;
	onHide?: () => void;
}

/**
 * The statuses worth filtering by, in the order a reader scans for them:
 * "did anything break", then "is anything still going", then the rest.
 * `list-executions` has always accepted a status; nothing offered one.
 */
const STATUS_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "FAILED", label: "Failed" },
	{ value: "RUNNING", label: "Running" },
	{ value: "COMPLETED", label: "Completed" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

/** How a run was started, shown per row so a cron run is not mistaken for yours. */
const triggerLabels: Record<string, string> = {
	MANUAL: "Manual",
	WEBHOOK: "Webhook",
	SCHEDULE: "Schedule",
	EVENT: "Event",
};

const statusStyles: Record<ExecutionStatus, string> = {
	PENDING:
		"bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
	RUNNING: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
	COMPLETED:
		"bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
	FAILED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
	CANCELLED:
		"bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-200",
	TIMED_OUT:
		"bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
};

export function WorkflowRunHistory({
	workflowId,
	organizationId,
	selectedExecutionId,
	onSelectExecution,
	onHide,
}: WorkflowRunHistoryProps) {
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

	const executionsQuery = useQuery({
		queryKey: workflowExecutionsKey(
			workflowId,
			organizationId,
			statusFilter,
		),
		queryFn: async () => {
			return await orpcClient.workflows.executions.list({
				id: workflowId,
				organizationId,
				status: statusFilter === "all" ? undefined : statusFilter,
				limit: 20,
				offset: 0,
			});
		},
		// Only poll while a run is actually in flight; otherwise the editor
		// hammered this endpoint every 5s forever even when all runs finished.
		refetchInterval: (query) => {
			const execs = query.state.data?.executions ?? [];
			const hasActive = execs.some(
				(e) => e.status === "PENDING" || e.status === "RUNNING",
			);
			return hasActive ? 5000 : false;
		},
		enabled: Boolean(workflowId),
	});

	const executions = executionsQuery.data?.executions ?? [];
	const isEmpty = executions.length === 0;

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between border-b px-4 py-3 gap-2">
				<div>
					<div className="flex items-center gap-2">
						<HistoryIcon className="h-4 w-4 text-muted-foreground" />
						<p className="text-sm font-medium">Run History</p>
					</div>
					<p className="text-xs text-muted-foreground">
						{executionsQuery.data?.total ?? 0} total runs
					</p>
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon"
						onClick={() => executionsQuery.refetch()}
						disabled={executionsQuery.isFetching}
						aria-label="Refresh runs"
					>
						<RefreshCwIcon
							className={cn(
								"h-4 w-4",
								executionsQuery.isFetching &&
									"animate-spin text-primary",
							)}
						/>
					</Button>
					{onHide ? (
						<Button
							variant="ghost"
							size="icon"
							onClick={onHide}
							aria-label="Hide run history"
						>
							<ChevronRightIcon className="h-4 w-4" />
						</Button>
					) : null}
				</div>
			</div>

			<div className="flex flex-wrap gap-1 border-b px-4 py-2">
				{STATUS_FILTERS.map((filter) => (
					<Button
						key={filter.value}
						type="button"
						variant={
							statusFilter === filter.value
								? "secondary"
								: "ghost"
						}
						size="sm"
						className="h-7 px-2 text-xs"
						aria-pressed={statusFilter === filter.value}
						onClick={() => setStatusFilter(filter.value)}
					>
						{filter.label}
					</Button>
				))}
			</div>

			<ScrollArea className="flex-1 min-h-0">
				<div className="p-4 space-y-3">
					{executionsQuery.isLoading ? (
						<div className="flex items-center justify-center py-6">
							<Spinner className="h-5 w-5" />
						</div>
					) : isEmpty ? (
						<div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground py-6">
							<AlertCircleIcon className="h-5 w-5" />
							<p>
								{statusFilter === "all"
									? "No runs yet. Execute the workflow to see history."
									: `No ${statusFilter.toLowerCase()} runs.`}
							</p>
						</div>
					) : (
						executions.map((execution) => {
							const duration =
								execution.duration && execution.duration > 0
									? formatDuration(execution.duration)
									: null;
							const logCount = execution._count?.logs ?? 0;
							const timeAgo = execution.startedAt
								? formatDistanceToNow(
										new Date(execution.startedAt),
										{
											addSuffix: true,
										},
									)
								: null;
							const isSelected =
								execution.id === selectedExecutionId;

							return (
								<button
									key={execution.id}
									type="button"
									className={cn(
										"w-full text-left rounded-lg border p-3 transition hover:border-primary/60 hover:bg-primary/5",
										isSelected &&
											"border-primary bg-primary/5",
									)}
									onClick={() =>
										onSelectExecution(execution.id)
									}
								>
									<div className="flex items-start justify-between gap-2">
										<div className="space-y-1">
											<div className="flex flex-wrap items-center gap-2">
												<Badge
													variant="secondary"
													className={cn(
														"text-[11px] font-semibold tracking-wide uppercase",
														statusStyles[
															execution.status as ExecutionStatus
														] ||
															"bg-muted text-muted-foreground dark:bg-muted/40",
													)}
												>
													{execution.status}
												</Badge>
												{execution.triggerType && (
													<span className="text-xs text-muted-foreground">
														{triggerLabels[
															execution
																.triggerType
														] ??
															execution.triggerType}
													</span>
												)}
												{timeAgo && (
													<span className="text-xs text-muted-foreground">
														{timeAgo}
													</span>
												)}
											</div>
											<p className="text-sm font-medium text-foreground">
												Run ID{" "}
												{execution.id.slice(0, 8)}…
											</p>
											<p className="text-xs text-muted-foreground">
												{logCount} step
												{logCount === 1 ? "" : "s"}
												{duration
													? ` • ${duration}`
													: ""}
											</p>
											{execution.error && (
												<p className="text-xs text-destructive line-clamp-2">
													{execution.error}
												</p>
											)}
										</div>
										<ChevronRightIcon className="h-4 w-4 text-muted-foreground shrink-0" />
									</div>
								</button>
							);
						})
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
