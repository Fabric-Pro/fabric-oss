"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	DownloadIcon,
	FlaskConicalIcon,
	InfoIcon,
	Loader2Icon,
	PlayIcon,
	SparklesIcon,
	TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	buildTraceabilityMatrix,
	criterionIndexFromRef,
	parseAcceptanceCriteria,
	traceabilityMatrixToMarkdown,
} from "../../../lib/stories/qa-traceability";
import { computeTestingVerdict } from "../../../lib/stories/testing-verdict";
import {
	RESULT_I18N_KEY,
	STATE_I18N_KEY,
	type TestCaseState,
	type TestResult,
} from "../../test-cases/constants";
import { isDraftJobActive } from "../../test-cases/draft-jobs";
import { RunConfigurationDialog } from "../../test-cases/pipeline/RunConfigurationDialog";
import { TestCaseDraftJobWatcher } from "../../test-cases/TestCaseDraftJobWatcher";
import { TestCaseStatusChip } from "../../test-cases/TestCaseStatusChip";
import { CoverageMatrixTable } from "./CoverageMatrixTable";
import { CoverageSummary } from "./CoverageSummary";
import { DriftedCasesSection } from "./DriftedCasesSection";
import { FeatureRunProgress } from "./FeatureRunProgress";
import { PipelineRunsSection } from "./PipelineRunsSection";
import { QaHistorySection } from "./QaHistorySection";
import { QaSignOffSection } from "./QaSignOffSection";
import { ReviseFromImplementationButton } from "./ReviseFromImplementationButton";
import { TestingVerdictCard } from "./TestingVerdictCard";
import type { QaAnalysisView } from "./types";

type Props = {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	/**
	 * The editor-state query is still in flight — every prop below is a
	 * placeholder. Renders a spinner instead of asserting "no acceptance
	 * criteria" about a feature that merely hasn't loaded yet.
	 */
	loading?: boolean;
	/** The Clean Spec's acceptance-criteria markdown blob (matrix source). */
	acceptanceCriteria: string | null;
	qaAnalysis: QaAnalysisView | null;
	/** The Clean Spec changed since the analysis was generated. */
	qaAnalysisStale: boolean;
	qaStrategyLevel: "LIGHT" | "STANDARD" | "STRICT";
	/**
	 * Project-level "Generate manual test cases" switch.
	 * When off, drafting is disabled here and the server rejects any run, so no
	 * credits are spent.
	 */
	generateManualTestCases: boolean;
	/**
	 * Project-level "Apply TDD approach" switch. When on,
	 * the panel presents the TDD ordering — draft and review cases before
	 * implementation — instead of the default (draft after review).
	 */
	applyTddApproach: boolean;
	/**
	 * The signed-in user, for the QA sign-off panel — it has to tell YOUR
	 * approval from everyone else's to offer withdraw rather than a duplicate.
	 *
	 * A prop, not `useSession()`. This component is rendered bare in its own
	 * tests, and that hook throws outside a SessionProvider; taking it as a
	 * prop keeps the panel pure and its tests provider-free. Absent simply
	 * hides the sign-off panel.
	 */
	currentUserId?: string | null;
};

/** Page size for the offset-paginated cases fetch (procedure caps `limit` at 200). */
const CASES_PAGE_SIZE = 100;

/** The editorial section header shared with the sibling maturation panels. */
/** One under-specification warning, with whether the drafted cases exposed it. */
type QaWarningEntry = { text: string; fromDraftedCases: boolean };

/**
 * Marks a warning that writing the test cases exposed.
 *
 * This is the visible half of the test-first ordering's claim: drafting the
 * cases first surfaces specification problems while they are still cheap to
 * fix. Before this the claim was a `Drafting revealed:` prefix the model was
 * asked to write, rendered identically to every other warning — so nobody could
 * tell whether test-first had earned anything.
 */
function DraftingRevealedChip() {
	const t = useTranslations("projects.stories.maturation.qa");
	return (
		<span className="ml-2 inline-flex items-center rounded-full border border-secondary/40 bg-secondary/10 px-2 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wider text-secondary-foreground">
			{t("draftingRevealed")}
		</span>
	);
}

function SectionHeading({ id, children }: { id: string; children: string }) {
	return (
		<h2
			id={id}
			className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
		>
			{children}
		</h2>
	);
}

/**
 * The (i) affordance next to a section heading — same recipe as
 * ContextSummaryPanel's info trigger. The hint paragraphs stay for scanning;
 * this carries the fuller "how does this actually work" explanation.
 */
