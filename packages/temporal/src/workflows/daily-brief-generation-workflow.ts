/**
 * Daily Brief Generation Workflow
 *
 * Fans out parallel collector activities (story/doc/meeting/proposal/GitHub),
 * runs the deterministic priority-detection activity, then invokes the LLM
 * summarizer. Writes the assembled content back to the DailyBrief row that
 * the oRPC `regenerate` procedure created in GENERATING status.
 *
 * Signal: cancelBrief.
 * Query:  briefProgress — returns { phase, completedSources, totalSources }.
 */
import type {
	AheadItem,
	GithubItem,
	MeetingItem,
	PriorityAction,
	ReleaseNotesSummary,
} from "@repo/database";
import {
	ApplicationFailure,
	CancelledFailure,
	ContinueAsNew,
	continueAsNew,
	defineQuery,
	defineSignal,
	log,
	patched,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type {
	collectAhead as CollectAheadFn,
	collectDocumentChanges as CollectDocumentChangesFn,
	collectGitHubPullRequestsActivity as CollectGitHubPullRequestsFn,
	collectGitHubReleasesActivity as CollectGitHubReleasesFn,
	collectMeetingTranscripts as CollectMeetingTranscriptsFn,
	collectStoryActivity as CollectStoryActivityFn,
	collectTeamsProposals as CollectTeamsProposalsFn,
	detectPriorityActionsActivity as DetectPriorityActionsFn,
	extractMeetingInsightsActivity as ExtractMeetingInsightsFn,
	loadReleaseNoteExclusionsActivity as LoadReleaseNoteExclusionsFn,
	persistDailyBriefActivity as PersistDailyBriefFn,
	summarizeDailyBriefActivity as SummarizeDailyBriefFn,
	summarizeReleaseNotesActivity as SummarizeReleaseNotesFn,
} from "../activities/daily-brief";
import {
	applyDeploymentsResult,
	assembleFinalBrief,
	resolveBriefCompletion,
} from "./daily-brief-completion";
// Runtime helpers from a local, workflow-safe pure module (type-only @repo/database
// import inside it is erased at compile) — importing its runtime functions into the
// sandbox is allowed, exactly like `./daily-brief-completion`.
import {
	exclusionSignature,
	filterExcludedMergedPrs,
} from "./daily-brief-release-note-exclusions";

// =============================================================================
// Input / output
// =============================================================================

export interface GenerateDailyBriefInput {
	briefId: string;
	projectId: string;
	organizationId: string | null;
	triggeredByUserId: string;
	timeWindowStart: string; // ISO
	timeWindowEnd: string; // ISO
	/**
	 * Bounded self-rerun counter for the v6 freshness/convergence guarantee.
	 * Additive (defaults to 0). Incremented on each `continueAsNew` when a
	 * hide/unhide lands mid-generation; capped by `MAX_REGEN_CHAIN` so the
	 * chain can never run away.
	 */
	regenChainDepth?: number;
}

export type DailyBriefPhase =
	| "initializing"
	| "collecting"
	| "extracting_insights"
	| "detecting_priority"
	| "summarizing"
	| "persisting"
	| "complete"
	| "cancelled"
	| "failed";

export interface DailyBriefProgress {
	phase: DailyBriefPhase;
	completedSources: number;
	totalSources: number;
	message: string;
	error?: string;
}

/**
 * Workflow-level result. On business failure the workflow throws so the
 * Temporal run is marked Failed; callers observe FAILED status by reading
 * the persisted DailyBrief row via the oRPC `get` procedure.
 */
export interface GenerateDailyBriefOutput {
	success: boolean;
	status: "READY" | "EMPTY" | "CANCELLED";
}

// =============================================================================
// Signals & queries
// =============================================================================

export const cancelBriefSignal = defineSignal("cancelBrief");
export const briefProgressQuery =
	defineQuery<DailyBriefProgress>("briefProgress");

// =============================================================================
// Activity proxies
// =============================================================================

const collectTimeout = {
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "1 minute",
} as const;
const longTimeout = {
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
} as const;

// JS programming errors are deterministic — retrying burns attempts without
// changing the outcome. Mark them non-retryable so bugs surface fast.
const PROGRAMMING_ERROR_TYPES = [
	"TypeError",
	"ReferenceError",
	"SyntaxError",
] as const;

const {
	collectStoryActivity,
	collectDocumentChanges,
	collectMeetingTranscripts,
	collectTeamsProposals,
	loadReleaseNoteExclusionsActivity,
} = proxyActivities<{
	collectStoryActivity: typeof CollectStoryActivityFn;
	collectDocumentChanges: typeof CollectDocumentChangesFn;
	collectMeetingTranscripts: typeof CollectMeetingTranscriptsFn;
	collectTeamsProposals: typeof CollectTeamsProposalsFn;
	loadReleaseNoteExclusionsActivity: typeof LoadReleaseNoteExclusionsFn;
}>({
	...collectTimeout,
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { collectGitHubPullRequestsActivity } = proxyActivities<{
	collectGitHubPullRequestsActivity: typeof CollectGitHubPullRequestsFn;
}>({
	...collectTimeout,
	retry: {
		maximumAttempts: 2,
		initialInterval: "3s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { collectGitHubReleasesActivity } = proxyActivities<{
	collectGitHubReleasesActivity: typeof CollectGitHubReleasesFn;
}>({
	// Releases can page up to 5x per repo across several repos; give it more
	// headroom than the 2-min collectTimeout. The activity self-bounds to a soft
	// wall-clock budget (SOFT_BUDGET_MS = 2 min) so it returns partial data well
	// before this deadline; the extra minute is margin for the final repo.
	startToCloseTimeout: "3 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		maximumAttempts: 2,
		initialInterval: "3s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { collectAhead } = proxyActivities<{
	collectAhead: typeof CollectAheadFn;
}>({
	...collectTimeout,
	retry: {
		maximumAttempts: 2,
		initialInterval: "2s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { detectPriorityActionsActivity } = proxyActivities<{
	detectPriorityActionsActivity: typeof DetectPriorityActionsFn;
}>({
	...collectTimeout,
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { summarizeDailyBriefActivity } = proxyActivities<{
	summarizeDailyBriefActivity: typeof SummarizeDailyBriefFn;
}>({
	...longTimeout,
	retry: {
		maximumAttempts: 2,
		initialInterval: "5s",
		nonRetryableErrorTypes: [
			"DAILY_BRIEF_SCHEMA_VALIDATION_FAILED",
			...PROGRAMMING_ERROR_TYPES,
		],
	},
});

const { extractMeetingInsightsActivity } = proxyActivities<{
	extractMeetingInsightsActivity: typeof ExtractMeetingInsightsFn;
}>({
	...longTimeout,
	retry: {
		maximumAttempts: 2,
		initialInterval: "5s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { summarizeReleaseNotesActivity } = proxyActivities<{
	summarizeReleaseNotesActivity: typeof SummarizeReleaseNotesFn;
}>({
	...longTimeout,
	retry: {
		maximumAttempts: 2,
		initialInterval: "5s",
		nonRetryableErrorTypes: [...PROGRAMMING_ERROR_TYPES],
	},
});

const { persistDailyBriefActivity } = proxyActivities<{
	persistDailyBriefActivity: typeof PersistDailyBriefFn;
}>({
	startToCloseTimeout: "30 seconds",
	heartbeatTimeout: "15 seconds",
	retry: { maximumAttempts: 5, initialInterval: "1s" },
});

// =============================================================================
// Workflow
// =============================================================================

const SOURCE_NAMES = [
	"stories",
	"documents",
	"meetings",
	"teamsProposals",
	"github",
	"ahead",
] as const;

/** All `partialFailure.source` values the workflow can emit. Includes
 * `releaseNotes` (post-collection LLM activity) on top of the collector
 * SOURCE_NAMES so the count of progress-tracked sources stays stable. */
type PartialFailureSource = (typeof SOURCE_NAMES)[number] | "releaseNotes";

export async function generateDailyBriefWorkflow(
	input: GenerateDailyBriefInput,
): Promise<GenerateDailyBriefOutput> {
	const {
		briefId,
		projectId,
		organizationId,
		triggeredByUserId,
		timeWindowStart,
		timeWindowEnd,
		regenChainDepth = 0,
	} = input;

	const progress: DailyBriefProgress = {
		phase: "initializing",
		completedSources: 0,
		totalSources: SOURCE_NAMES.length,
		message: "Starting Daily Brief generation",
	};

	let cancelled = false;
	setHandler(cancelBriefSignal, () => {
		cancelled = true;
		progress.phase = "cancelled";
		progress.message = "Cancellation requested";
		log.info("[Daily Brief] Cancellation signal received", { briefId });
	});
	setHandler(briefProgressQuery, () => progress);

	const start = new Date(timeWindowStart);
	const end = new Date(timeWindowEnd);

	try {
		progress.phase = "collecting";
		progress.message = "Collecting activity from connected tools";

		const collectorInput = {
			projectId,
			organizationId,
			timeWindowStart: start,
			timeWindowEnd: end,
		};

		// Deployments (GitHub Releases) — gated, first-class, scheduled in parallel.
		// The .then(ok,reason) handler is attached eagerly so a fast rejection is
		// never an unhandled rejection while the core fan-out is still awaiting.
		const releasesEnabled = patched("daily-brief-v4-github-releases");
		if (releasesEnabled) {
			progress.totalSources = SOURCE_NAMES.length + 1;
		}
		const releasesSettledPromise = releasesEnabled
			? collectGitHubReleasesActivity({
					...collectorInput,
					userId: triggeredByUserId,
				}).then(
					(value) => ({ ok: true as const, value }),
					(reason) => ({ ok: false as const, reason }),
				)
			: undefined;

		// Patch gate — v2 adds `collectAhead` to the fan-out and an
		// `extractMeetingInsights` phase before priority detection. Old
		// histories recorded against main (which has neither activity) must
		// replay through the pre-v2 path to avoid non-determinism errors.
		const dailyBriefV2 = patched("daily-brief-v2");

		// Keep the v1 and v2 branches syntactically separate so each records
		// a distinct scheduling sequence. v1 is the main-compat path; v2 adds
		// collectAhead to the parallel fan-out.
		const settled = dailyBriefV2
			? await Promise.allSettled([
					collectStoryActivity(collectorInput),
					collectDocumentChanges(collectorInput),
					collectMeetingTranscripts(collectorInput),
					collectTeamsProposals(collectorInput),
					collectGitHubPullRequestsActivity({
						...collectorInput,
						userId: triggeredByUserId,
					}),
					collectAhead({ projectId, organizationId }),
				])
			: await Promise.allSettled([
					collectStoryActivity(collectorInput),
					collectDocumentChanges(collectorInput),
					collectMeetingTranscripts(collectorInput),
					collectTeamsProposals(collectorInput),
					collectGitHubPullRequestsActivity({
						...collectorInput,
						userId: triggeredByUserId,
					}),
				]);

		if (cancelled) {
			await persistDailyBriefActivity({
				briefId,
				status: "FAILED",
				content: null,
				errorMessage: "Cancelled before summarization",
			});
			return { success: false, status: "CANCELLED" };
		}

		const partialFailures: Array<{
			source: PartialFailureSource;
			reason: string;
		}> = [];

		const [
			storiesResult,
			docsResult,
			meetingsResult,
			proposalsResult,
			githubResult,
		] = settled;

		const sections: Record<string, unknown> = {};

		if (storiesResult.status === "fulfilled") {
			sections.storyChanges = storiesResult.value.stories;
			sections.taskChanges = storiesResult.value.tasks;
		} else {
			partialFailures.push({
				source: "stories",
				reason: String(storiesResult.reason),
			});
		}

		if (docsResult.status === "fulfilled") {
			sections.documents = docsResult.value;
		} else {
			partialFailures.push({
				source: "documents",
				reason: String(docsResult.reason),
			});
		}

		if (meetingsResult.status === "fulfilled") {
			sections.meetings = meetingsResult.value;
		} else {
			partialFailures.push({
				source: "meetings",
				reason: String(meetingsResult.reason),
			});
		}

		if (proposalsResult.status === "fulfilled") {
			sections.teamsProposals = proposalsResult.value;
		} else {
			partialFailures.push({
				source: "teamsProposals",
				reason: String(proposalsResult.reason),
			});
		}

		let stalePrActions: PriorityAction[] = [];

		if (githubResult.status === "fulfilled") {
			// The Daily Brief proxies the PR collector WITHOUT the
			// `captureAuthorGithubId` flag, so items here never carry the
			// publishing-suite-only `authorGithubId` — no post-hoc strip needed.
			sections.github = githubResult.value.items;
			stalePrActions = githubResult.value.stalePrActions ?? [];
			// GitHub activity surfaces per-repo failures inline; roll them up.
			for (const repoFailure of githubResult.value.failures ?? []) {
				partialFailures.push({
					source: "github",
					reason: `${repoFailure.repoFullName}: ${repoFailure.reason}`,
				});
			}
		} else {
			partialFailures.push({
				source: "github",
				reason: String(githubResult.reason),
			});
		}

		// v6 — apply the project's curated release-note exclusions to the
		// merged-PR set. Behind a patch gate so pre-v6 histories replay through
		// the unfiltered path. Load happens in a DB-local activity (I/O stays out
		// of the sandbox); the filter itself is a pure, deterministic transform.
		// Only `sections.github` is filtered — `stalePrActions` is derived from
		// non-merged (stale/open) PRs and is out of exclusion scope by design;
		// `storyChanges`/`taskChanges` are the story's in-progress narrative,
		// also untouched.
		const exclusionsV6 = patched("daily-brief-v6-exclusions");
		let appliedExclusionSig = ""; // captured for the freshness/convergence check
		if (exclusionsV6) {
			const exclusions = await loadReleaseNoteExclusionsActivity({
				projectId,
				organizationId,
			});
			appliedExclusionSig = exclusionSignature(exclusions);
			if (Array.isArray(sections.github)) {
				sections.github = filterExcludedMergedPrs(
					sections.github as GithubItem[],
					exclusions,
				);
			}
		}

		let ahead: AheadItem[] = [];
		if (dailyBriefV2) {
			const aheadResult = settled[5] as PromiseSettledResult<AheadItem[]>;
			if (aheadResult.status === "fulfilled") {
				ahead = aheadResult.value;
			} else {
				// Ahead is supplementary — surface as a partial failure, not fatal.
				partialFailures.push({
					source: "ahead",
					reason: `Ahead lookup failed: ${String(aheadResult.reason)}`,
				});
			}
		}

		// Resolve the deployments source via the pure helper (unit-tested in Task 5).
		// `applyDeploymentsResult` distinguishes "ran" (cosmetic) from "contributed"
		// (gates the fatal) — the collector swallows per-repo errors and can fulfill
		// with no items.
		const coreFulfilled = settled.filter(
			(s) => s.status === "fulfilled",
		).length;
		const applied = applyDeploymentsResult(
			releasesSettledPromise ? await releasesSettledPromise : undefined,
		);
		if (applied.deployments) {
			sections.deployments = applied.deployments;
		}
		// Surfaced via the rollback-safe optional `deploymentsError` content field
		// (merged into finalContent below) — NOT a new partialFailures source value.
		const deploymentsError = applied.deploymentsError;

		const completion = resolveBriefCompletion({
			coreFulfilledCount: coreFulfilled,
			deploymentsRan: applied.deploymentsRan,
			deploymentsContributed: applied.deploymentsContributed,
		});
		progress.completedSources = completion.completedSources;

		// Skip the LLM call when there is genuinely nothing to summarize due to a
		// systemic failure — every core collector rejected AND deployments did not
		// contribute real items. A successful deployments fetch keeps the brief alive.
		if (completion.allCollectorsFailed) {
			const reasons = [
				...partialFailures.map((f) => `${f.source}: ${f.reason}`),
				...(deploymentsError
					? [`deployments: ${deploymentsError}`]
					: []),
			].join("; ");
			throw ApplicationFailure.nonRetryable(
				`All Daily Brief collectors failed: ${reasons}`,
				"DAILY_BRIEF_ALL_COLLECTORS_FAILED",
			);
		}

		let detected: PriorityAction[];
		// v3 adds a third LLM activity to the insights fan-out: the release
		// notes summarizer. Patch gate keeps replay deterministic for v2
		// histories that only recorded two entries in this Promise.allSettled.
		const dailyBriefV3 = patched("daily-brief-v3-release-summary");
		let releaseNotesSummary: ReleaseNotesSummary | undefined;
		if (dailyBriefV2) {
			progress.phase = "extracting_insights";
			progress.message =
				"Extracting meeting insights and detecting priority actions";

			// extractMeetingInsightsActivity, detectPriorityActionsActivity, and
			// summarizeReleaseNotesActivity have no data dependency on each
			// other. Running them in parallel shaves the slowest one's latency
			// off the critical path.
			const meetingItems =
				(sections.meetings as MeetingItem[] | undefined) ?? [];
			const githubItems =
				(sections.github as GithubItem[] | undefined) ?? [];
			const mergedGithub = githubItems.filter(
				(g) => g.kind === "pr_merged",
			);

			// Unfurl umbrella prod merges into their constituent staging PRs.
			// PRs targeting `production` are usually `main → production` wrapper
			// merges with empty bodies — feeding those to the LLM produces a
			// useless blurb. The actual changes being promoted are the staging
			// PRs that landed in main BEFORE the prod merge fired. Partition
			// at the latest prod merge timestamp:
			//   - prodPrs    = staging PRs merged at or before the latest prod
			//                  merge in window (= shipped to prod)
			//   - stagingPrs = staging PRs merged after (= on staging only)
			// If no prod merges in window, everything is staging-only.
			const occurredAtMs = (g: GithubItem) =>
				g.occurredAt instanceof Date
					? g.occurredAt.getTime()
					: new Date(g.occurredAt).getTime();

			let latestProdTime: number | undefined;
			const stagingMerged: GithubItem[] = [];
			for (const g of mergedGithub) {
				if (g.baseRef === "production") {
					const t = occurredAtMs(g);
					if (latestProdTime === undefined || t > latestProdTime) {
						latestProdTime = t;
					}
				} else {
					stagingMerged.push(g);
				}
			}

			const prodPrs: GithubItem[] = [];
			const stagingPrs: GithubItem[] = [];
			if (latestProdTime === undefined) {
				stagingPrs.push(...stagingMerged);
			} else {
				for (const s of stagingMerged) {
					(occurredAtMs(s) <= latestProdTime
						? prodPrs
						: stagingPrs
					).push(s);
				}
			}

			if (dailyBriefV3) {
				const [insightsSettled, detectedSettled, releaseSettled] =
					await Promise.allSettled([
						meetingItems.length > 0
							? extractMeetingInsightsActivity({
									projectId,
									organizationId,
									userId: triggeredByUserId,
									transcriptCuids: meetingItems.map(
										(m) => m.transcriptCuid,
									),
								})
							: Promise.resolve({
									insights: [],
									extractedCount: 0,
									cachedCount: 0,
								}),
						detectPriorityActionsActivity({
							projectId,
							organizationId,
						}),
						prodPrs.length + stagingPrs.length > 0
							? summarizeReleaseNotesActivity({
									projectId,
									organizationId,
									userId: triggeredByUserId,
									prodPrs,
									stagingPrs,
								})
							: Promise.resolve({
									summary: {} as ReleaseNotesSummary,
									aiUsageTokens: null,
								}),
					]);

				if (insightsSettled.status === "fulfilled") {
					const byCuid = new Map(
						insightsSettled.value.insights.map((i) => [
							i.transcriptCuid,
							i,
						]),
					);
					if (byCuid.size > 0) {
						sections.meetings = meetingItems.map((m) => {
							const insight = byCuid.get(m.transcriptCuid);
							if (!insight) {
								return m;
							}
							return {
								...m,
								decisions: insight.decisions,
								actionItems: insight.actionItems,
								openQuestions: insight.openQuestions,
							};
						});
					}
				} else {
					partialFailures.push({
						source: "meetings",
						reason: `Insight extraction failed: ${String(insightsSettled.reason)}`,
					});
				}

				if (releaseSettled.status === "fulfilled") {
					if (
						releaseSettled.value.summary.prod ||
						releaseSettled.value.summary.staging
					) {
						releaseNotesSummary = releaseSettled.value.summary;
					}
				} else {
					partialFailures.push({
						source: "releaseNotes",
						reason: `Release notes summary failed: ${String(releaseSettled.reason)}`,
					});
				}

				if (detectedSettled.status === "rejected") {
					throw detectedSettled.reason;
				}
				detected = detectedSettled.value;
			} else {
				const [insightsSettled, detectedSettled] =
					await Promise.allSettled([
						meetingItems.length > 0
							? extractMeetingInsightsActivity({
									projectId,
									organizationId,
									userId: triggeredByUserId,
									transcriptCuids: meetingItems.map(
										(m) => m.transcriptCuid,
									),
								})
							: Promise.resolve({
									insights: [],
									extractedCount: 0,
									cachedCount: 0,
								}),
						detectPriorityActionsActivity({
							projectId,
							organizationId,
						}),
					]);

				if (insightsSettled.status === "fulfilled") {
					const byCuid = new Map(
						insightsSettled.value.insights.map((i) => [
							i.transcriptCuid,
							i,
						]),
					);
					if (byCuid.size > 0) {
						sections.meetings = meetingItems.map((m) => {
							const insight = byCuid.get(m.transcriptCuid);
							if (!insight) {
								return m;
							}
							return {
								...m,
								decisions: insight.decisions,
								actionItems: insight.actionItems,
								openQuestions: insight.openQuestions,
							};
						});
					}
				} else {
					partialFailures.push({
						source: "meetings",
						reason: `Insight extraction failed: ${String(insightsSettled.reason)}`,
					});
				}

				if (detectedSettled.status === "rejected") {
					// Priority detection has no recoverable fallback — let the outer
					// catch persist FAILED and mark the run failed in Temporal.
					throw detectedSettled.reason;
				}
				detected = detectedSettled.value;
			}
		} else {
			// Pre-v2 replay path: skip insights, just detect priority actions.
			progress.phase = "detecting_priority";
			progress.message = "Detecting priority actions";
			detected = await detectPriorityActionsActivity({
				projectId,
				organizationId,
			});
		}

		if (cancelled) {
			await persistDailyBriefActivity({
				briefId,
				status: "FAILED",
				content: null,
				errorMessage: "Cancelled during insight extraction",
			});
			return { success: false, status: "CANCELLED" };
		}

		progress.phase = "detecting_priority";
		progress.message = "Ranking priority actions";
		// KIND_ORDER must stay in sync with KIND_SORT_ORDER in detect-priority-actions.ts;
		// the workflow sandbox cannot import the sortPriorityActions helper at runtime.
		const KIND_ORDER: Record<string, number> = {
			security_findings: 0,
			blocker: 1,
			decisions_proposed: 2,
			story_stale: 3,
			due_date_risk: 4,
			missing_ownership: 5,
			pr_review_stale: 6,
			unresolved_dependency: 7,
		};
		const priorityActions: PriorityAction[] = [
			...detected,
			...stalePrActions,
		].sort(
			(a, b) => (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99),
		);

		if (cancelled) {
			await persistDailyBriefActivity({
				briefId,
				status: "FAILED",
				content: null,
				errorMessage: "Cancelled during priority detection",
			});
			return { success: false, status: "CANCELLED" };
		}

		progress.phase = "summarizing";
		progress.message = "Writing executive summary";

		const summary = await summarizeDailyBriefActivity({
			projectId,
			organizationId,
			userId: triggeredByUserId,
			timeWindowStart: start,
			timeWindowEnd: end,
			sections: sections as any,
			priorityActions,
			partialFailures,
			ahead,
		});

		const anchorV5 = patched("daily-brief-v5-prod-release-anchor");
		const { status: finalStatus, content: finalContent } =
			assembleFinalBrief({
				anchorV5,
				summaryContent: summary.content,
				deploymentsError,
				latestProdRelease: applied.latestProdRelease,
				latestProdReleasesByRepo: applied.latestProdReleasesByRepo,
				releaseNotesSummary,
			});

		// v6 freshness/convergence — if a hide/unhide landed after this run loaded
		// exclusions, the brief we're about to persist would miss it. Re-check the
		// live set and `continueAsNew` cleanly instead of persisting a stale brief.
		// continueAsNew keeps the SAME workflowId, so the regenerate in-flight guard
		// still holds and the chain is bounded by MAX_REGEN_CHAIN. It throws a
		// `ContinueAsNew` control-flow error that the outer catch MUST rethrow (see
		// below) — otherwise the self-rerun would be persisted as a FAILED brief.
		const MAX_REGEN_CHAIN = 5; // runaway safety-net; a legit convergence needs 0–1 reruns
		if (exclusionsV6 && regenChainDepth < MAX_REGEN_CHAIN) {
			const latest = await loadReleaseNoteExclusionsActivity({
				projectId,
				organizationId,
			});
			if (exclusionSignature(latest) !== appliedExclusionSig) {
				await continueAsNew<typeof generateDailyBriefWorkflow>({
					...input,
					regenChainDepth: regenChainDepth + 1,
				});
			}
		} else if (exclusionsV6) {
			// regenChainDepth >= MAX_REGEN_CHAIN — do not re-check. Log so a
			// hammering curator or a signature bug is visible rather than silently
			// persisting a brief that lags the latest hide (see the honest-scope
			// note in the spec). Any subsequent hide OR the manual "Regenerate"
			// control is the documented ultimate fallback.
			log.warn(
				"[Daily Brief] Exclusion convergence cap reached; persisting without a freshness re-check",
				{ briefId, regenChainDepth },
			);
		}

		progress.phase = "persisting";
		progress.message = "Saving brief";

		await persistDailyBriefActivity({
			briefId,
			status: finalStatus,
			content: finalContent,
			aiUsageTokens: summary.aiUsageTokens,
		});

		progress.phase = "complete";
		progress.message = "Daily Brief ready";

		return { success: true, status: finalStatus };
	} catch (error) {
		// CRITICAL — `continueAsNew()` (v6 freshness rerun) and Temporal
		// cancellation both surface as control-flow errors that MUST reach the
		// runtime untouched. Persisting FAILED here would convert a clean
		// self-rerun (or a cancellation) into a spurious FAILED brief, silently
		// dropping the exclusion the rerun exists to apply. Rethrow them BEFORE
		// any persist / re-wrap.
		if (error instanceof ContinueAsNew) {
			throw error;
		}
		if (error instanceof CancelledFailure) {
			throw error;
		}
		const errMsg = error instanceof Error ? error.message : String(error);
		progress.phase = "failed";
		progress.message = "Daily Brief generation failed";
		progress.error = errMsg;

		log.error("[Daily Brief] Workflow failed", { briefId, error: errMsg });

		try {
			await persistDailyBriefActivity({
				briefId,
				status: "FAILED",
				content: null,
				errorMessage: errMsg,
			});
		} catch (persistErr) {
			log.error("[Daily Brief] Persist-on-failure also failed", {
				briefId,
				error: String(persistErr),
			});
		}

		// Throw after persisting so Temporal marks the run Failed.
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			errMsg,
			"DAILY_BRIEF_GENERATION_FAILED",
		);
	}
}
