"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { formatDistanceToNow } from "date-fns";
import { EyeIcon, Loader2Icon, RotateCcwIcon } from "lucide-react";
import { ReportArtifactContent } from "./ReportArtifactContent";

const SAMPLE_ARTIFACT_NAME = "sample-report.md";

/**
 * What a template produces, shown before a report is set up: the newest
 * successful report made from it in this project, or else a sample labelled
 * as sample data, requested as soon as the preview opens. The API returns the
 * template's stored sample when there is one, and otherwise writes one, storing
 * it only for someone who may add reports to the project; it is kept in the
 * query cache, so reopening the template asks again only after a reload.
 */
export function ReportTemplatePreview({
	templateId,
	projectId,
	organizationId,
}: {
	templateId: string;
	projectId: string;
	organizationId: string | null | undefined;
}) {
	const projectSourcePath = useContextPath("projects");
	const input = { templateId, projectId, organizationId };
	const preview = useQuery(
		orpc.reports.templates.preview.queryOptions({ input }),
	);
	const run = preview.data?.run ?? null;
	const sample = useQuery({
		...orpc.reports.templates.sample.queryOptions({
			input: { templateId, organizationId, projectId },
		}),
		// The stored sample belongs to the template, not the project.
		queryKey: orpc.reports.templates.sample.queryKey({
			input: { templateId, organizationId },
		}),
		enabled: preview.isSuccess && !run,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const headingId = `report-preview-${templateId}`;

	return (
		<section
			aria-labelledby={headingId}
			className="space-y-3 rounded-lg border bg-muted/40 p-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3
					id={headingId}
					className="flex items-center gap-2 font-medium"
				>
					<EyeIcon aria-hidden="true" className="h-4 w-4" />
					Preview
				</h3>
				{run ? (
					<Badge variant="success">Last successful report</Badge>
				) : sample.data ? (
					<Badge variant="warning">Sample data</Badge>
				) : null}
			</div>

			{/*
			 * One fixed height for every state, so the form below does not move
			 * when the earlier report or the sample arrives; shorter on a phone,
			 * so the first field stays on screen.
			 */}
			<div className="flex h-44 flex-col gap-2 sm:h-96">
				{preview.isPending ? (
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2Icon className="h-4 w-4 motion-safe:animate-spin" />
						Looking for an earlier report...
					</p>
				) : preview.isError ? (
					<div className="space-y-2">
						<p role="alert" className="text-sm text-destructive">
							The earlier report could not be loaded.
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={preview.isFetching}
							onClick={() => void preview.refetch()}
						>
							<RotateCcwIcon className="mr-2 h-4 w-4" />
							Try again
						</Button>
					</div>
				) : run ? (
					<>
						<p className="text-xs text-muted-foreground">
							From “{run.instanceName}”
							{run.completedAt &&
								`, generated ${formatDistanceToNow(new Date(run.completedAt), { addSuffix: true })}`}
							.
						</p>
						<div className="min-h-0 flex-1 overflow-auto rounded-md border bg-background">
							<ReportArtifactContent
								name={run.artifact.name}
								content={run.artifact.content}
								projectSourcePath={projectSourcePath}
								embedded
							/>
						</div>
					</>
				) : sample.data ? (
					<>
						<p className="text-xs text-muted-foreground">
							Written by AI from the template to show its layout.
							The data is invented, not read from this project.
						</p>
						<div className="min-h-0 flex-1 overflow-auto rounded-md border border-dashed bg-background">
							<ReportArtifactContent
								name={SAMPLE_ARTIFACT_NAME}
								content={sample.data.content}
								projectSourcePath={projectSourcePath}
								embedded
							/>
						</div>
					</>
				) : (
					<div className="space-y-2">
						<p className="text-sm text-muted-foreground">
							No report from this template has run in this project
							yet.
						</p>
						{sample.isFetching ? (
							<p className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2Icon
									aria-hidden="true"
									className="h-4 w-4 motion-safe:animate-spin"
								/>
								Preparing a sample with example data...
							</p>
						) : sample.isError ? (
							<>
								<p
									role="alert"
									className="text-xs text-destructive"
								>
									{sample.error.message}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void sample.refetch()}
								>
									<RotateCcwIcon className="mr-2 h-4 w-4" />
									Try again
								</Button>
							</>
						) : null}
					</div>
				)}
			</div>
		</section>
	);
}
