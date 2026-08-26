"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	Loader2Icon,
	PlayIcon,
	RefreshCwIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
	HISTORY_DIALOG_PAGE,
	HISTORY_PANEL_PREVIEW,
	HistoryMoreDialog,
} from "../HistoryMoreDialog";
import { SectionHint } from "../SectionHint";
import { FindingsSection } from "./FindingsSection";
import { describeFreshness } from "./freshness";
import { PipelineRunDetailSheet } from "./PipelineRunDetailSheet";
import { PipelineRunRow } from "./PipelineRunRow";
import type { PipelineRun } from "./pipeline-run";
import { timeAgo } from "./pipeline-run";
import { RunFilters, type RunStatusFilter } from "./RunFilters";
import { SyncFailureBanner } from "./SyncFailureBanner";
import { TriggerRunDialog } from "./TriggerRunDialog";
import { UnmatchedTestsSection } from "./UnmatchedTestsSection";

/**
 * The QA pipeline-results surface: a "Sync now" trigger that
 * pulls new CI runs into Fabric, the last-synced / per-source failure indicator,
 * the most recent runs, the full paged run history, and the in-Fabric run detail.
 *
 * Rendered by both the feature-editor QA tab and the project QA tab —
 * one component so the two surfaces cannot drift apart.
 *
 * They differ in exactly one input: `storyId`. With it (the feature tab) the
 * runs, the history dialog and the failure list are narrowed to what actually
 * tested THAT feature, and the untracked-tests triage list — which is
 * project-level by definition — is omitted. Without it (the QA tab)
 * everything is project-wide, which is the right answer for a project-level
 * surface.
 */
