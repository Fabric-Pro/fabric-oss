"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import {
	AGENT_RUN_POLL_WINDOW_MS,
	canPollAgentRun,
} from "../lib/agent-run-polling";
import { AgentRunStatus, formatAgentRunTimestamp } from "./AgentRunInspector";

type Filters = {
	query: string;
	status: string;
	triggerType: string;
	from: string;
	to: string;
};
const emptyFilters: Filters = {
	query: "",
	status: "ALL",
	triggerType: "ALL",
	from: "",
	to: "",
};
export type AgentHistorySelection = {
	id: string;
	instanceId: string;
	agentName: string;
};
export function AgentRunHistory({
	organizationId,
	instanceId,
	compact = false,
	historyHref,
	initialStatus = "ALL",
	onSelect,
	onAgentChange,
}: {
	organizationId: string;
	instanceId?: string;
	compact?: boolean;
	historyHref?: string;
	initialStatus?: string;
	onSelect: (run: AgentHistorySelection) => void;
	onAgentChange?: (instanceId: string | undefined) => void;
}) {
	const id = useId();
	const [pollSince, setPollSince] = useState(Date.now);
	const [draft, setDraft] = useState<Filters>({
		...emptyFilters,
		status: initialStatus,
	});
	const [filters, setFilters] = useState<Filters>({
		...emptyFilters,
		status: initialStatus,
	});
	const [cursors, setCursors] = useState<Array<string | undefined>>([
		undefined,
	]);
	const cursor = cursors.at(-1);
	const input = {
		organizationId,
		instanceId,
		limit: compact ? 5 : 25,
		cursor,
		query: filters.query.trim() || undefined,
		status:
			filters.status === "ALL"
				? undefined
				: (filters.status as
						| "ACTIVE"
						| "COMPLETED"
						| "FAILED"
						| "CANCELLED"
						| "TIMED_OUT"),
		triggerType:
			filters.triggerType === "ALL"
				? undefined
				: (filters.triggerType as
						| "MANUAL"
						| "SCHEDULE"
						| "API"
						| "WEBHOOK"
						| "EVENT"
						| "SLACK"),
		from: filters.from
			? new Date(`${filters.from}T00:00:00`).toISOString()
			: undefined,
		to: filters.to
			? new Date(`${filters.to}T23:59:59.999`).toISOString()
			: undefined,
	};
	const list = useQuery({
		queryKey: ["saved-agent-history", input],
		queryFn: ({ signal }) =>
			orpcClient.agentDeployments.runs.search(input, { signal }),
		retry: false,
		placeholderData: keepPreviousData,
		refetchInterval: (q) =>
			!q.state.error &&
			q.state.data?.executions.some((run) =>
				canPollAgentRun(run.status, pollSince),
			)
				? 15000
				: false,
	});
	const identity = useQuery({
		queryKey: ["saved-agent-history-identity", organizationId, instanceId],
		queryFn: () => {
			if (!instanceId) throw new Error("Select an agent.");
			return orpcClient.agentTemplates.instances.get({
				organizationId,
				id: instanceId,
			});
		},
		enabled: !compact && !!instanceId,
		retry: false,
	});
	const agentName =
		list.data?.executions[0]?.agentName ?? identity.data?.instance.name;
	const apply = () => {
		setPollSince(Date.now());
		setFilters({ ...draft });
		setCursors([undefined]);
	};
	return (
		<section
			aria-label={compact ? "Recent agent runs" : "Agent run history"}
			className="min-w-0 space-y-4 p-4"
			data-onboarding-target="agents-runs"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="font-semibold break-words">
						{compact
							? "Recent runs"
							: instanceId
								? agentName
									? `${agentName} runs`
									: "Agent run history"
								: "All agent runs"}
					</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						{compact
							? "Open a run to see its result and recorded steps."
							: instanceId
								? "Showing this agent’s background runs across saved versions."
								: "Background runs across your agents. Select an agent name to see only its runs."}
					</p>
				</div>
				{!compact && instanceId && onAgentChange && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => onAgentChange(undefined)}
					>
						All agents
					</Button>
				)}
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => {
						setPollSince(Date.now());
						void list.refetch();
					}}
					loading={list.isFetching}
				>
					<RefreshCwIcon className="size-4" />
					Refresh
				</Button>
			</div>
			{list.data?.executions.some((run) => run.status === "UNKNOWN") && (
				<p className="text-sm text-muted-foreground">
					Some statuses need checking. Open a run to inspect its
					outcome.
				</p>
			)}
			{Date.now() - pollSince >= AGENT_RUN_POLL_WINDOW_MS &&
				list.data?.executions.some((run) =>
					["PENDING", "RUNNING"].includes(run.status),
				) && (
					<p role="status" className="text-sm text-muted-foreground">
						Automatic updates paused. Refresh to check the latest
						status.
					</p>
				)}
			{!compact && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						apply();
					}}
					className="space-y-3"
					aria-label="Filter run history"
				>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<div className="space-y-1">
							<Label htmlFor={`${id}-query`}>Search runs</Label>
							<Input
								id={`${id}-query`}
								maxLength={200}
								placeholder="Task or run ID"
								value={draft.query}
								onChange={(e) =>
									setDraft({
										...draft,
										query: e.target.value,
									})
								}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-status`}>Status</Label>
							<Select
								value={draft.status}
								onValueChange={(status) =>
									setDraft({ ...draft, status })
								}
							>
								<SelectTrigger id={`${id}-status`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{[
										["ALL", "All statuses"],
										["ACTIVE", "In progress"],
										["COMPLETED", "Completed"],
										["FAILED", "Failed"],
										["CANCELLED", "Cancelled"],
										["TIMED_OUT", "Timed out"],
									].map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-trigger`}>Started by</Label>
							<Select
								value={draft.triggerType}
								onValueChange={(triggerType) =>
									setDraft({ ...draft, triggerType })
								}
							>
								<SelectTrigger id={`${id}-trigger`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{[
										["ALL", "All triggers"],
										["MANUAL", "Manual"],
										["SCHEDULE", "Schedule"],
										["API", "API"],
										["WEBHOOK", "Webhook"],
										["EVENT", "Event"],
										["SLACK", "Slack"],
									].map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-from`}>From date</Label>
							<Input
								id={`${id}-from`}
								type="date"
								value={draft.from}
								max={draft.to || undefined}
								onChange={(e) =>
									setDraft({ ...draft, from: e.target.value })
								}
							/>
						</div>
						<div className="space-y-1">
							<Label htmlFor={`${id}-to`}>To date</Label>
							<Input
								id={`${id}-to`}
								type="date"
								value={draft.to}
								min={draft.from || undefined}
								onChange={(e) =>
									setDraft({ ...draft, to: e.target.value })
								}
							/>
						</div>
						<div className="flex items-end gap-2">
							<Button type="submit">Apply filters</Button>
							<Button
								type="button"
								variant="ghost"
								onClick={() => {
									setDraft(emptyFilters);
									setFilters(emptyFilters);
									setCursors([undefined]);
								}}
							>
								Clear
							</Button>
						</div>
					</div>
				</form>
			)}
			{list.error ? (
				<Alert variant="error">
					<AlertTitle>Could not load runs</AlertTitle>
					<AlertDescription>{list.error.message}</AlertDescription>
				</Alert>
			) : list.isPending ? (
				<div aria-label="Loading runs" role="status">
					<Skeleton className="h-32 w-full" />
				</div>
			) : !list.data?.executions.length ? (
				<p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
					{compact
						? "No runs yet. Use Run agent to start a task."
						: "No runs match these filters. Try another date range or clear the filters."}
				</p>
			) : (
				<div
					className="overflow-hidden rounded-md border border-border"
					aria-busy={list.isFetching}
				>
					<Table aria-label="Agent runs" className="min-w-2xl">
						<TableHeader>
							<TableRow>
								{[
									...(!compact ? ["Agent"] : []),
									"Task",
									"Status",
									"Started",
									"Trigger",
									"Duration",
								].map((name) => (
									<TableHead scope="col" key={name}>
										{name}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{list.data.executions.map((run) => (
								<TableRow key={run.id}>
									{!compact && (
										<TableCell>
											{onAgentChange &&
											run.instanceId !== instanceId ? (
												<button
													type="button"
													className="block max-w-48 truncate text-left font-medium hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
													title={run.agentName}
													aria-label={`Show runs for ${run.agentName}`}
													disabled={
														list.isPlaceholderData
													}
													onClick={() =>
														onAgentChange(
															run.instanceId,
														)
													}
												>
													{run.agentName}
												</button>
											) : (
												<span
													className="block max-w-48 truncate"
													title={run.agentName}
												>
													{run.agentName}
												</span>
											)}
										</TableCell>
									)}
									<TableCell>
										<button
											type="button"
											className="block max-w-64 truncate text-left font-medium hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
											disabled={list.isPlaceholderData}
											title={run.task || "Untitled task"}
											onClick={() => onSelect(run)}
										>
											{run.task || "Untitled task"}
										</button>
									</TableCell>
									<TableCell>
										<span
											title={
												run.status === "UNKNOWN"
													? "Open this run to check its outcome. Automatic updates pause when status cannot be verified."
													: undefined
											}
										>
											<AgentRunStatus
												status={run.status}
											/>
										</span>
									</TableCell>
									<TableCell className="whitespace-nowrap text-xs text-muted-foreground">
										{formatAgentRunTimestamp(
											run.queuedAt ?? run.createdAt,
										)}
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{(
											{
												MANUAL: "Manual",
												SCHEDULE: "Schedule",
												API: "API",
												WEBHOOK: "Webhook",
												EVENT: "Event",
												SLACK: "Slack",
											} as Record<string, string>
										)[run.triggerType] ?? run.triggerType}
									</TableCell>
									<TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
										{run.duration == null
											? "—"
											: `${(run.duration / 1000).toFixed(1)}s`}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{!compact && (
				<div className="flex flex-wrap items-center justify-between gap-3 text-sm">
					<span className="text-muted-foreground">
						Page {cursors.length}
						{list.data?.nextCursor ? " · More runs available" : ""}
					</span>
					<div className="flex gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={cursors.length === 1 || list.isFetching}
							onClick={() => setCursors((c) => c.slice(0, -1))}
						>
							<ChevronLeftIcon className="size-4" />
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={
								!list.data?.nextCursor ||
								list.isFetching ||
								!!list.error
							}
							onClick={() => {
								const next = list.data?.nextCursor;
								if (next) {
									setCursors((c) => [...c, next]);
								}
							}}
						>
							Next
							<ChevronRightIcon className="size-4" />
						</Button>
					</div>
				</div>
			)}
			{compact && historyHref && (
				<Button asChild variant="outline" className="w-full">
					<Link href={historyHref}>View full history</Link>
				</Button>
			)}
		</section>
	);
}
