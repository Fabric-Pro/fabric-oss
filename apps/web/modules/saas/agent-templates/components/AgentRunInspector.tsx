"use client";

import { ContextQualityDialog } from "@saas/projects/components/ContextQualityDialog";
import type { orpcClient } from "@shared/lib/orpc-client";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { SquareIcon } from "lucide-react";
import { AgentRunResult } from "./AgentRunResult";

type RunSnapshot = NonNullable<
	Awaited<ReturnType<typeof orpcClient.agentDeployments.runs.get>>
>;

export function formatAgentRunTimestamp(
	value: Date | string | null | undefined,
): string {
	if (!value) return "Not recorded";
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? "Not recorded"
		: date.toLocaleString();
}
export function AgentRunStatus({ status }: { status: string }) {
	return (
		<Badge
			variant="outline"
			className={cn(
				"bg-card",
				status === "COMPLETED"
					? "text-success"
					: status === "FAILED"
						? "text-destructive"
						: "text-muted-foreground",
			)}
		>
			{(
				{
					PENDING: "Queued",
					RUNNING: "Running",
					COMPLETED: "Completed",
					FAILED: "Failed",
					CANCELLED: "Cancelled",
					TIMED_OUT: "Timed out",
					UNKNOWN: "Status unavailable",
				} as Record<string, string>
			)[status] ?? status}
		</Badge>
	);
}

export function AgentRunInspector({
	selected,
	detail,
	cancel,
	organizationId,
	editHref,
}: {
	selected?: string;
	organizationId?: string;
	editHref?: string;
	detail: {
		data?: RunSnapshot;
		error: { message: string } | null;
		isPending: boolean;
	};
	cancel: {
		isPending: boolean;
		error: { message: string } | null;
		mutate: (executionId: string) => void;
	};
}) {
	return (
		<div className="min-w-0 p-4 lg:col-span-2">
			{!selected ? (
				<div className="py-6">
					<h4 className="font-semibold text-sm">
						Your results will appear here
					</h4>
					<p className="mt-2 text-sm text-muted-foreground">
						Select a run to see its progress, output and step
						details.
					</p>
				</div>
			) : detail.error ? (
				<Alert variant="error">
					<AlertTitle>Could not read this run</AlertTitle>
					<AlertDescription>{detail.error.message}</AlertDescription>
				</Alert>
			) : detail.isPending ? (
				<div role="status" aria-label="Loading run result">
					<Skeleton className="h-32 w-full" />
				</div>
			) : (
				detail.data && (
					<>
						<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
							<div
								className="flex flex-wrap items-center gap-2"
								role="status"
								aria-live="polite"
							>
								<AgentRunStatus status={detail.data.status} />
								<span className="text-xs text-muted-foreground">
									{detail.data.executionStateSource ===
									"temporal"
										? "Live execution"
										: "Last saved record"}
									{detail.data.durationMs != null &&
										` · ${(detail.data.durationMs / 1000).toFixed(1)}s`}
								</span>
							</div>
							{["PENDING", "RUNNING"].includes(
								detail.data.status,
							) && (
								<AlertDialog>
									<AlertDialogTrigger asChild>
										<Button
											variant="outline"
											size="sm"
											disabled={cancel.isPending}
										>
											<SquareIcon className="size-4" />
											Cancel run
										</Button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												Cancel this run?
											</AlertDialogTitle>
											<AlertDialogDescription>
												The agent will stop at the next
												safe point. Actions already sent
												to connected services cannot be
												undone.
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>
												Keep running
											</AlertDialogCancel>
											<AlertDialogAction
												onClick={() =>
													cancel.mutate(selected)
												}
											>
												Cancel run
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							)}
						</div>
						{detail.data.status === "UNKNOWN" && (
							<Alert variant="warning" className="mb-4">
								<AlertTitle>
									Live status is unavailable
								</AlertTitle>
								<AlertDescription>
									The last saved status is{" "}
									{detail.data.lastRecordedStatus}. We’ll keep
									checking. This does not mean the run has
									stopped.
								</AlertDescription>
							</Alert>
						)}
						{cancel.error && (
							<Alert variant="error" className="mb-4">
								<AlertDescription>
									{cancel.error.message}
								</AlertDescription>
							</Alert>
						)}
						<AgentRunResult
							status={detail.data.status}
							output={detail.data.output}
							result={detail.data.result}
							progress={detail.data.progress}
							error={detail.data.error}
							artifacts={detail.data.artifacts}
						/>
						{detail.data.status === "COMPLETED" &&
							detail.data.projectId &&
							organizationId && (
								<div
									className="mt-4 border-t border-border pt-4"
									data-onboarding-target="agent-run-quality"
								>
									<ContextQualityDialog
										key={`${organizationId}:${selected}`}
										projectId={detail.data.projectId}
										organizationId={organizationId}
										sources={[]}
										agentExecutionId={selected}
										improveHref={editHref}
									/>
								</div>
							)}
						<details className="mt-4 border-t border-border pt-3">
							<summary className="cursor-pointer text-sm text-muted-foreground">
								Run details
							</summary>
							<dl className="mt-3 grid gap-2 text-xs">
								<div>
									<dt className="text-muted-foreground">
										Run ID
									</dt>
									<dd className="break-all font-mono">
										{selected}
									</dd>
								</div>
								<div>
									<dt className="text-muted-foreground">
										Queued
									</dt>
									<dd>
										{formatAgentRunTimestamp(
											detail.data.queuedAt,
										)}
									</dd>
								</div>
								<div>
									<dt className="text-muted-foreground">
										Started
									</dt>
									<dd>
										{formatAgentRunTimestamp(
											detail.data.startedAt,
										)}
									</dd>
								</div>
								<div>
									<dt className="text-muted-foreground">
										Completed
									</dt>
									<dd>
										{formatAgentRunTimestamp(
											detail.data.completedAt,
										)}
									</dd>
								</div>
							</dl>
						</details>
					</>
				)
			)}
		</div>
	);
}
