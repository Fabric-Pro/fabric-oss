"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { formatDistanceToNow } from "date-fns";
import {
	CheckCircle2Icon,
	CircleSlashIcon,
	FlaskConicalIcon,
	Loader2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	HISTORY_DIALOG_PAGE,
	HISTORY_PANEL_PREVIEW,
	HistoryMoreDialog,
} from "../../test-cases/HistoryMoreDialog";

// ---------------------------------------------------------------------------
// QA tab history — two timelines for one feature:
//   • drafting runs (every "Draft test cases with AI" run over this feature)
//   • QA analysis versions (every "Generate QA analysis" snapshot)
// Read-only; both are bounded lists, newest first.
// ---------------------------------------------------------------------------

type DraftRunStatus =
	| "PENDING"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELLED";

interface DraftRun {
	id: string;
	status: DraftRunStatus;
	createdCount: number;
	error: string | null;
	requestedByName: string | null;
	createdAt: string;
}

interface AnalysisVersion {
	id: string;
	depth: string;
	generatedByName: string | null;
	generatedAt: string;
}

function relative(iso: string): { label: string; title: string } | null {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) {
		return null;
	}
	return {
		label: formatDistanceToNow(when, { addSuffix: true }),
		title: when.toLocaleString(),
	};
}

export function QaHistorySection({
	projectId,
	storyId,
	organizationId,
}: {
	projectId: string;
	storyId: string;
	organizationId: string | null;
}) {
	const t = useTranslations("projects.stories.maturation.qa");
	const [runsOpen, setRunsOpen] = useState(false);
	const [versionsOpen, setVersionsOpen] = useState(false);

	// Each panel list shows only the newest few; "View all" opens the paged
	// dialog, which is the only place a long history is loaded.
	const runsQuery = useQuery(
		orpc.projects.testCases.draftJobs.forFeature.queryOptions({
			input: {
				projectId,
				storyId,
				organizationId,
				limit: HISTORY_PANEL_PREVIEW,
			},
		}),
	);
	const versionsQuery = useQuery(
		orpc.projects.stories.maturation.qaAnalysisVersions.queryOptions({
			input: {
				projectId,
				storyId,
				organizationId,
				limit: HISTORY_PANEL_PREVIEW,
			},
		}),
	);

	const runs = (runsQuery.data?.runs ?? []) as DraftRun[];
	const versions = (versionsQuery.data?.versions ?? []) as AnalysisVersion[];
	const runsTotal = runsQuery.data?.total ?? 0;
	const versionsTotal = versionsQuery.data?.total ?? 0;

	const allRunsQuery = useInfiniteQuery({
		...orpc.projects.testCases.draftJobs.forFeature.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				storyId,
				organizationId,
				limit: HISTORY_DIALOG_PAGE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.runs.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		enabled: runsOpen,
	});
	const allRuns = (allRunsQuery.data?.pages ?? []).flatMap(
		(page) => page.runs,
	) as DraftRun[];

	const allVersionsQuery = useInfiniteQuery({
		...orpc.projects.stories.maturation.qaAnalysisVersions.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				storyId,
				organizationId,
				limit: HISTORY_DIALOG_PAGE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.versions.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
		enabled: versionsOpen,
	});
	const allVersions = (allVersionsQuery.data?.pages ?? []).flatMap(
		(page) => page.versions,
	) as AnalysisVersion[];

	// Nothing has happened yet on either timeline — say so once, plainly, rather
	// than showing two empty boxes. A FAILED fetch must NOT collapse into this
	// (data is undefined → length 0): it falls through to the grid so each
	// list's own error state renders instead of "nothing recorded yet".
	const bothEmpty =
		!runsQuery.isLoading &&
		!versionsQuery.isLoading &&
		!runsQuery.isError &&
		!versionsQuery.isError &&
		runs.length === 0 &&
		versions.length === 0;

	return (
		<section aria-labelledby="qa-history-heading" className="space-y-4">
			<div className="flex items-center gap-2">
				<h2
					id="qa-history-heading"
					className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
				>
					{t("history.heading")}
				</h2>
			</div>

			{bothEmpty ? (
				<p className="rounded-lg border border-dashed bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					{t("history.empty")}
				</p>
			) : (
				<div className="grid gap-4 sm:grid-cols-2">
					{/* Drafting runs */}
					<div className="space-y-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
								{t("history.draftRunsHeading")}
							</p>
							{runsTotal > runs.length && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setRunsOpen(true)}
									className="h-auto py-0.5 text-muted-foreground text-xs hover:text-foreground"
								>
									{t("history.viewAll", { total: runsTotal })}
								</Button>
							)}
						</div>
						{runsQuery.isLoading ? (
							<HistoryLoading />
						) : runsQuery.isError ? (
							<HistoryError label={t("history.loadFailed")} />
						) : runs.length === 0 ? (
							<HistoryEmpty label={t("history.noDraftRuns")} />
						) : (
							<ul className="space-y-1.5">
								{runs.map((run) => (
									<DraftRunRow key={run.id} run={run} />
								))}
							</ul>
						)}
					</div>

					{/* Analysis versions */}
					<div className="space-y-2">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.14em]">
								{t("history.analysisHeading")}
							</p>
							{versionsTotal > versions.length && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setVersionsOpen(true)}
									className="h-auto py-0.5 text-muted-foreground text-xs hover:text-foreground"
								>
									{t("history.viewAll", {
										total: versionsTotal,
									})}
								</Button>
							)}
						</div>
						{versionsQuery.isLoading ? (
							<HistoryLoading />
						) : versionsQuery.isError ? (
							<HistoryError label={t("history.loadFailed")} />
						) : versions.length === 0 ? (
							<HistoryEmpty label={t("history.noAnalysis")} />
						) : (
							<ul className="space-y-1.5">
								{versions.map((version) => (
									<AnalysisVersionRow
										key={version.id}
										version={version}
									/>
								))}
							</ul>
						)}
					</div>
				</div>
			)}

			<HistoryMoreDialog
				open={runsOpen}
				onOpenChange={setRunsOpen}
				title={t("history.draftRunsHeading")}
				description={t("history.draftRunsDialogDescription")}
				total={allRunsQuery.data?.pages[0]?.total ?? runsTotal}
				shown={allRuns.length}
				hasMore={allRunsQuery.hasNextPage === true}
				onShowMore={() => allRunsQuery.fetchNextPage()}
				isLoading={allRunsQuery.isLoading}
				isLoadingMore={allRunsQuery.isFetchingNextPage}
				isError={allRunsQuery.isError}
			>
				{allRuns.map((run) => (
					<DraftRunRow key={run.id} run={run} />
				))}
			</HistoryMoreDialog>

			<HistoryMoreDialog
				open={versionsOpen}
				onOpenChange={setVersionsOpen}
				title={t("history.analysisHeading")}
				description={t("history.analysisDialogDescription")}
				total={allVersionsQuery.data?.pages[0]?.total ?? versionsTotal}
				shown={allVersions.length}
				hasMore={allVersionsQuery.hasNextPage === true}
				onShowMore={() => allVersionsQuery.fetchNextPage()}
				isLoading={allVersionsQuery.isLoading}
				isLoadingMore={allVersionsQuery.isFetchingNextPage}
				isError={allVersionsQuery.isError}
			>
				{allVersions.map((version) => (
					<AnalysisVersionRow key={version.id} version={version} />
				))}
			</HistoryMoreDialog>
		</section>
	);
}

