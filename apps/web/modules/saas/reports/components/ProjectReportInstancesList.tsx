"use client";

import {
	isReportRunning,
	listShowsStartedRun,
	type PressedRun,
	STARTED_RUN_WAIT_MS,
} from "@saas/reports/lib/project-report-suite";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { formatDistanceToNow } from "date-fns";
import {
	FileTextIcon,
	HistoryIcon,
	Loader2Icon,
	PlayIcon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { OwnerOnlyGenerate } from "./OwnerOnlyGenerate";
import { ReportViewAction, viewLatestReportHref } from "./ReportViewAction";

type ProjectReportInstance = {
	id: string;
	name: string;
	templateName: string;
	status: string;
	isActive: boolean;
	/** The report's owner. */
	userId?: string | null;
	canGenerate: boolean;
	/** What still stops the report from generating; `null` when it is ready. */
	generateBlockedReason: string | null;
	lastRunAt: string | null;
	executionCount?: number;
	latestExecutionStatus: string | null;
	/** What View opens; `null` until a run has succeeded. */
	latestSuccessfulReport: { artifactId: string } | null;
};

type Props = {
	instances: ProjectReportInstance[];
	viewerUserId?: string;
	organizationId: string | null;
	/** Where report instance pages live (`…/report-templates`). */
	reportTemplatesPath: string;
	/** Shown in the empty state to people who may add reports. */
	onBrowseTemplates?: () => void;
};

/**
 * The reports a project already has: the title opens its execution history,
 * View its latest successful report, Configure its settings, and Generate a
 * ready one in one click. A report that is not ready says what it still needs.
 */
export function ProjectReportInstancesList({
	instances,
	viewerUserId,
	organizationId,
	reportTemplatesPath,
	onBrowseTemplates,
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();
	// Generate stays busy from the press until the refetched list shows the
	// run: between the request's success and that refetch the row still shows
	// the previous run, and a second press there would start a second run.
	const [pressedRun, setPressedRun] = useState<PressedRun | null>(null);

	useEffect(() => {
		if (!pressedRun) {
			return;
		}
		const timer = setTimeout(
			() => setPressedRun(null),
			STARTED_RUN_WAIT_MS,
		);
		return () => clearTimeout(timer);
	}, [pressedRun]);

	const executeMutation = useMutation(
		orpc.reports.instances.execute.mutationOptions({
			onSuccess: (_data, variables) => {
				const href = `${reportTemplatesPath}/instances/${variables.instanceId}?tab=history`;
				toast.success("Report generation started", {
					action: {
						label: "View run",
						onClick: () => router.push(href),
					},
				});
				queryClient.invalidateQueries({
					queryKey: orpc.reports.instances.list.key(),
				});
			},
			onError: (error) => {
				setPressedRun(null);
				toast.error(error.message || "Failed to start the report");
			},
		}),
	);

	if (instances.length === 0) {
		return (
			<div className="py-12 text-center">
				<FileTextIcon
					aria-hidden="true"
					className="mx-auto h-12 w-12 text-muted-foreground"
				/>
				<h3 className="mt-4 text-lg font-semibold">
					No reports in this project yet
				</h3>
				<p className="mb-4 text-muted-foreground">
					Start one from a template to generate reports for this
					project.
				</p>
				{onBrowseTemplates && (
					<Button onClick={onBrowseTemplates}>
						Browse templates
					</Button>
				)}
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{instances.map((instance) => {
				const href = `${reportTemplatesPath}/instances/${instance.id}`;
				const isAwaitingRun =
					pressedRun?.instanceId === instance.id &&
					!listShowsStartedRun(instance, pressedRun);
				const isStarting =
					isAwaitingRun ||
					(executeMutation.isPending &&
						executeMutation.variables?.instanceId === instance.id);
				const isRunning = isReportRunning(instance);
				const isBusy =
					isRunning || isAwaitingRun || executeMutation.isPending;
				const blockedReason = instance.canGenerate
					? instance.generateBlockedReason
					: null;
				const blockedReasonId = `report-${instance.id}-not-ready`;

				return (
					<Card key={instance.id}>
						<CardHeader className="pb-2">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<CardTitle className="text-base">
										<Link
											href={`${href}?tab=history`}
											className="inline-flex items-center gap-1 underline decoration-muted-foreground/50 underline-offset-4 hover:text-primary hover:decoration-primary motion-safe:transition-colors"
										>
											{instance.name}
											<HistoryIcon
												aria-hidden="true"
												className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
											/>
											<span className="sr-only">
												, execution history
											</span>
										</Link>
									</CardTitle>
									<CardDescription>
										Based on {instance.templateName}
										{isRunning
											? " · Running now"
											: instance.lastRunAt
												? ` · Last run ${formatDistanceToNow(
														new Date(
															instance.lastRunAt,
														),
														{ addSuffix: true },
													)}`
												: null}
									</CardDescription>
								</div>
								<Badge
									variant={
										instance.isActive &&
										instance.status !== "DRAFT"
											? "default"
											: "secondary"
									}
								>
									{instance.status === "DRAFT"
										? "Draft"
										: instance.isActive
											? "Active"
											: "Paused"}
								</Badge>
							</div>
						</CardHeader>
						<CardFooter className="flex-wrap items-start gap-2 pt-2">
							<ReportViewAction
								hasSuccessfulReport={
									instance.latestSuccessfulReport !== null
								}
								href={viewLatestReportHref(href)}
							/>
							<Button variant="outline" size="sm" asChild>
								<Link href={href}>
									<SettingsIcon className="mr-1 h-3 w-3" />
									Configure
								</Link>
							</Button>
							<OwnerOnlyGenerate
								canGenerate={instance.canGenerate}
								viewerIsOwner={
									viewerUserId !== undefined &&
									instance.userId === viewerUserId
								}
							>
								{(ownerOnlyId) => (
									<Button
										size="sm"
										onClick={() => {
											if (!isBusy) {
												setPressedRun({
													instanceId: instance.id,
													executionCount:
														instance.executionCount ??
														null,
													lastRunAt:
														instance.lastRunAt,
												});
												executeMutation.mutate({
													instanceId: instance.id,
													organizationId,
												});
											}
										}}
										disabled={
											!instance.canGenerate ||
											!instance.isActive ||
											Boolean(blockedReason)
										}
										// Not `disabled` while the run starts and runs:
										// that would drop focus from the button just
										// pressed.
										aria-disabled={isBusy || undefined}
										className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
										aria-describedby={
											[
												ownerOnlyId,
												blockedReason
													? blockedReasonId
													: undefined,
											]
												.filter(Boolean)
												.join(" ") || undefined
										}
									>
										{isStarting ? (
											<Loader2Icon className="mr-1 h-3 w-3 motion-safe:animate-spin" />
										) : (
											<PlayIcon className="mr-1 h-3 w-3" />
										)}
										Generate
									</Button>
								)}
							</OwnerOnlyGenerate>
							{blockedReason && (
								<p
									id={blockedReasonId}
									className="w-full text-xs text-muted-foreground"
								>
									Not ready: {blockedReason}
								</p>
							)}
						</CardFooter>
					</Card>
				);
			})}
		</div>
	);
}
