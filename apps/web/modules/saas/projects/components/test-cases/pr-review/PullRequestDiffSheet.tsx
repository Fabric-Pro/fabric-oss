"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import { ExternalLinkIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { PrReviewFindings } from "./PrReviewFindings";

/**
 * What Fabric read from one pull request.
 *
 * Shows the raw unified diff rather than a rendered side-by-side view. That is
 * the point of the phase: the reader is checking what Fabric *had* to work
 * with, and a prettier rendering would be a second representation to trust.
 * When the review lenses land, their findings hang beside this — against the
 * same text a person can read here.
 */
export function PullRequestDiffSheet({
	projectId,
	reviewId,
	canEdit,
	onClose,
}: {
	projectId: string;
	/** Null closes the sheet; the query is disabled until an id exists. */
	reviewId: string | null;
	/** Gates the review + judge controls; the server enforces it regardless. */
	canEdit: boolean;
	onClose: () => void;
}) {
	const t = useTranslations("projects.testCases.prReview");

	const { data, isLoading, isError } = useQuery({
		...orpc.projects.pullRequestReviews.get.queryOptions({
			input: { projectId, id: reviewId ?? "" },
		}),
		enabled: reviewId != null,
	});

	return (
		<Sheet
			open={reviewId != null}
			onOpenChange={(open) => !open && onClose()}
		>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
			>
				<SheetHeader className="space-y-2 border-b px-5 py-4 text-left">
					<SheetTitle className="truncate text-base">
						{data ? data.title : t("diff.loadingTitle")}
					</SheetTitle>
					{data ? (
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
							<span>
								{data.repoOwner}/{data.repoName} #
								{data.prNumber}
							</span>
							<span aria-hidden="true">·</span>
							<span>
								{t("changedFiles", {
									count: data.changedFiles,
								})}
							</span>
							<span aria-hidden="true">·</span>
							{/* Short SHA for reading, full SHA for copying and for
							    anyone reconciling this against the forge. */}
							<span className="font-mono" title={data.headSha}>
								{data.headSha.slice(0, 7)}
							</span>
							{data.prUrl ? (
								<a
									href={data.prUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-primary hover:underline"
								>
									{t("openOnProvider")}
									<ExternalLinkIcon
										className="size-3"
										aria-hidden="true"
									/>
								</a>
							) : null}
						</div>
					) : null}
				</SheetHeader>

				<div className="min-h-0 flex-1 overflow-auto">
					{data ? (
						<PrReviewFindings
							projectId={projectId}
							reviewId={data.id}
							findings={data.findings}
							analysedAt={data.qaAnalysedAt}
							analysisModel={data.qaAnalysisModel}
							architectureAnalysedAt={data.architectureAnalysedAt}
							hasDiff={data.diff != null}
							canEdit={canEdit}
						/>
					) : null}
					{isLoading ? (
						<div className="flex items-center gap-2 p-5 text-muted-foreground text-sm">
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							{t("diff.loading")}
						</div>
					) : isError || !data ? (
						<p className="p-5 text-muted-foreground text-sm">
							{t("diff.unavailable")}
						</p>
					) : (
						<>
							{data.diffTruncated ? (
								<p className="flex items-start gap-2 border-highlight/40 border-b bg-highlight/10 px-5 py-3 text-xs">
									<TriangleAlertIcon
										className="mt-px size-4 shrink-0 text-highlight"
										aria-hidden="true"
									/>
									{t("diff.truncated")}
								</p>
							) : null}
							{data.diff ? (
								<pre className="overflow-x-auto p-5 font-mono text-xs leading-relaxed">
									{data.diff.split("\n").map((line, i) => (
										<div
											// The diff is immutable once stored, so line index is a
											// stable key here.
											key={`${i}-${line.slice(0, 24)}`}
											className={cn(
												"whitespace-pre",
												line.startsWith("+") &&
													!line.startsWith("+++")
													? "text-secondary"
													: line.startsWith("-") &&
															!line.startsWith(
																"---",
															)
														? "text-destructive"
														: line.startsWith("@@")
															? "text-muted-foreground"
															: undefined,
											)}
										>
											{line || " "}
										</div>
									))}
								</pre>
							) : (
								<p className="p-5 text-muted-foreground text-sm">
									{data.failureText ?? t("diff.empty")}
								</p>
							)}
						</>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
