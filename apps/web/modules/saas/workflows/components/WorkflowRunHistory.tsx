"use client";

import { Spinner } from "@shared/components/Spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import { PanelLeftCloseIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { formatDuration } from "../lib/format-duration";
import { useWorkflowRunStats, useWorkflowRuns } from "../lib/run-queries";
import {
	formatTriggerType,
	RUN_FILTERS,
	type RunFilter,
	runFilterCount,
	shortRunId,
} from "../lib/run-steps";
import { RunStatusIcon } from "./editor/RunStatusIcon";

interface WorkflowRunHistoryProps {
	workflowId: string;
	organizationId?: string | null;
	selectedExecutionId?: string | null;
	onSelectExecution: (executionId: string) => void;
	onHide?: () => void;
}

function HeaderButton({
	label,
	onClick,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					onClick={onClick}
					disabled={disabled}
					className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none"
				>
					{children}
				</button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The editor's left-hand runs panel: recent runs, filterable by outcome with
 * a count per filter, newest first. Selecting a run shows it on the canvas;
 * selecting it again returns to editing.
 */
export function WorkflowRunHistory({
	workflowId,
	organizationId,
	selectedExecutionId,
	onSelectExecution,
	onHide,
}: WorkflowRunHistoryProps) {
	const [statusFilter, setStatusFilter] = useState<RunFilter>("all");
	const executionsQuery = useWorkflowRuns(
		workflowId,
		organizationId,
		statusFilter,
	);
	const statsQuery = useWorkflowRunStats(workflowId, organizationId);

	const executions = executionsQuery.data?.executions ?? [];
	const total = statsQuery.data?.total;
	const activeFilter = RUN_FILTERS.find((f) => f.value === statusFilter);

	return (
		<aside
			aria-label="Runs"
			className="flex h-full w-[272px] shrink-0 flex-col border-r bg-background"
		>
			<div className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-2">
				<h2 className="text-[13px] font-medium">Runs</h2>
				{total !== undefined ? (
					<span className="text-xs text-muted-foreground">
						{total}
					</span>
				) : null}
				<span className="flex-1" />
				<HeaderButton
					label="Refresh runs"
					onClick={() => {
						executionsQuery.refetch();
						statsQuery.refetch();
					}}
					disabled={executionsQuery.isFetching}
				>
					<RefreshCwIcon
						className={cn(
							"size-3.5",
							executionsQuery.isFetching &&
								"motion-safe:animate-spin",
						)}
						aria-hidden="true"
					/>
				</HeaderButton>
				{onHide ? (
					<HeaderButton label="Collapse runs" onClick={onHide}>
						<PanelLeftCloseIcon
							className="size-[15px]"
							aria-hidden="true"
						/>
					</HeaderButton>
				) : null}
			</div>

			<div className="border-b px-3 py-2.5">
				<fieldset
					aria-label="Filter runs"
					className="m-0 grid min-w-0 grid-cols-4 gap-0.5 rounded-[7px] border-0 bg-muted p-0.5"
				>
					{RUN_FILTERS.map((filter) => {
						const active = statusFilter === filter.value;
						const count = runFilterCount(
							filter.value,
							statsQuery.data,
						);
						return (
							<button
								key={filter.value}
								type="button"
								aria-pressed={active}
								onClick={() => setStatusFilter(filter.value)}
								className={cn(
									"flex h-[26px] items-center justify-center gap-1 rounded-[5px] text-xs focus-visible:outline-2 focus-visible:outline-ring",
									active
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{filter.label}
								{count !== undefined ? (
									<span
										className="text-[11px] text-muted-foreground"
										data-testid={`run-filter-count-${filter.value}`}
									>
										{count}
									</span>
								) : null}
							</button>
						);
					})}
				</fieldset>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto py-1.5">
				{executionsQuery.isLoading ? (
					<div className="flex items-center justify-center py-6">
						<Spinner className="h-5 w-5" />
					</div>
				) : executions.length === 0 ? (
					<p className="px-5 py-8 text-center text-[13px] text-muted-foreground">
						{activeFilter?.noun
							? `No ${activeFilter.noun} runs.`
							: "No runs yet. Run the workflow to see its history."}
					</p>
				) : (
					<ul>
						{executions.map((execution) => {
							const duration =
								execution.duration && execution.duration > 0
									? formatDuration(execution.duration)
									: null;
							const stepCount = execution._count?.logs ?? 0;
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
								<li key={execution.id}>
									<button
										type="button"
										aria-pressed={isSelected}
										onClick={() =>
											onSelectExecution(execution.id)
										}
										className={cn(
											"relative flex w-full flex-col gap-1 px-4 py-2.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
											isSelected && "bg-accent",
										)}
									>
										<span
											className={cn(
												"absolute inset-y-2 left-0 w-0.5",
												isSelected &&
													"bg-[var(--fab-accent-fill)]",
											)}
											aria-hidden="true"
										/>
										<span className="flex w-full items-center gap-2">
											<RunStatusIcon
												status={execution.status}
											/>
											<span className="text-[13px]">
												{formatTriggerType(
													execution.triggerType,
												) ?? "Run"}
											</span>
											<span className="flex-1" />
											{timeAgo ? (
												<span className="text-xs text-muted-foreground">
													{timeAgo}
												</span>
											) : null}
										</span>
										<span className="flex items-center gap-2 pl-[22px] text-xs text-muted-foreground">
											<span className="font-mono text-[11px]">
												{shortRunId(execution.id)}
											</span>
											<span aria-hidden="true">·</span>
											<span>
												{stepCount} step
												{stepCount === 1 ? "" : "s"}
											</span>
											{duration ? (
												<>
													<span aria-hidden="true">
														·
													</span>
													<span>{duration}</span>
												</>
											) : null}
										</span>
										{execution.error ? (
											<span className="line-clamp-2 pl-[22px] text-xs text-destructive">
												{execution.error}
											</span>
										) : null}
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</aside>
	);
}
