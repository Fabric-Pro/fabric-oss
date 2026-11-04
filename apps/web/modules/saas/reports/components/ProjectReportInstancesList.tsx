"use client";

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
	Loader2Icon,
	PlayIcon,
	SettingsIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { OwnerOnlyGenerate } from "./OwnerOnlyGenerate";

type ProjectReportInstance = {
	id: string;
	name: string;
	templateName: string;
	isActive: boolean;
	canGenerate: boolean;
	/** What still stops the report from generating; `null` when it is ready. */
	generateBlockedReason: string | null;
	lastRunAt: string | null;
	latestExecutionStatus: string | null;
};

type Props = {
	instances: ProjectReportInstance[];
	organizationId: string | null;
	/** Where report instance pages live (`…/report-templates`). */
	reportTemplatesPath: string;
	/** Shown in the empty state to people who may add reports. */
	onBrowseTemplates?: () => void;
};

/**
 * The reports a project already has: open one, or generate a ready one in
 * one click. A report that is not ready says what it still needs.
 */
export function ProjectReportInstancesList({
	instances,
	organizationId,
	reportTemplatesPath,
	onBrowseTemplates,
}: Props) {
	const router = useRouter();
	const queryClient = useQueryClient();

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
				const isStarting =
					executeMutation.isPending &&
					executeMutation.variables?.instanceId === instance.id;
				const isRunning =
					instance.latestExecutionStatus === "PENDING" ||
					instance.latestExecutionStatus === "RUNNING";
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
											href={href}
											className="hover:text-primary motion-safe:transition-colors"
										>
											{instance.name}
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
										instance.isActive
											? "default"
											: "secondary"
									}
								>
									{instance.isActive ? "Active" : "Paused"}
								</Badge>
							</div>
						</CardHeader>
						<CardFooter className="flex-wrap gap-2 pt-2">
							<Button variant="outline" size="sm" asChild>
								<Link href={href}>
									<SettingsIcon className="mr-1 h-3 w-3" />
									Configure
								</Link>
							</Button>
							<OwnerOnlyGenerate
								canGenerate={instance.canGenerate}
							>
								{(ownerOnlyId) => (
									<Button
										size="sm"
										onClick={() =>
											executeMutation.mutate({
												instanceId: instance.id,
												organizationId,
											})
										}
										disabled={
											!instance.canGenerate ||
											!instance.isActive ||
											Boolean(blockedReason) ||
											isRunning ||
											executeMutation.isPending
										}
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
