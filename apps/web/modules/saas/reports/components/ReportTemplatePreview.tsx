"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { formatDistanceToNow } from "date-fns";
import {
	EyeIcon,
	Loader2Icon,
	RotateCcwIcon,
	SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import { ReportArtifactContent } from "./ReportArtifactContent";

const SAMPLE_ARTIFACT_NAME = "sample-report.md";

/**
 * What a template produces, shown before a report is set up: the newest
 * successful report made from it in this project, or — on request, for
 * someone who may add reports to the project — an AI-written sample labelled
 * as sample data. A sample is written once per template per session and kept
 * in the query cache, so reopening the template does not spend on it again.
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
	const [sampleRequested, setSampleRequested] = useState(false);
	const input = { templateId, projectId, organizationId };
	const preview = useQuery(
		orpc.reports.templates.preview.queryOptions({ input }),
	);
	// The sample asks the same question the API does: may this caller add
	// reports to the project.
	const { data: capabilities } = useQuery(
		orpc.reports.capabilities.queryOptions({ input: { projectId } }),
	);
	const canGenerateSample = capabilities?.canEditProjectReports === true;
	const run = preview.data?.run ?? null;
	const sample = useQuery({
		...orpc.reports.templates.sample.queryOptions({ input }),
		enabled: canGenerateSample && sampleRequested && !run,
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
					<div className="max-h-80 overflow-auto rounded-md border bg-background">
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
						Written by AI from the template to show its layout. The
						data is invented, not read from this project.
					</p>
					<div className="max-h-80 overflow-auto rounded-md border border-dashed bg-background">
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
					{canGenerateSample && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={sample.isFetching}
							onClick={() =>
								sampleRequested
									? void sample.refetch()
									: setSampleRequested(true)
							}
						>
							{sample.isFetching ? (
								<Loader2Icon className="mr-2 h-4 w-4 motion-safe:animate-spin" />
							) : (
								<SparklesIcon className="mr-2 h-4 w-4" />
							)}
							{sample.isFetching
								? "Writing a sample..."
								: "Show a sample with example data"}
						</Button>
					)}
					{sample.error && (
						<p role="alert" className="text-xs text-destructive">
							{sample.error.message}
						</p>
					)}
				</div>
			)}
		</section>
	);
}