function SectionInfo({ aria, body }: { aria: string; body: string }) {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={aria}
						className="inline-flex text-muted-foreground/70 motion-safe:transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<InfoIcon className="size-3.5" aria-hidden="true" />
					</button>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs text-xs leading-relaxed">
					{body}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

/**
 * QA tab — test planning inside the maturation editor.
 *
 * Composes over the shipped QA feature rather than duplicating it: the
 * cases listed here are real `TestCase` rows (drafted through the same durable
 * `testCases.aiDraft` pipeline the QA tab uses, watched by the same
 * `TestCaseDraftJobWatcher`), and every case chip deep-links into that tab.
 * What is native to this panel is the analysis — under-specification warnings,
 * integration implications, E2E outlines — persisted on the story
 * (`qaAnalysis`) and regenerated from an explicit button only.
 */
export function QaPanel({
	projectId,
	storyId,
	organizationId,
	loading = false,
	acceptanceCriteria,
	qaAnalysis,
	qaAnalysisStale,
	qaStrategyLevel,
	generateManualTestCases,
	applyTddApproach,
	currentUserId = null,
}: Props) {
	const t = useTranslations("projects.stories.maturation.qa");
	const tTestCases = useTranslations("projects.testCases");
	const pathname = usePathname();
	const queryClient = useQueryClient();

	// `.../projects/{id}/stories/{storyId}` → `.../projects/{id}` so each case
	// deep-links to the QA tab (same recipe as StoryTestCoverageLine).
	const projectBase = pathname.replace(/\/stories\/[^/]+.*$/, "");

	const criteria = useMemo(
		() => parseAcceptanceCriteria(acceptanceCriteria),
		[acceptanceCriteria],
	);

	// Offset-paginated exactly like TestCasesList: the matrix and the list read
	// the same flattened pages, so "Load more" completes BOTH in lock-step —
	// coverage beyond the fetched window is reachable, not silently cut off.
	const casesQuery = useInfiniteQuery(
		orpc.projects.testCases.list.infiniteOptions({
			input: (offset: number) => ({
				projectId,
				organizationId,
				linkedStoryId: storyId,
				limit: CASES_PAGE_SIZE,
				offset,
			}),
			initialPageParam: 0,
			getNextPageParam: (lastPage, allPages) => {
				const loaded = allPages.reduce(
					(sum, page) => sum + page.items.length,
					0,
				);
				return loaded < lastPage.total ? loaded : undefined;
			},
		}),
	);
	const casesLoading = casesQuery.isLoading;
	const casesError = casesQuery.isError;

	// Shares its cache with the watcher's poll, so "a run is in flight" is one
	// source of truth between the toast and the disabled button.
	const draftJobsInput = { projectId, organizationId, limit: 5 };
	const { data: jobsData } = useQuery(
		orpc.projects.testCases.draftJobs.list.queryOptions({
			input: draftJobsInput,
		}),
	);
	const draftActive =
		jobsData?.jobs.some((job) => isDraftJobActive(job.status)) ?? false;

	const draftMutation = useMutation(
		orpc.projects.testCases.aiDraft.mutationOptions({
			onSuccess: (job) => {
				// Seed the shared jobs cache with the just-started run BEFORE the
				// refetch lands, so `draftActive` flips true synchronously — without
				// this the button re-enables for the invalidate→refetch window and a
				// second click starts (and bills) a duplicate drafting run.
				queryClient.setQueryData(
					orpc.projects.testCases.draftJobs.list.queryKey({
						input: draftJobsInput,
					}),
					(old) => ({
						jobs: [
							{
								id: job.jobId,
								status: job.status,
								totalFeatures: job.totalFeatures,
								processedFeatures: 0,
								createdCount: 0,
								error: null,
								startedAt: new Date(),
								completedAt: null,
								outcomes: [],
							},
							...(old?.jobs ?? []),
						],
					}),
				);
				// Hand off to the watcher: it polls the job row and toasts
				// progress/completion, exactly as on the QA tab.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.draftJobs.list.key(),
				});
			},
			onError: (e) =>
				toast.error(
					tTestCases("toasts.draftFailed", { error: e.message }),
				),
		}),
	);

	const editorStateKey =
		orpc.projects.stories.maturation.getEditorState.queryKey({
			input: { projectId, storyId, organizationId },
		});
	const analysisMutation = useMutation(
		orpc.projects.stories.maturation.generateQaAnalysis.mutationOptions({
			onSuccess: (result) => {
				// Write-through instead of invalidate: the payload is the full new
				// state, and a refetch would re-render every maturation surface.
				queryClient.setQueryData(editorStateKey, (old) =>
					old
						? {
								...old,
								qaAnalysis: result.qaAnalysis,
								qaAnalysisStale: false,
							}
						: old,
				);
				// The generation just appended a version snapshot, so the
				// history below is stale. Without this the panel keeps showing
				// "No analyses generated yet" until the tab is remounted —
				// observed live: the row existed on the wire while the UI still
				// read empty. A replay writes no new version, so skip it.
				if (!result.replayed) {
					queryClient.invalidateQueries({
						queryKey:
							orpc.projects.stories.maturation.qaAnalysisVersions.key(),
					});
				}
				// The sub-minute idempotent replay serves the stored analysis
				// without a model call — say so, or the Refresh click reads as
				// a silently broken button.
				if (result.replayed) {
					toast.info(t("analysisUpToDate"));
				}
			},
			onError: (e) =>
				toast.error(t("analysisFailed", { error: e.message })),
		}),
	);

	const cases = useMemo(
		() =>
			(casesQuery.data?.pages ?? [])
				.flatMap((page) => page.items)
				.map((item) => ({
					id: item.id,
					identifier: item.identifier,
					title: item.title,
					state: item.state as TestCaseState,
					currentResult: item.currentResult as TestResult,
					acceptanceCriterionRefs:
						item.workItemLinks.find(
							(link) => link.userStoryId === storyId,
						)?.acceptanceCriterionRefs ?? [],
				})),
		[casesQuery.data, storyId],
	);

	// True linked-case count, read off the FRESHEST page — totals can move
	// between fetches when cases are created or deleted concurrently.
	const totalCases = casesQuery.data?.pages.at(-1)?.total ?? 0;
	// Coverage beyond the loaded pages must not silently read as "uncovered".
	// Keyed on the same signal as the Load more button, so the notice can never
	// point at a button that isn't there.
	const casesTruncated = casesQuery.hasNextPage === true;

	const matrix = useMemo(
		() => buildTraceabilityMatrix(criteria, cases),
		[criteria, cases],
	);

	// Download the matrix as markdown for audit. `casesTruncated` is
	// passed through so a partial export says so in the document rather than
	// reading as complete coverage.
	const handleExportMatrix = useCallback(() => {
		const markdown = traceabilityMatrixToMarkdown({
			matrix,
			totalCases,
			truncated: casesTruncated,
			generatedAt: new Date(),
		});
		const url = URL.createObjectURL(
			new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = `traceability-matrix-${storyId}.md`;
		link.click();
		URL.revokeObjectURL(url);
	}, [matrix, totalCases, casesTruncated, storyId]);

	// Warnings joined to criteria by the same ref counting the drafter uses;
	// refs without a number apply to the spec as a whole.
	const { warningsByIndex, generalWarnings } = useMemo(() => {
		// Entries rather than bare strings: a warning the drafted cases exposed
		// is marked, and dropping to a string here is what previously made that
		// distinction unrenderable.
		const byIndex = new Map<number, QaWarningEntry[]>();
		const general: QaWarningEntry[] = [];
		for (const warning of qaAnalysis?.warnings ?? []) {
			const entry: QaWarningEntry = {
				text: warning.warning,
				fromDraftedCases: Boolean(warning.fromDraftedCases),
			};
			const index = criterionIndexFromRef(warning.criterionRef);
			if (index !== null && index <= criteria.length) {
				const bucket = byIndex.get(index);
				if (bucket) {
					bucket.push(entry);
				} else {
					byIndex.set(index, [entry]);
				}
			} else {
				general.push(entry);
			}
		}
		return { warningsByIndex: byIndex, generalWarnings: general };
	}, [qaAnalysis, criteria.length]);

	/**
	 * Whether anything on this analysis came out of the drafted cases. Drives the
	 * one-line handover below the list: the warnings say what is missing, and a
	 * person is the one who edits the requirements.
	 */
	const showsDraftingRevealed = useMemo(
		() =>
			generalWarnings.some((w) => w.fromDraftedCases) ||
			[...warningsByIndex.values()].some((list) =>
				list.some((w) => w.fromDraftedCases),
			),
		[generalWarnings, warningsByIndex],
	);
	const hasCriteria = criteria.length > 0;

	// The sign-off verdict. Derived entirely from state this panel already
	// holds, so it can never disagree with the sections below it.
	const verdict = useMemo(
		() =>
			computeTestingVerdict({
				criteriaCount: criteria.length,
				uncoveredCount: matrix.rows.filter((r) => r.cases.length === 0)
					.length,
				// A criterion with three warnings is still one ambiguous
				// criterion — counting warnings would inflate it.
				ambiguousCount: warningsByIndex.size,
				analysisStale: qaAnalysisStale,
				analysisMissing: !qaAnalysis,
				failingCases: cases.filter((c) => c.currentResult === "FAILED")
					.length,
				casesTruncated,
			}),
		[
			criteria.length,
			matrix.rows,
			warningsByIndex,
			qaAnalysisStale,
			qaAnalysis,
			cases,
			casesTruncated,
		],
	);

	const light = qaStrategyLevel === "LIGHT";
	// The project switch is authoritative. When generation is
	// off, drafting is disabled here (the server also rejects it) so no credits
	// are spent; `applyTddApproach` only changes the ordering copy below.
	const draftingDisabledByProject = !generateManualTestCases;

	const startDraft = () =>
		draftMutation.mutate({
			projectId,
			storyIds: [storyId],
			organizationId,
		});
	const startAnalysis = () =>
		analysisMutation.mutate({ projectId, storyId, organizationId });

	const caseHref = (id: string) => `${projectBase}?tab=test-cases&case=${id}`;

	// Mirrors TestCasesList's failed-load treatment: a failed cases fetch must
	// say so, never masquerade as "no coverage". Shared by both cards.
	/**
	 * "Run tests" for THIS feature (mocks B5).
	 *
	 * Dispatches exactly the cases linked to this feature, so a reader who is
	 * looking at one feature can test it without going to the QA tab,
	 * selecting its cases by hand, and hoping they picked the same set.
	 *
	 * Runs the cases that are LOADED. The card already tells the reader when
	 * coverage extends beyond the loaded pages (`casesTruncated`), and the
	 * button says how many it will run, so the number is never a guess.
	 */
	const [configuringRun, setConfiguringRun] = useState(false);
	const runnableCaseIds = useMemo(
		// A CLOSED case is retired and a PROPOSED one is not agreed yet — neither
		// belongs in a run somebody started to check this feature works.
		() =>
			cases
				.filter((c) => c.state === "DRAFT" || c.state === "READY")
				.map((c) => c.id),
		[cases],
	);

	// The run started FROM this tab, so the surface that dispatched it can show
	// what happened next. Cleared by the reader once it has finished.
	const [startedRunId, setStartedRunId] = useState<string | null>(null);

	const dispatchRunMutation = useMutation(
		orpc.projects.agenticRuns.dispatch.mutationOptions({
			onSuccess: (result) => {
				setConfiguringRun(false);
				setStartedRunId(result.run?.id ?? null);
				if (result.dispatched) {
					toast.success(t("runStarted"));
				} else {
					toast.warning(result.reason ?? t("runRefused"));
				}
				if (result.productionWarning) {
					toast.warning(result.productionWarning, {
						duration: 12_000,
					});
				}
				queryClient.invalidateQueries({
					queryKey: orpc.projects.agenticRuns.list.key(),
				});
			},
			onError: (error) => toast.error(error.message),
		}),
	);

	const casesErrorBlock = (
		<div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<p className="text-muted-foreground text-sm">
				{tTestCases("errors.listFailed")}
			</p>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => casesQuery.refetch()}
			>
				{tTestCases("errors.retry")}
			</Button>
		</div>
	);

	// A successful run can legitimately flag nothing at STANDARD/STRICT — say so
	// instead of leaving the click with no visible result.
	const analysisClean =
		qaAnalysis !== null &&
		qaAnalysis.warnings.length === 0 &&
		!qaAnalysis.integrationNotes &&
		!qaAnalysis.e2eScenarios;

	// Editor state still hydrating: every prop is a placeholder, so asserting
	// "no acceptance criteria" here would be false. Mirror the sibling panels'
	// deliberate loading treatment.
	if (loading) {
		return (
			<div className="mx-auto max-w-3xl">
				<div className="flex items-center justify-center py-16 text-muted-foreground">
					<Loader2Icon
						className="size-5 motion-safe:animate-spin"
						aria-label={t("loadingPanel")}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto max-w-3xl xl:grid xl:max-w-none xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-8">
			<div className="min-w-0 space-y-8">
				<RunConfigurationDialog
					projectId={projectId}
					open={configuringRun}
					onOpenChange={setConfiguringRun}
					caseCount={runnableCaseIds.length}
					dispatching={dispatchRunMutation.isPending}
					onDispatch={(overrides) =>
						dispatchRunMutation.mutate({
							projectId,
							selection: {
								mode: "ids" as const,
								ids: runnableCaseIds,
							},
							...overrides,
						})
					}
				/>
				{/* The verdict, above everything it is derived from. Assembling "can
			    I sign this off" out of the warnings list, the matrix, the case
			    table and an analysis timestamp is work this page can do once —
			    and doing it by hand is how a feature gets signed off against an
			    analysis that predates its own specification. */}
				<TestingVerdictCard
					verdict={verdict}
					onRefreshAnalysis={hasCriteria ? startAnalysis : undefined}
					onDraftGaps={hasCriteria ? startDraft : undefined}
					refreshPending={analysisMutation.isPending}
					draftPending={draftMutation.isPending}
					draftDisabledReason={
						draftingDisabledByProject
							? t("generationOffNotice")
							: undefined
					}
				/>

				{/* Actions: both generations are explicit, billable buttons — nothing
			    fires from merely opening this tab. Each explains itself on
			    hover/focus — a disabled button still gets a tooltip via the
			    wrapping span. */}
				<TooltipProvider>
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<Button
										size="sm"
										variant="outline"
										onClick={startAnalysis}
										disabled={
											!hasCriteria ||
											analysisMutation.isPending ||
											draftMutation.isPending
										}
										className="gap-1.5"
									>
										{analysisMutation.isPending ? (
											<Loader2Icon
												className="size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
										) : (
											<FlaskConicalIcon
												className="size-4"
												aria-hidden="true"
											/>
										)}
										{analysisMutation.isPending
											? t("generatingAnalysis")
											: qaAnalysis
												? t("refreshAnalysis")
												: t("generateAnalysis")}
									</Button>
								</span>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs text-xs leading-relaxed">
								{t("info.analysis")}
								{/* The button spends a second generation on
								    standard ordering, because completing the
								    review is what drafts the cases. Saying "uses
								    one AI generation" and then billing two is
								    the kind of surprise that makes people stop
								    trusting the button. */}
								{generateManualTestCases &&
									!applyTddApproach && (
										<span className="mt-2 block">
											{t("info.analysisAlsoDrafts")}
										</span>
									)}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<Button
										size="sm"
										onClick={startDraft}
										disabled={
											!hasCriteria ||
											draftingDisabledByProject ||
											draftActive ||
											draftMutation.isPending
										}
										className="gap-1.5"
									>
										{draftActive ||
										draftMutation.isPending ? (
											<Loader2Icon
												className="size-4 motion-safe:animate-spin"
												aria-hidden="true"
											/>
										) : (
											<SparklesIcon
												className="size-4"
												aria-hidden="true"
											/>
										)}
										{draftActive
											? t("drafting")
											: t("draftCases")}
									</Button>
								</span>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs text-xs leading-relaxed">
								{draftingDisabledByProject
									? t("info.draftDisabledOff")
									: t("info.draft")}
							</TooltipContent>
						</Tooltip>
					</div>
				</TooltipProvider>

				{/* Active generation flow + the off notice. Once
			    acceptance criteria exist, the editor visibly reflects the
			    project's TDD/standard ordering and whether drafting is available
			    at all. */}
				{hasCriteria && (
					<div className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-2.5 text-sm">
						<InfoIcon
							className="mt-0.5 size-4 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
						<p className="text-foreground/90">
							{draftingDisabledByProject
								? t("generationOffNotice")
								: applyTddApproach
									? t("flowTdd")
									: t("flowStandard")}
						</p>
					</div>
				)}

				{/* Cases drafted from an earlier version of this feature. Renders
				    nothing when nothing drifted, so it only appears when there is
				    something to decide. */}
				<DriftedCasesSection
					projectId={projectId}
					storyId={storyId}
					organizationId={organizationId}
					hasAcceptanceCriteria={Boolean(acceptanceCriteria?.trim())}
				/>

				{qaAnalysis && (
					<p className="-mt-4 text-right text-xs text-muted-foreground">
						{t("analysisGeneratedAt", {
							date: new Date(
								qaAnalysis.generatedAt,
							).toLocaleString(),
						})}
						{analysisClean && ` ${t("analysisClean")}`}
						{/* Test-first only. Without it, an analysis that read the
						    cases and one that did not looked identical, so the
						    ordering setting's effect was unobservable. */}
						{typeof qaAnalysis.reviewedAgainstCaseCount ===
							"number" && (
							<>
								{" "}
								{t("reviewedAgainstCases", {
									count: qaAnalysis.reviewedAgainstCaseCount,
								})}
							</>
						)}
					</p>
				)}

				{!hasCriteria && (
					<div className="rounded-lg border bg-muted p-4 text-sm text-foreground/90">
						{t("noCriteria")}
					</div>
				)}

				{qaAnalysisStale && (
					<div className="flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/10 px-4 py-2.5 text-sm">
						<TriangleAlertIcon
							className="mt-0.5 size-4 shrink-0 text-highlight"
							aria-hidden="true"
						/>
						<p className="text-foreground">{t("staleNotice")}</p>
					</div>
				)}

				{/* Under-specification warnings — AC 4: shown before anyone relies on
			    the drafted cases. */}
				{qaAnalysis &&
					(warningsByIndex.size > 0 ||
						generalWarnings.length > 0) && (
						<section aria-labelledby="qa-warnings-heading">
							<div className="flex items-center gap-2">
								<SectionHeading id="qa-warnings-heading">
									{t("warningsHeading")}
								</SectionHeading>
								<Badge
									variant="warning"
									className="h-5 min-w-5 justify-center px-1.5 text-[11px]"
									aria-label={t("warningsCount", {
										count: qaAnalysis.warnings.length,
									})}
								>
									{qaAnalysis.warnings.length}
								</Badge>
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								{t("warningsHint")}
							</p>
							<ul className="mt-3 space-y-2">
								{[...warningsByIndex.entries()]
									.sort(([a], [b]) => a - b)
									.map(([index, warnings]) =>
										warnings.map((warning, i) => (
											<li
												key={`${index}-${i}`}
												className="flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/10 p-3 text-sm"
											>
												<span className="shrink-0 font-mono text-xs text-muted-foreground">
													{t("criterionLabel", {
														index,
													})}
												</span>
												<span className="text-foreground">
													{warning.text}
													{warning.fromDraftedCases && (
														<DraftingRevealedChip />
													)}
												</span>
											</li>
										)),
									)}
								{showsDraftingRevealed && (
									// The card's step 3 reads "Requirements
									// Reviewed / Updated". Fabric reviews and says
									// what it found; updating stays a person's
									// edit, because a tool that rewrites
									// acceptance criteria from its own warning is
									// grading its own work. This line makes the
									// handover explicit rather than implied — and
									// if we later want Fabric to draft the edit
									// itself, this is where it would offer it.
									<li className="rounded-lg border border-border/60 bg-muted/40 p-3 text-muted-foreground text-xs">
										{t("draftingRevealedGuidance")}
									</li>
								)}
								{generalWarnings.map((warning, i) => (
									<li
										key={`general-${i}`}
										className="flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/10 p-3 text-sm"
									>
										<span className="text-foreground">
											{warning.text}
											{warning.fromDraftedCases && (
												<DraftingRevealedChip />
											)}
										</span>
									</li>
								))}
							</ul>
						</section>
					)}

				{/* Traceability matrix — AC 5: each criterion with the real TestCase
			    rows covering it; every case navigates to the QA tab. */}
				{hasCriteria && (
					<section aria-labelledby="qa-matrix-heading">
						<div className="flex items-center gap-2">
							<SectionHeading id="qa-matrix-heading">
								{t("matrixHeading")}
							</SectionHeading>
							<SectionInfo
								aria={t("info.matrixAria")}
								body={t("info.matrix")}
							/>
							{totalCases > 0 && (
								<span className="text-xs text-muted-foreground">
									{t("casesCount", { count: totalCases })}
								</span>
							)}
							{/* Compliance/audit export. Client-side: the
						    matrix is already fully in memory, so a round-trip
						    would only add a way for the file to disagree with
						    what the user is looking at. */}
							{/* Per-feature "Run tests" (mocks B5). Hidden rather than
						    disabled when there is nothing runnable: a feature with
						    no agreed cases has nothing to run, and a permanently
						    dead button reads as broken. */}
							{runnableCaseIds.length > 0 && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="ml-auto gap-1.5"
									onClick={() => setConfiguringRun(true)}
								>
									<PlayIcon
										className="size-3.5"
										aria-hidden="true"
									/>
									{t("runTests", {
										count: runnableCaseIds.length,
									})}
								</Button>
							)}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									"gap-1.5",
									runnableCaseIds.length === 0 && "ml-auto",
								)}
								onClick={handleExportMatrix}
							>
								<DownloadIcon
									className="size-3.5"
									aria-hidden="true"
								/>
								{t("matrixExport")}
							</Button>
						</div>
						<p className="mt-1 text-xs text-muted-foreground">
							{t("matrixHint")}
						</p>
						{casesTruncated && (
							<div className="mt-2 flex items-start gap-2 rounded-lg border border-highlight/40 bg-highlight/10 px-3 py-2 text-xs">
								<TriangleAlertIcon
									className="mt-0.5 size-3.5 shrink-0 text-highlight"
									aria-hidden="true"
								/>
								<p className="text-foreground">
									{t("casesTruncated", {
										shown: cases.length,
									})}
								</p>
							</div>
						)}
						<div className="mt-3 rounded-lg border bg-card">
							{casesLoading ? (
								<div className="flex items-center justify-center py-8 text-muted-foreground">
									<Loader2Icon
										className="size-4 motion-safe:animate-spin"
										aria-hidden="true"
									/>
								</div>
							) : casesError ? (
								casesErrorBlock
							) : (
								// The richer matrix: per-case pyramid level, spec file,
								// commit, evidence and a stale flag, not just which
								// cases exist.
								<CoverageMatrixTable
									projectId={projectId}
									storyId={storyId}
									organizationId={organizationId}
									rows={matrix.rows}
									unmappedCases={matrix.unmapped}
									unresolvedCases={matrix.unresolved}
									flaggedCriteria={
										new Set(warningsByIndex.keys())
									}
									caseHref={caseHref}
									uncoveredLabel={t("uncovered")}
									unmappedLabel={t("unmappedHeading")}
									criterionLabel={(index) =>
										t("criterionLabel", { index })
									}
								/>
							)}
						</div>
					</section>
				)}

				{/* The linked cases in full — identifier, title, state/result — the
			    same vocabulary as the QA tab's list. */}
				<section aria-labelledby="qa-cases-heading">
					<div className="flex items-center gap-2">
						<SectionHeading id="qa-cases-heading">
							{t("casesHeading")}
						</SectionHeading>
						<SectionInfo
							aria={t("info.casesAria")}
							body={t("info.cases")}
						/>
					</div>
					<div className="mt-3 rounded-lg border bg-card">
						{casesLoading ? (
							<div className="flex items-center justify-center py-8 text-muted-foreground">
								<Loader2Icon
									className="size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							</div>
						) : casesError ? (
							casesErrorBlock
						) : cases.length === 0 ? (
							<div className="space-y-2 p-4">
								<p className="text-sm text-muted-foreground">
									{hasCriteria
										? t("casesEmpty")
										: t("noCriteria")}
								</p>
								{/* Said here, before somebody tries to start work
								    and is refused. Fabric can only block the
								    implementation IT starts; a developer working
								    in their own editor passes no gate, so this
								    notice is what covers the common case. */}
								{applyTddApproach && (
									<Alert variant="warning">
										<TriangleAlertIcon aria-hidden="true" />
										<AlertDescription>
											{t("tddNoCasesBlocks")}
										</AlertDescription>
									</Alert>
								)}
							</div>
						) : (
							<ul className="divide-y">
								{cases.map((c) => (
									<li
										key={c.id}
										className="flex items-center gap-2 pr-3 transition-colors hover:bg-accent"
									>
										<Link
											href={caseHref(c.id)}
											className="flex min-w-0 flex-1 items-center gap-3 p-3"
										>
											<span className="shrink-0 font-mono text-xs text-muted-foreground">
												{c.identifier}
											</span>
											<span className="min-w-0 flex-1 truncate text-sm text-foreground">
												{c.title}
											</span>
											{c.acceptanceCriterionRefs.length >
												0 && (
												<span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
													{c.acceptanceCriterionRefs.join(
														", ",
													)}
												</span>
											)}
											<TestCaseStatusChip
												status={c.state}
												label={tTestCases(
													STATE_I18N_KEY[c.state],
												)}
											/>
											{c.currentResult !== "NOT_RUN" && (
												<span className="shrink-0 text-xs text-muted-foreground">
													{tTestCases(
														RESULT_I18N_KEY[
															c.currentResult
														],
													)}
												</span>
											)}
										</Link>
										{/* Outside the Link, not inside it: a button
										    nested in an anchor is not reachable by
										    keyboard as its own control. This is the
										    only entry point for a hand-authored case,
										    which carries no spec fingerprint and so
										    never appears in the section above until it
										    has a proposal.

										    Labelled but compact: a bare pull-request
										    glyph here was the step nobody found,
										    while the full label made the button 53%
										    of a 363px row and truncated the case
										    title. One short word costs neither. */}
										<ReviseFromImplementationButton
											projectId={projectId}
											storyId={storyId}
											testCaseId={c.id}
											identifier={c.identifier}
											organizationId={organizationId}
											compact
										/>
									</li>
								))}
							</ul>
						)}
						{/* Same Load-more recipe as TestCasesList — each page extends
					    the matrix above and this list together. Success-branch
					    only (like the reference): a failed fetch shows the error
					    block's Retry, never two competing recovery actions. */}
						{!casesLoading &&
							!casesError &&
							cases.length > 0 &&
							casesQuery.hasNextPage && (
								<div className="flex justify-center border-t py-1.5">
									<Button
										variant="ghost"
										size="sm"
										onClick={() =>
											casesQuery.fetchNextPage()
										}
										disabled={casesQuery.isFetchingNextPage}
										className="gap-1.5 text-muted-foreground hover:text-foreground"
									>
										{casesQuery.isFetchingNextPage && (
											<Loader2Icon
												aria-hidden="true"
												className="size-3.5 motion-safe:animate-spin"
											/>
										)}
										{tTestCases("actions.loadMore")}
									</Button>
								</div>
							)}
					</div>
				</section>

				{/* Analysis sections — AC 3/6: integration + E2E render only when the
			    stored analysis carries them (LIGHT depth stores them empty). */}
				{qaAnalysis ? (
					<>
						{qaAnalysis.integrationNotes && (
							<section aria-labelledby="qa-integration-heading">
								<SectionHeading id="qa-integration-heading">
									{t("integrationHeading")}
								</SectionHeading>
								<div className="mt-3 rounded-lg border bg-card p-4">
									<Markdown className="leading-relaxed text-foreground">
										{qaAnalysis.integrationNotes}
									</Markdown>
								</div>
							</section>
						)}
						{qaAnalysis.e2eScenarios && (
							<section aria-labelledby="qa-e2e-heading">
								<SectionHeading id="qa-e2e-heading">
									{t("e2eHeading")}
								</SectionHeading>
								<div className="mt-3 rounded-lg border bg-card p-4">
									<Markdown className="leading-relaxed text-foreground">
										{qaAnalysis.e2eScenarios}
									</Markdown>
								</div>
							</section>
						)}
						{qaAnalysis.depth === "LIGHT" && (
							<p className="text-xs text-muted-foreground">
								{t("lightDepthNote")}
							</p>
						)}
					</>
				) : (
					hasCriteria && (
						<section aria-labelledby="qa-analysis-heading">
							<SectionHeading id="qa-analysis-heading">
								{t("analysisHeading")}
							</SectionHeading>
							<div className="mt-3 rounded-lg border bg-card p-4">
								<p className="text-sm text-muted-foreground">
									{light
										? t("analysisEmptyLight")
										: t("analysisEmptyFull")}
								</p>
							</div>
						</section>
					)
				)}
			</div>

			{/*
			 * Right rail. These four answer "how is this feature doing" and are read
			 * at a glance; the main column is the work itself — the verdict, the
			 * gaps, the matrix and the cases. Stacked below the main column until
			 * `xl`, because a 300px rail beside a 400px column is two cramped
			 * columns rather than one readable one.
			 */}
			<aside className="mt-8 space-y-6 xl:mt-0">
				<CoverageSummary
					criteria={criteria.length}
					covered={
						matrix.rows.filter((r) => r.cases.length > 0).length
					}
					cases={totalCases}
					truncated={casesTruncated}
				/>
				{/* Who has approved this feature, when the project asks for
					    approvals at all. Renders nothing when the requirement is zero,
					    which is the default — see the component. */}
				{currentUserId && (
					<QaSignOffSection
						projectId={projectId}
						storyId={storyId}
						canEdit
						currentUserId={currentUserId}
					/>
				)}
				{/* Live CI pipeline results (cards 1834/1878) — pull latest runs and
					    open failing cases. Part of the QA surface; renders
					    whenever the QA tab does. */}
				<FeatureRunProgress
					projectId={projectId}
					runId={startedRunId}
					onDismiss={() => setStartedRunId(null)}
				/>
				<PipelineRunsSection
					projectId={projectId}
					organizationId={organizationId}
					storyId={storyId}
				/>
				{/* History — drafting runs + QA-analysis versions for this feature.
				    Only meaningful once the feature has criteria to act on. */}
				{hasCriteria && (
					<QaHistorySection
						projectId={projectId}
						storyId={storyId}
						organizationId={organizationId}
					/>
				)}
			</aside>
			{/* Outlives the buttons on purpose: the drafting run keeps going after
				    navigation, and on re-open this is what re-finds it. */}
			<TestCaseDraftJobWatcher
				projectId={projectId}
				organizationId={organizationId}
			/>
		</div>
	);
}
