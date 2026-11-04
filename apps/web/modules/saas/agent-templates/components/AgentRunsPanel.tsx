"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";

import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { CalendarClockIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AgentRunInspector,
	AgentRunStatus,
	formatAgentRunTimestamp,
} from "./AgentRunInspector";
import { AgentRunSchedule } from "./AgentRunSchedule";

const pending = (status: string) =>
	["PENDING", "RUNNING", "UNKNOWN"].includes(status);
export function AgentRunsPanel({
	instanceId,
	organizationId,
	projectName,
	goal,
	editHref,
}: {
	instanceId: string;
	organizationId: string;
	projectName?: string | null;
	goal?: string | null;
	editHref: string;
}) {
	const id = useId();
	const queryClient = useQueryClient();
	const queryKey = ["saved-agent-runs", organizationId, instanceId];
	const [message, setMessage] = useState(goal ?? "");
	const [selectedId, setSelectedId] = useState<string>();
	const [showSchedule, setShowSchedule] = useState(false);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const attempt = useRef<{ message: string; key: string } | null>(null);
	const list = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.agentDeployments.runs.list({
				instanceId,
				organizationId,
				limit: 20,
			}),
		refetchInterval: 10000,
		retry: false,
	});
	const selected = selectedId ?? list.data?.executions[0]?.id;
	const detail = useQuery({
		queryKey: [...queryKey, "execution", selected],
		queryFn: () =>
			orpcClient.agentDeployments.runs.get({
				executionId: selected as string,
				organizationId,
			}),
		enabled: !!selected && !list.error,
		refetchInterval: (query) =>
			query.state.data && !pending(query.state.data.status)
				? false
				: 3000,
		retry: false,
	});
	const invalidate = () => queryClient.invalidateQueries({ queryKey });
	const start = useMutation({
		mutationFn: async () => {
			const task = message.trim();
			if (!attempt.current || attempt.current.message !== task)
				attempt.current = { message: task, key: crypto.randomUUID() };
			return orpcClient.agentDeployments.runs.start({
				instanceId,
				organizationId,
				input: { message: task },
				idempotencyKey: attempt.current.key,
			});
		},
		retry: false,
		onSuccess: (receipt) => {
			setSelectedId(receipt.executionId);
			attempt.current = null;
			void invalidate();
			toast.success("Run accepted");
			headingRef.current?.focus();
			headingRef.current?.scrollIntoView?.({ block: "start" });
		},
	});
	const cancel = useMutation({
		mutationFn: (executionId: string) =>
			orpcClient.agentDeployments.runs.cancel({
				executionId,
				organizationId,
			}),
		retry: false,
		onSuccess: (receipt) => {
			toast.success(
				receipt.requested
					? "Cancellation requested. Waiting for the run to stop."
					: "This run has already finished.",
			);
			void invalidate();
		},
	});

	return (
		<section
			id="agent-runs"
			aria-labelledby={`${id}-heading`}
			data-onboarding-target="agents-runs"
			className="scroll-mt-20 overflow-hidden rounded-lg border border-border bg-card"
		>
			<div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
				<div>
					<h3
						id={`${id}-heading`}
						ref={headingRef}
						tabIndex={-1}
						className="font-semibold text-base"
					>
						Run & results
					</h3>
					<p className="mt-1 text-sm text-muted-foreground">
						Give this agent a task, then follow its work here. You
						can leave this page while it runs.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setShowSchedule(!showSchedule)}
					aria-expanded={showSchedule}
				>
					<CalendarClockIcon className="size-4" />
					{list.data?.schedule ? "Edit schedule" : "Schedule"}
				</Button>
			</div>
			{list.data?.schedule && !showSchedule && (
				<div className="border-t border-border px-4 py-3 text-sm">
					<span className="font-medium">
						{list.data.schedulingState === "UNKNOWN"
							? "Schedule state unconfirmed"
							: list.data.schedule.enabled
								? "Scheduled"
								: "Schedule paused"}
					</span>
					{list.data.schedulingState === "UNKNOWN" && (
						<p className="mt-2 text-sm text-muted-foreground">
							The configuration is saved. Open Edit schedule and
							save it again to confirm or repair the engine
							schedule.
						</p>
					)}
					<span className="ml-2 text-muted-foreground">
						{list.data.schedule.cronExpression} ·{" "}
						{list.data.schedule.timezone}
					</span>
				</div>
			)}
			{showSchedule && list.data && !list.error && (
				<AgentRunSchedule
					key={list.data.schedule?.id ?? "new"}
					instanceId={instanceId}
					organizationId={organizationId}
					schedule={list.data.schedule}
					defaultMessage={message}
					onSaved={() => {
						void invalidate();
						setShowSchedule(false);
					}}
					onClose={() => setShowSchedule(false)}
				/>
			)}
			{list.error ? (
				<div className="border-t border-border p-4">
					<Alert variant="error">
						<AlertTitle>Could not load runs</AlertTitle>
						<AlertDescription>
							{list.error.message}
						</AlertDescription>
					</Alert>
					<Button
						className="mt-3"
						variant="outline"
						onClick={() => list.refetch()}
					>
						Try again
					</Button>
				</div>
			) : list.isPending ? (
				<div
					className="space-y-3 border-t border-border p-4"
					role="status"
					aria-label="Loading runs"
				>
					<Skeleton className="h-8 w-48" />
					<Skeleton className="h-24 w-full" />
				</div>
			) : (
				<div className="grid min-w-0 border-t border-border lg:grid-cols-3">
					<div className="min-w-0 border-b border-border lg:border-r lg:border-b-0">
						<div className="flex items-center justify-between gap-2 p-4">
							<h4 className="font-semibold text-sm">
								Recent runs
							</h4>
							<Button
								size="icon"
								variant="ghost"
								aria-label="Refresh runs"
								onClick={() => {
									void list.refetch();
									if (selected) void detail.refetch();
								}}
							>
								<RefreshCwIcon className="size-4" />
							</Button>
						</div>
						{list.data?.executions.length ? (
							<ul
								aria-label="Run history"
								className="max-h-96 overflow-y-auto"
							>
								{list.data.executions.map((run) => (
									<li key={run.id}>
										<button
											type="button"
											aria-pressed={selected === run.id}
											className={cn(
												"w-full border-t border-border px-4 py-3 text-left hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
												selected === run.id &&
													"bg-accent",
											)}
											onClick={() =>
												setSelectedId(run.id)
											}
										>
											<div className="flex flex-wrap items-center justify-between gap-2">
												<AgentRunStatus
													status={
														selected === run.id &&
														detail.data &&
														!detail.error
															? detail.data.status
															: run.status
													}
												/>
												<span className="text-xs text-muted-foreground">
													{run.triggerType ===
													"SCHEDULE"
														? "Scheduled"
														: "Manual"}
												</span>
											</div>
											<p className="mt-2 text-xs text-muted-foreground">
												{formatAgentRunTimestamp(
													run.queuedAt ??
														run.createdAt,
												)}
											</p>
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="px-4 pb-4 text-sm text-muted-foreground">
								No runs yet. Start with a small task to check
								the result before scheduling this agent.
							</p>
						)}
					</div>
					<AgentRunInspector
						organizationId={organizationId}
						editHref={editHref}
						selected={selected}
						detail={detail}
						cancel={cancel}
					/>
				</div>
			)}
			<form
				className="space-y-3 border-t border-border p-4"
				aria-label="Start a new run"
				onSubmit={(event) => {
					event.preventDefault();
					if (message.trim() && !start.isPending) start.mutate();
				}}
			>
				<div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
					<span>
						{projectName
							? `Project: ${projectName}`
							: "Uses this agent’s saved context"}{" "}
						· Saved knowledge and connections
					</span>
					<Link
						className="underline underline-offset-4 hover:text-foreground"
						href={editHref}
					>
						Edit context & connections
					</Link>
				</div>
				<div className="space-y-2">
					<Label htmlFor="agent-run-task">Task for this run</Label>
					<Textarea
						id="agent-run-task"
						aria-describedby="agent-run-task-help"
						required
						maxLength={20000}
						rows={3}
						disabled={start.isPending}
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						placeholder="Enter a task for this agent…"
					/>
					<p
						id="agent-run-task-help"
						className="text-xs text-muted-foreground"
					>
						Enter a task to enable Run agent. Your previous results
						stay available above.
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Button
						type="submit"
						loading={start.isPending}
						disabled={
							!message.trim() ||
							start.isPending ||
							!!list.error ||
							list.isPending
						}
					>
						<PlayIcon className="size-4" />
						{start.error &&
						attempt.current?.message === message.trim()
							? "Retry request"
							: "Run agent"}
					</Button>
					<p className="text-xs text-muted-foreground">
						Runs with your current access to this agent and its
						project.
					</p>
				</div>
				{start.error && (
					<Alert variant="error">
						<AlertTitle>Could not confirm the run</AlertTitle>
						<AlertDescription>
							{start.error.message} Retry the unchanged task to
							check the same request without creating a duplicate.
						</AlertDescription>
					</Alert>
				)}
			</form>
		</section>
	);
}