function DraftRunRow({ run }: { run: DraftRun }) {
	const t = useTranslations("projects.stories.maturation.qa");
	const when = relative(run.createdAt);
	return (
		<li className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<DraftRunStatusBadge status={run.status} />
				{run.status === "SUCCEEDED" && (
					<span className="text-foreground text-sm">
						{t("history.casesCreated", { count: run.createdCount })}
					</span>
				)}
				{when && (
					<time
						dateTime={run.createdAt}
						title={when.title}
						className="text-muted-foreground text-xs"
					>
						{when.label}
					</time>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
				{run.requestedByName && (
					<span>
						{t("history.by", { name: run.requestedByName })}
					</span>
				)}
				{run.status === "FAILED" && run.error && (
					<span className="min-w-0 break-words text-destructive">
						{run.error}
					</span>
				)}
			</div>
		</li>
	);
}

function DraftRunStatusBadge({ status }: { status: DraftRunStatus }) {
	const t = useTranslations("projects.stories.maturation.qa");
	// Icon carries the accent, label stays text-foreground so it always clears
	// WCAG AA contrast in both themes (the pattern constants.ts documents and the
	// shared chips follow — a fully-tinted 12px word fails AA on the white card).
	if (status === "SUCCEEDED") {
		return (
			<span className="inline-flex items-center gap-1 text-foreground text-xs">
				<CheckCircle2Icon
					className="size-3.5 text-secondary"
					aria-hidden="true"
				/>
				{t("history.status.succeeded")}
			</span>
		);
	}
	if (status === "FAILED") {
		return (
			<span className="inline-flex items-center gap-1 text-foreground text-xs">
				<TriangleAlertIcon
					className="size-3.5 text-destructive"
					aria-hidden="true"
				/>
				{t("history.status.failed")}
			</span>
		);
	}
	if (status === "CANCELLED") {
		return (
			<span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
				<CircleSlashIcon className="size-3.5" aria-hidden="true" />
				{t("history.status.cancelled")}
			</span>
		);
	}
	// PENDING / RUNNING
	return (
		<span className="inline-flex items-center gap-1 text-foreground text-xs">
			<Loader2Icon
				className="size-3.5 text-highlight motion-safe:animate-spin"
				aria-hidden="true"
			/>
			{t("history.status.running")}
		</span>
	);
}

function AnalysisVersionRow({ version }: { version: AnalysisVersion }) {
	const t = useTranslations("projects.stories.maturation.qa");
	const when = relative(version.generatedAt);
	return (
		<li className="flex flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<span className="inline-flex items-center gap-1 text-foreground text-sm">
					<FlaskConicalIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					{t("history.analysisGenerated")}
				</span>
				<Badge
					variant="outline"
					className="h-5 px-1.5 text-[10px] uppercase tracking-wide"
				>
					{version.depth}
				</Badge>
				{when && (
					<time
						dateTime={version.generatedAt}
						title={when.title}
						className="text-muted-foreground text-xs"
					>
						{when.label}
					</time>
				)}
			</div>
			{version.generatedByName && (
				<span className="text-muted-foreground text-xs">
					{t("history.by", { name: version.generatedByName })}
				</span>
			)}
		</li>
	);
}

function HistoryLoading() {
	return (
		<div className="flex items-center justify-center py-6 text-muted-foreground">
			<Loader2Icon
				className="size-4 motion-safe:animate-spin"
				aria-hidden="true"
			/>
		</div>
	);
}

function HistoryEmpty({ label }: { label: string }) {
	return (
		<p className="rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center text-muted-foreground text-xs">
			{label}
		</p>
	);
}

function HistoryError({ label }: { label: string }) {
	return (
		<p className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/30 px-3 py-4 text-center text-muted-foreground text-xs">
			<TriangleAlertIcon className="size-3.5" aria-hidden="true" />
			{label}
		</p>
	);
}