export function PipelineRunsPanel({
	projectId,
	organizationId = null,
	className,
	onSelectCase,
	storyId,
}: {
	projectId: string;
	/** Needed to create a test case from an unmatched automated test. */
	organizationId?: string | null;
	className?: string;
	/** Optional: jump to a matched test case from the run detail. */
	onSelectCase?: (caseId: string) => void;
	/**
	 * When set, list only the runs that actually touched THIS feature. The
	 * project QA tab omits it and gets every run.
	 */
	storyId?: string;
}) {
	const t = useTranslations("projects.stories.maturation.qa.pipelineRuns");
	const queryClient = useQueryClient();

	const [historyOpen, setHistoryOpen] = useState(false);
	const [detailRunId, setDetailRunId] = useState<string | null>(null);
	const [runOpen, setRunOpen] = useState(false);

	// Poll briefly after a sync is triggered so freshly-ingested runs appear
	// without a manual refresh. The interval callback re-reads the deadline each
	// tick, so it self-stops (no lingering timer).
	const pollDeadlineRef = useRef(0);
	const polling = () => (Date.now() < pollDeadlineRef.current ? 3000 : false);

	// Filters are query INPUT, not a post-filter of the page: the list is capped
	// at HISTORY_PANEL_PREVIEW, so narrowing what came back would answer "which
	// of the newest N runs are GitHub's" instead of "the newest N GitHub runs".
	const [providerFilter, setProviderFilter] = useState<string[]>([]);
	const [statusFilter, setStatusFilter] = useState<RunStatusFilter[]>([]);

	const runsQuery = useQuery(
		orpc.projects.pipelineResults.listRuns.queryOptions({
			input: {
				projectId,
				limit: HISTORY_PANEL_PREVIEW,
				...(storyId ? { storyId } : {}),
				...(providerFilter.length ? { providers: providerFilter } : {}),
				...(statusFilter.length ? { statuses: statusFilter } : {}),
			},
			refetchInterval: polling,
		}),
	);
	const syncStatesQuery = useQuery(
		orpc.projects.pipelineResults.syncStates.queryOptions({
			input: { projectId },
			refetchInterval: polling,
		}),
	);
	// Why the list is empty, not just that it is. "Nothing connected" and "your
	// PM tool cannot return test runs" are different problems with different
	// fixes, and showing the same neutral box for both leaves a project that
	// HAS connected something with no way to learn it connected the wrong kind.
	// The sentence already existed and was rendered only on Settings ▸ Testing,
	// one navigation away from the tab where the emptiness is actually seen.
	//
	// Not polled: connecting a repository is a settings action, not something
	// that changes while this panel sits open.
	const sourcesQuery = useQuery(
		orpc.projects.pipelineResults.sources.queryOptions({
			input: { projectId },
		}),
	);
	const noSourcesReason =
		(sourcesQuery.data?.sources ?? []).length === 0
			? (sourcesQuery.data?.noSourcesReason ?? null)
			: null;
	// Which sources this project HAS, taken from the sync states rather than the
	// filtered run page — otherwise selecting one provider would remove every
	// other provider's own filter button, and there would be no way back.
	const availableProviders = [
		...new Set(syncStatesQuery.data?.map((s) => s.provider) ?? []),
	];

	// Full history — only fetched once the dialog is actually opened.
	const allQuery = useInfiniteQuery({
		...orpc.projects.pipelineResults.listRunsPage.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				limit: HISTORY_DIALOG_PAGE,
				offset,
				// Mirrors the preview above it. A scoped list that opens an
				// unscoped dialog is worse than no scoping at all: the empty
				// state says nothing tests this feature and the dialog it
				// opens immediately shows 400 runs.
				...(storyId ? { storyId } : {}),
				...(providerFilter.length ? { providers: providerFilter } : {}),
				...(statusFilter.length ? { statuses: statusFilter } : {}),
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
		enabled: historyOpen,
	});
	const allRuns = (allQuery.data?.pages ?? []).flatMap(
		(page) => page.runs,
	) as PipelineRun[];
	const historyTotal = allQuery.data?.pages?.[0]?.total ?? 0;

	const syncMutation = useMutation(
		orpc.projects.pipelineResults.sync.mutationOptions({
			onSuccess: () => {
				toast.success(t("syncStarted"));
				pollDeadlineRef.current = Date.now() + 30000;
				for (const key of [
					orpc.projects.pipelineResults.listRuns.key(),
					orpc.projects.pipelineResults.listRunsPage.key(),
					orpc.projects.pipelineResults.syncStates.key(),
					// Pre-existing omission, and a sharper one now that the
					// failure list sits directly under a scoped run list: a sync
					// that opens or resolves findings left the list below still
					// showing the previous sync's answer.
					orpc.projects.pipelineResults.findings.key(),
					orpc.projects.testCases.list.key(),
				]) {
					queryClient.invalidateQueries({ queryKey: key });
				}
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const runs = (runsQuery.data ?? []) as PipelineRun[];
	const syncStates = syncStatesQuery.data ?? [];
	// Most-recent successful fetch across sources — a true numeric max, not a
	// lexical sort, and tolerant of Date-vs-ISO over the wire.
	const latestFetchMs = syncStates.reduce((max, s) => {
		const ms = s.lastFetchedAt ? new Date(s.lastFetchedAt).getTime() : 0;
		return ms > max ? ms : max;
	}, 0);
	const lastFetchedAt = latestFetchMs > 0 ? new Date(latestFetchMs) : null;
	// A source that fails is real signal, but one broken source among several
	// must not report a sync that DID ingest runs as a total failure — partial
	// failure reads as a warning beside the last-synced time, not as an error.
	const failedSources = syncStates.filter((s) => s.status === "FAILED");
	const freshness = describeFreshness({
		failedSources,
		sourceCount: syncStates.length,
		lastFetchedAt,
	});

	return (
		<section
			aria-labelledby="qa-pipeline-runs"
			className={cn("space-y-3", className)}
		>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2
					id="qa-pipeline-runs"
					className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.2em]"
				>
					{t("title")}
				</h2>
				<SectionHint label={t("hintAria")} body={t("hint")} />
				{/* Wraps: "Trigger run" and "Sync now" side by side overran a
				    375px viewport by 23px, clipping the second button's edge with
				    no scrollbar to reach it. */}
				<div className="flex flex-wrap items-center justify-end gap-2">
					{/* Start a run in the customer's CI. Sits beside "Sync now"
					 * because they are the two halves of one loop: this pushes
					 * work out, that pulls the answer back. */}
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => setRunOpen(true)}
						className="gap-1.5"
					>
						<PlayIcon className="size-4" aria-hidden="true" />
						{t("run.trigger")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => syncMutation.mutate({ projectId })}
						disabled={syncMutation.isPending}
						className="gap-1.5"
					>
						{syncMutation.isPending ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<RefreshCwIcon
								className="size-4"
								aria-hidden="true"
							/>
						)}
						{t("sync")}
					</Button>
				</div>
			</div>

			{/* Last-synced / per-source failure indicator (FR7: stale data).
			 * The freshness time renders ALONGSIDE a failure, never instead of
			 * it — see `describeFreshness`. The failure itself is a banner now:
			 * it carries a classified explanation and the provider's raw body,
			 * which is more than a line of muted text can hold legibly. */}
			{freshness.failure && (
				<SyncFailureBanner
					failure={freshness.failure}
					projectId={projectId}
				/>
			)}

			<RunFilters
				availableProviders={availableProviders}
				providers={providerFilter}
				statuses={statusFilter}
				onProvidersChange={setProviderFilter}
				onStatusesChange={setStatusFilter}
			/>
			<p className="text-muted-foreground text-xs">
				{freshness.lastFetchedAt
					? t("lastSynced", {
							when: timeAgo(freshness.lastFetchedAt) ?? "",
						})
					: null}
				{freshness.neverSynced ? t("neverSynced") : null}
			</p>

			{runsQuery.isLoading ? (
				<div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
					<Loader2Icon
						className="size-4 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t("loading")}
				</div>
			) : runsQuery.isError ? (
				<p className="flex items-center gap-1.5 py-3 text-destructive text-sm">
					<TriangleAlertIcon
						className="size-3.5"
						aria-hidden="true"
					/>
					{t("loadError")}
				</p>
			) : runs.length === 0 ? (
				/* A distinct empty state, never an error — and when the project
				   has no source at all, why. */
				<div className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					<p>{storyId ? t("emptyForFeature") : t("empty")}</p>
					{noSourcesReason ? (
						<p className="mt-2 text-pretty">{noSourcesReason}</p>
					) : null}
				</div>
			) : (
				<>
					<ul className="divide-y divide-border rounded-md border border-border">
						{runs.map((run) => (
							<PipelineRunRow
								key={run.id}
								run={run}
								onOpenDetail={setDetailRunId}
							/>
						))}
					</ul>
					<div className="flex justify-end">
						<Button
							type="button"
							variant="link"
							size="sm"
							onClick={() => setHistoryOpen(true)}
							className="h-auto p-0 text-xs"
						>
							{t("viewAllRuns")}
						</Button>
					</div>
				</>
			)}

			<HistoryMoreDialog
				open={historyOpen}
				onOpenChange={setHistoryOpen}
				title={t("historyTitle")}
				// "Every run in this project" is simply untrue once the dialog
				// is feature-scoped, and the dialog is the one place a user
				// would go to check whether the list above was hiding
				// something.
				description={t(
					storyId
						? "historyDescriptionForFeature"
						: "historyDescription",
				)}
				total={historyTotal}
				shown={allRuns.length}
				hasMore={allQuery.hasNextPage === true}
				onShowMore={() => allQuery.fetchNextPage()}
				isLoading={allQuery.isLoading}
				isLoadingMore={allQuery.isFetchingNextPage}
				isError={allQuery.isError}
			>
				{allRuns.map((run) => (
					<PipelineRunRow
						key={run.id}
						run={run}
						onOpenDetail={(id) => {
							setHistoryOpen(false);
							setDetailRunId(id);
						}}
						className="rounded-md border border-border"
					/>
				))}
			</HistoryMoreDialog>

			<TriggerRunDialog
				projectId={projectId}
				open={runOpen}
				onOpenChange={setRunOpen}
				// A queued run takes minutes to finish, so this only re-checks for
				// runs the provider has already registered; the full result still
				// arrives on a later sync.
				onTriggered={() => {
					pollDeadlineRef.current = Date.now() + 30000;
				}}
			/>

			{/* What keeps breaking, as opposed to what happened last night. */}
			<FindingsSection projectId={projectId} storyId={storyId} />

			{/* Untracked tests are project-level by definition: a test Fabric
			 * tracks no case for has no feature to belong to. There is nothing to
			 * scope, so on a feature tab it is omitted rather than shown
			 * project-wide — a project's untriaged tests listed under one
			 * feature's results reads as that feature's problem. */}
			{!storyId && (
				<UnmatchedTestsSection
					projectId={projectId}
					organizationId={organizationId}
				/>
			)}

			<PipelineRunDetailSheet
				projectId={projectId}
				runId={detailRunId}
				open={detailRunId !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDetailRunId(null);
					}
				}}
				onSelectCase={onSelectCase}
			/>
		</section>
	);
}
