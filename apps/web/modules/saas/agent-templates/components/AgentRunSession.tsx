"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { ArrowLeftIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	AGENT_RUN_POLL_WINDOW_MS,
	canPollAgentRun,
} from "../lib/agent-run-polling";
import { AgentRunInspector } from "./AgentRunInspector";
import { AgentRunSchedule } from "./AgentRunSchedule";

export function AgentRunSession({
	organizationId,
	instanceId,
	executionId,
	mode,
	goal,
	editHref,
	onStarted,
	onBack,
}: {
	organizationId: string;
	instanceId: string;
	executionId?: string;
	mode: "new" | "result" | "schedule";
	goal?: string | null;
	editHref: string;
	onStarted: (executionId: string) => void;
	onBack: () => void;
}) {
	const client = useQueryClient();
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const [pollSince, setPollSince] = useState(Date.now);
	const [message, setMessage] = useState(goal ?? "");
	const attempt = useRef<{ message: string; key: string } | null>(null);
	const schedule = useQuery({
		queryKey: ["saved-agent-schedule", organizationId, instanceId],
		queryFn: () =>
			orpcClient.agentDeployments.runs.list({
				organizationId,
				instanceId,
				limit: 1,
			}),
		enabled: mode === "schedule",
		retry: false,
	});
	const detail = useQuery({
		queryKey: ["saved-agent-run", organizationId, executionId],
		queryFn: () => {
			if (!executionId) throw new Error("Choose a run to inspect.");
			return orpcClient.agentDeployments.runs.get({
				organizationId,
				executionId,
			});
		},
		enabled: mode === "result" && !!executionId,
		retry: false,
		refetchInterval: (q) =>
			!q.state.error && canPollAgentRun(q.state.data?.status, pollSince)
				? 3000
				: false,
	});
	const invalidate = () => {
		void client.invalidateQueries({ queryKey: ["saved-agent-history"] });
		void client.invalidateQueries({ queryKey: ["saved-agent-active"] });
	};
	const start = useMutation({
		mutationFn: () => {
			const task = message.trim();
			if (!attempt.current || attempt.current.message !== task) {
				attempt.current = { message: task, key: crypto.randomUUID() };
			}
			return orpcClient.agentDeployments.runs.start({
				organizationId,
				instanceId,
				input: { message: task },
				idempotencyKey: attempt.current.key,
			});
		},
		retry: false,
		onSuccess: (receipt) => {
			attempt.current = null;
			invalidate();
			if (mounted.current) onStarted(receipt.executionId);
			toast.success(
				"Run started. You can close this panel while it works.",
			);
		},
	});
	const cancel = useMutation({
		mutationFn: (id: string) =>
			orpcClient.agentDeployments.runs.cancel({
				organizationId,
				executionId: id,
			}),
		retry: false,
		onSuccess: () => {
			void detail.refetch();
			invalidate();
			toast.success(
				"Cancellation requested. Waiting for the run to stop.",
			);
		},
	});
	return (
		<div className="min-w-0">
			<div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
				<Button
					type="button"
					size="sm"
					variant="ghost"
					onClick={onBack}
				>
					<ArrowLeftIcon className="size-4" />
					Back to runs
				</Button>
				{mode === "result" && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => {
							setPollSince(Date.now());
							void detail.refetch();
						}}
						loading={detail.isFetching}
					>
						<RefreshCwIcon className="size-4" />
						Refresh run
					</Button>
				)}
			</div>
			{mode === "result" && (
				<p className="px-4 pt-4 text-xs text-muted-foreground">
					Results reflect the saved configuration used when this run
					started. Agent edits apply to future runs.
				</p>
			)}
			{mode === "result" &&
				detail.data &&
				(detail.data.status === "UNKNOWN" ||
					(["PENDING", "RUNNING"].includes(detail.data.status) &&
						Date.now() - pollSince >=
							AGENT_RUN_POLL_WINDOW_MS)) && (
					<p
						role="status"
						className="px-4 pt-4 text-sm text-muted-foreground"
					>
						Automatic updates paused. Use Refresh run to check the
						latest status.
					</p>
				)}
			{mode === "result" ? (
				<AgentRunInspector
					organizationId={organizationId}
					editHref={editHref}
					selected={executionId}
					detail={detail}
					cancel={cancel}
				/>
			) : mode === "schedule" ? (
				schedule.isPending ? (
					<div
						className="p-4"
						role="status"
						aria-label="Loading schedule"
					>
						<Skeleton className="h-24 w-full" />
					</div>
				) : schedule.error ? (
					<Alert variant="error" className="m-4 w-auto">
						<AlertTitle>Could not load schedule</AlertTitle>
						<AlertDescription>
							{schedule.error.message}
							<Button
								variant="outline"
								onClick={() => void schedule.refetch()}
							>
								Try again
							</Button>
						</AlertDescription>
					</Alert>
				) : schedule.data ? (
					<>
						{schedule.data.schedulingState === "UNKNOWN" && (
							<Alert variant="warning" className="m-4 w-auto">
								<AlertTitle>
									Schedule state unconfirmed
								</AlertTitle>
								<AlertDescription>
									Save the schedule again to confirm its
									state.
								</AlertDescription>
							</Alert>
						)}
						<AgentRunSchedule
							organizationId={organizationId}
							instanceId={instanceId}
							schedule={schedule.data.schedule}
							defaultMessage={message}
							onSaved={() => {
								void client.invalidateQueries({
									queryKey: [
										"saved-agent-schedule",
										organizationId,
										instanceId,
									],
								});
								onBack();
							}}
							onClose={onBack}
						/>
					</>
				) : null
			) : (
				<form
					className="space-y-4 p-6"
					aria-label="Start agent run"
					onSubmit={(e) => {
						e.preventDefault();
						if (message.trim() && !start.isPending) {
							start.mutate();
						}
					}}
				>
					<div>
						<h3 className="text-base font-semibold">
							Give this agent a task
						</h3>
						<p className="mt-2 text-sm text-muted-foreground">
							Uses its saved instructions, knowledge and
							connections. The run continues when you close this
							panel.
						</p>
					</div>
					<div className="space-y-2">
						<Label htmlFor="agent-run-task">
							Task for this run
						</Label>
						<Textarea
							id="agent-run-task"
							rows={5}
							maxLength={20000}
							required
							autoFocus
							disabled={start.isPending}
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder="Describe the result you need…"
							aria-describedby="agent-run-task-help"
						/>
						<p
							id="agent-run-task-help"
							className="text-xs text-muted-foreground"
						>
							Enter a task to enable Run agent.
						</p>
					</div>
					{start.error && (
						<Alert variant="error">
							<AlertTitle>Could not confirm the run</AlertTitle>
							<AlertDescription>
								{start.error.message} Retry the unchanged task
								to check the same request without creating a
								duplicate.
							</AlertDescription>
						</Alert>
					)}
					<Button
						type="submit"
						loading={start.isPending}
						disabled={!message.trim() || start.isPending}
					>
						<PlayIcon className="size-4" />
						{start.error &&
						attempt.current?.message === message.trim()
							? "Retry request"
							: "Run agent"}
					</Button>
				</form>
			)}
		</div>
	);
}
