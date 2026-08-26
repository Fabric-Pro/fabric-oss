"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { formatDistanceToNow } from "date-fns";
import { GitPullRequestIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PullRequestDiffSheet } from "./PullRequestDiffSheet";

/**
 * Pull requests Fabric has read (the pull-request review work, phase 1).
 *
 * Ingest and inspection only — no findings yet, and the panel says so rather
 * than implying an analysis that has not been built. Shipping the read on its
 * own is deliberate: the QA and architecture lenses are only worth trusting if
 * the diff underneath them can be checked, and this is where a person checks it.
 */
export function PullRequestReviewsPanel({
	projectId,
	canEdit,
}: {
	projectId: string;
	/** Reading a PR spends an API call against the project's own repository
	 * credential, so it follows the tab's edit permission. The server enforces
	 * this too; hiding the control keeps a read-only member from meeting a 403. */
	canEdit: boolean;
}) {
	const t = useTranslations("projects.testCases.prReview");
	const queryClient = useQueryClient();

	const [openReviewId, setOpenReviewId] = useState<string | null>(null);
	const [integrationId, setIntegrationId] = useState<string>("");
	const [prNumber, setPrNumber] = useState<string>("");

	// The connected repos, from the same credential-free list the QA branch
	// picker uses — one source of truth for "which repos does this project have".
	const { data: sources } = useQuery(
		orpc.projects.pipelineResults.sources.queryOptions({
			input: { projectId },
		}),
	);
	// How often each lens has been dismissed here. Rendered only once there is
	// enough of it to mean anything — see `LensAccuracy`.
	const { data: lensStats } = useQuery(
		orpc.projects.pullRequestReviews.lensStats.queryOptions({
			input: { projectId },
		}),
	);

	// No filter: `providerFor` on the server resolves every member of the
	// repository provider enum — GitHub, GitLab, Azure DevOps — so there is no
	// connected repository the read would refuse. A provider allow-list here is
	// what left the other two hosts unofferable after the server learned to read
	// them, so the absence is deliberate rather than an oversight.
	const repositories = sources?.sources ?? [];

	// Preselect when there is exactly one candidate — a picker with one option is
	// a decision nobody has to make.
	useEffect(() => {
		if (!integrationId && repositories.length === 1) {
			setIntegrationId(repositories[0].integrationId);
		}
	}, [integrationId, repositories]);

	const { data, isLoading } = useQuery(
		orpc.projects.pullRequestReviews.list.queryOptions({
			input: { projectId },
		}),
	);

	const readPr = useMutation({
		...orpc.projects.pullRequestReviews.read.mutationOptions(),
		onSuccess: (review) => {
			toast.success(t("readSuccess", { number: review.prNumber }));
			setPrNumber("");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.pullRequestReviews.list.queryKey({
					input: { projectId },
				}),
			});
			setOpenReviewId(review.id);
		},
		// The server's message names the actual refusal — a missing credential, a
		// PR that does not exist, an unsupported provider — so it is shown as-is
		// rather than replaced with a generic failure.
		onError: (error) => toast.error(error.message),
	});

	const parsedNumber = Number.parseInt(prNumber, 10);
	const canSubmit =
		canEdit &&
		integrationId !== "" &&
		Number.isInteger(parsedNumber) &&
		parsedNumber > 0 &&
		!readPr.isPending;

	return (
		<div className="space-y-4">
			<p className="text-muted-foreground text-sm">{t("intro")}</p>

			<LensAccuracy
				lenses={lensStats?.lenses ?? []}
				target={lensStats?.target ?? 0.2}
				label={(lens, falsePositives, judged, percent) =>
					t("accuracy", { lens, falsePositives, judged, percent })
				}
				targetLabel={(percent) => t("accuracyTarget", { percent })}
				unclassifiedLabel={(count) =>
					t("accuracyUnclassified", { count })
				}
				lensName={(lens) => t(`lens.${lens.toLowerCase()}` as never)}
			/>

			{canEdit ? (
				repositories.length === 0 ? (
					<p className="rounded-lg border border-border/60 bg-muted/40 p-4 text-muted-foreground text-sm">
						{t("noRepositories")}
					</p>
				) : (
					<form
						className="flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-muted/40 p-4"
						onSubmit={(e) => {
							e.preventDefault();
							if (!canSubmit) {
								return;
							}
							readPr.mutate({
								projectId,
								repositoryIntegrationId: integrationId,
								prNumber: parsedNumber,
							});
						}}
					>
						<div className="space-y-1.5">
							<Label htmlFor="pr-review-repo">
								{t("repositoryLabel")}
							</Label>
							<Select
								value={integrationId}
								onValueChange={setIntegrationId}
							>
								<SelectTrigger
									id="pr-review-repo"
									className="w-64"
								>
									<SelectValue
										placeholder={t("repositoryPlaceholder")}
									/>
								</SelectTrigger>
								<SelectContent>
									{repositories.map((s) => (
										<SelectItem
											key={s.integrationId}
											value={s.integrationId}
										>
											{s.owner}/{s.repo}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="pr-review-number">
								{t("numberLabel")}
							</Label>
							<Input
								id="pr-review-number"
								className="w-32"
								inputMode="numeric"
								placeholder="123"
								value={prNumber}
								onChange={(e) =>
									setPrNumber(
										e.target.value.replace(/[^0-9]/g, ""),
									)
								}
							/>
						</div>
						<Button type="submit" disabled={!canSubmit}>
							{readPr.isPending ? (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : null}
							{t("readAction")}
						</Button>
					</form>
				)
			) : null}

			{isLoading ? (
				<p className="text-muted-foreground text-sm">{t("loading")}</p>
			) : (data?.reviews.length ?? 0) === 0 ? (
				<div className="rounded-lg border border-border/60 border-dashed p-8 text-center">
					<GitPullRequestIcon
						className="mx-auto size-6 text-muted-foreground"
						aria-hidden="true"
					/>
					<p className="mt-3 font-medium text-sm">
						{t("empty.title")}
					</p>
					<p className="mt-1 text-muted-foreground text-sm">
						{t("empty.body")}
					</p>
				</div>
			) : (
				<ul className="divide-y divide-border/60 rounded-lg border border-border/60">
					{data?.reviews.map((review) => (
						<li key={review.id}>
							<button
								type="button"
								onClick={() => setOpenReviewId(review.id)}
								className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent"
							>
								<GitPullRequestIcon
									className="size-4 shrink-0 text-muted-foreground"
									aria-hidden="true"
								/>
								<span className="min-w-0 flex-1">
									<span className="block truncate font-medium text-sm">
										{review.title}
									</span>
									<span className="mt-0.5 block truncate text-muted-foreground text-xs">
										{review.repoOwner}/{review.repoName} #
										{review.prNumber}
										{review.authorLabel
											? ` · ${review.authorLabel}`
											: ""}{" "}
										·{" "}
										{t("changedFiles", {
											count: review.changedFiles,
										})}{" "}
										·{" "}
										{formatDistanceToNow(
											new Date(review.createdAt),
											{
												addSuffix: true,
											},
										)}
									</span>
								</span>
								{/* Tones follow the findings list on the same tab: destructive
								    only for "Fabric could not read this", amber for "it read
								    part of it". */}
								{review.status === "FAILED" ? (
									<span className="shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-medium text-destructive text-xs">
										{t("status.failed")}
									</span>
								) : review.diffTruncated ? (
									<span className="shrink-0 rounded-full border border-highlight/40 bg-highlight/10 px-2 py-0.5 font-medium text-highlight text-xs">
										{t("status.truncated")}
									</span>
								) : null}
							</button>
						</li>
					))}
				</ul>
			)}

			<PullRequestDiffSheet
				projectId={projectId}
				reviewId={openReviewId}
				canEdit={canEdit}
				onClose={() => setOpenReviewId(null)}
			/>
		</div>
	);
}

/** Enough judgements for a percentage to be worth printing. */
const MIN_JUDGED_FOR_RATE = 5;

/**
 * How accurate each lens has been here.
 *
 * The figure is the FALSE-POSITIVE rate — findings dismissed as "not correct"
 * over findings judged — because that is what the feature's success criterion
 * names. It used to be the dismissal rate, printed under the same name, and
 * those differ: three of the four dismissal reasons record that a CORRECT
 * finding was not acted on.
 *
 * Held back until a lens has been judged {@link MIN_JUDGED_FOR_RATE} times. One
 * dismissal out of two is not a 50% false-positive rate, it is two data points,
 * and printing it as a percentage invites a decision the evidence cannot carry.
 * Both counts are shown beside it for the same reason.
 */
export function LensAccuracy({
	lenses,
	label,
	target,
	targetLabel,
	unclassifiedLabel,
	lensName,
}: {
	lenses: Array<{
		lens: string;
		judged: number;
		dismissed: number;
		falsePositives: number;
		falsePositiveRate: number | null;
		meetsTarget: boolean | null;
		unclassifiedDismissals: number;
	}>;
	label: (
		lens: string,
		falsePositives: number,
		judged: number,
		percent: number,
	) => string;
	/** The threshold, as a fraction, from the server. Never a second copy here. */
	target: number;
	targetLabel: (percent: number) => string;
	unclassifiedLabel: (count: number) => string;
	lensName: (lens: string) => string;
}) {
	const ready = lenses.filter(
		(l) => l.falsePositiveRate !== null && l.judged >= MIN_JUDGED_FOR_RATE,
	);
	if (ready.length === 0) {
		return null;
	}

	return (
		<ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
			{ready.map((l) => (
				<li key={l.lens}>
					{label(
						lensName(l.lens),
						l.falsePositives,
						l.judged,
						Math.round((l.falsePositiveRate ?? 0) * 100),
					)}{" "}
					<span
						className={
							l.meetsTarget
								? "text-secondary"
								: "text-destructive"
						}
					>
						{targetLabel(Math.round(target * 100))}
					</span>
					{/* Judgements with no reason recorded cannot count towards
					    the rate, so a reader is told how much of the denominator
					    is unclassified rather than shown a rate that silently
					    understates it. */}
					{l.unclassifiedDismissals > 0 ? (
						<span className="ml-1">
							{unclassifiedLabel(l.unclassifiedDismissals)}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}
