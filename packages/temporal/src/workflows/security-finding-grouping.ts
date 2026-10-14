/**
 * Security & Accessibility finding-grouping workflow — the manually-triggered
 * "Group into tickets" PROPOSE phase.
 *
 * Orchestrates, on the general-purpose `fabric-worker` queue:
 *   markGroupingRunning → gatherEligibleFindings → proposeTheme (bounded
 *   concurrency, per-theme continue-on-error) → persistGroupingProposals
 * and ends the run at `AWAITING_REVIEW` with the proposals persisted onto the
 * run's `results` JSON. It performs NO writes — the user reviews the proposals
 * and the `scan.grouping.apply` procedure creates/updates the accepted tickets.
 *
 * Any uncaught failure routes to failGrouping so a run never hangs in
 * PENDING/RUNNING (watchdog-free: "a row stays RUNNING only if both the run and
 * the fail-write die"). No `defineSignal`/`defineQuery` — progress is polled via
 * `scan.grouping.latest`.
 *
 * Concurrency / heartbeat note: `heartbeat()` is only callable from inside
 * activity code. "Batches of N" here is workflow-level CONCURRENCY BOUNDING via
 * `Promise.allSettled` over up to `GROUPING_CONCURRENCY` concurrent
 * `proposeThemeActivity` calls (each its own Activity Execution with its own
 * heartbeat), not a loop-level heartbeat.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	GroupingFailedTheme,
	GroupingProposalCreate,
	GroupingProposalUpdate,
	GroupingSkippedTheme,
} from "../activities/security-scan/grouping-activities";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";
import {
	type BulkRunInputExtras,
	claimBulkRunResume,
	pauseBulkRun,
} from "./lib/bulk-run-pause";
import {
	BULK_RUN_PAUSE_BEYOND_MS,
	type ChatGptPlanPause,
	chatGptPlanPauseOf,
	untilRunDeadline,
	withChatGptPlanWait,
} from "./lib/chatgpt-plan-wait";

// Cheap DB-only activities — retry generously.
const {
	markGroupingRunningActivity,
	gatherEligibleFindingsActivity,
	persistGroupingProposalsActivity,
	failGroupingActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// Per-theme LLM-draft activity — long timeout + heartbeat, few retries
// (cost-aware; drafting a body + title is the only LLM work).
const PROPOSE_THEME_TIMEOUT_MS = 10 * 60_000;
const { proposeThemeActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: PROPOSE_THEME_TIMEOUT_MS,
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 2,
		// A spent plan is waited out below, never retried in seconds.
		nonRetryableErrorTypes: [...AI_NON_RETRYABLE_ERROR_TYPES],
	},
});

/** Bounded concurrency for per-theme drafting (workflow-level — see header). */
const GROUPING_CONCURRENCY = 3;

/** Left after a plan wait for the persist or failure write that ends the run. */
const PERSIST_RESERVE_MS = 2 * 60_000;

/**
 * What a grouping run settled before it paused for a plan reset (Fizzy
 * #2770); the resume drafts only the themes not in `doneThemeKeys`.
 */
interface GroupingPauseProgress {
	doneThemeKeys: string[];
	proposedCreate: GroupingProposalCreate[];
	proposedUpdate: GroupingProposalUpdate[];
	declinedThemes: GroupingProposalCreate[];
	skippedThemes: GroupingSkippedTheme[];
	draftFailedThemes: GroupingFailedTheme[];
	modelName: string | null;
	inputTokens: number;
	outputTokens: number;
}

export interface SecurityFindingGroupingInput extends BulkRunInputExtras {
	groupingId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
}

export interface SecurityFindingGroupingOutput {
	success: boolean;
	proposedCreateCount: number;
	proposedUpdateCount: number;
	declinedCount: number;
	skippedCount: number;
	failedCount: number;
	error?: string;
	/** Paused for a ChatGPT plan reset; a resume run starts at `resumesAt`. */
	paused?: boolean;
	resumesAt?: string;
}

export async function securityFindingGroupingWorkflow(
	input: SecurityFindingGroupingInput,
): Promise<SecurityFindingGroupingOutput> {
	const { groupingId, projectId, userId, organizationId } = input;

	// A resume after a ChatGPT plan pause (Fizzy #2770) takes its row back
	// first, and ends quietly when a Cancel or the other resume got there.
	let resumed: GroupingPauseProgress | undefined;
	if (input.resumeOf) {
		const claim = await claimBulkRunResume<GroupingPauseProgress>(
			"SCAN_GROUPING",
			{ ...input, resumeOf: input.resumeOf },
		);
		if (!claim.claimed) {
			return {
				success: false,
				proposedCreateCount: 0,
				proposedUpdateCount: 0,
				declinedCount: 0,
				skippedCount: 0,
				failedCount: 0,
				error: "The grouping run was no longer waiting to resume.",
			};
		}
		resumed = claim.progress;
	}

	try {
		if (!input.resumeOf) {
			await markGroupingRunningActivity({ groupingId });
		}

		// No special-case branch for "no scan yet" / "zero eligible findings":
		// `gathered.themes` is simply empty, the loop runs zero iterations, and
		// persistGroupingProposalsActivity is still called with empty proposals —
		// the same "graceful empty" AWAITING_REVIEW outcome.
		const gathered = await gatherEligibleFindingsActivity({ projectId });

		const proposedCreate: GroupingProposalCreate[] = [
			...(resumed?.proposedCreate ?? []),
		];
		const proposedUpdate: GroupingProposalUpdate[] = [
			...(resumed?.proposedUpdate ?? []),
		];
		const declinedThemes: GroupingProposalCreate[] = [
			...(resumed?.declinedThemes ?? []),
		];
		const skippedThemes: GroupingSkippedTheme[] = [
			...(resumed?.skippedThemes ?? []),
		];
		// Themes whose drafting failed, kept apart from the overflow ones so a
		// pause saves only what this run produced.
		const draftFailedThemes: GroupingFailedTheme[] = [
			...(resumed?.draftFailedThemes ?? []),
		];
		// Overflow themes (beyond the cap) are already shaped as failed — seed the
		// list with them; they never reach proposeThemeActivity.
		const failedThemes: GroupingFailedTheme[] = [
			...gathered.overflowThemes,
		];

		let modelName: string | null = resumed?.modelName ?? null;
		let inputTokens = resumed?.inputTokens ?? 0;
		let outputTokens = resumed?.outputTokens ?? 0;

		// The themes a paused run already settled are not drafted again.
		const doneThemeKeys = new Set(resumed?.doneThemeKeys ?? []);
		const themes = gathered.themes.filter(
			(theme) => !doneThemeKeys.has(theme.themeKey),
		);
		let pause: ChatGptPlanPause | null = null;

		for (
			let batchStart = 0;
			batchStart < themes.length && !pause;
			batchStart += GROUPING_CONCURRENCY
		) {
			const batch = themes.slice(
				batchStart,
				batchStart + GROUPING_CONCURRENCY,
			);
			// A theme that finds every shared ChatGPT plan spent waits for
			// the reset and drafts once more (Fizzy #2770); the themes
			// already drafted are kept. Never past the run's own deadline,
			// with room left for the retry. `userId` is null: this bulk run
			// never uses the clicker's own plan, so its reset cannot help.
			const settled = await Promise.allSettled(
				batch.map((theme) =>
					withChatGptPlanWait(
						() =>
							proposeThemeActivity({
								theme,
								projectId,
								userId,
								organizationId,
								scanCompletedAt: gathered.scanCompletedAt,
							}),
						{
							organizationId,
							userId: null,
							maxWaitMs: untilRunDeadline(
								PROPOSE_THEME_TIMEOUT_MS + PERSIST_RESERVE_MS,
							),
							// A longer wait pauses the run: the themes settled
							// so far are saved, the rest drafted on resume.
							pauseBeyondMs: BULK_RUN_PAUSE_BEYOND_MS,
						},
					),
				),
			);

			for (let i = 0; i < settled.length; i++) {
				const outcome = settled[i];
				const theme = batch[i];

				const themePause =
					outcome.status === "rejected"
						? chatGptPlanPauseOf(outcome.reason)
						: null;
				if (themePause) {
					pause = themePause;
					continue;
				}
				doneThemeKeys.add(theme.themeKey);

				// Any rejection (after retries) is caught HERE and recorded into
				// failedThemes; the loop always continues — one theme's failure
				// never aborts the run.
				if (outcome.status === "rejected") {
					const reason =
						outcome.reason instanceof Error
							? outcome.reason.message
							: String(outcome.reason);
					draftFailedThemes.push({
						category: theme.category,
						ruleSource: theme.ruleSource,
						themeKey: theme.themeKey,
						findingCount: theme.findings.length,
						reason,
					});
					continue;
				}

				const result = outcome.value;
				switch (result.outcome) {
					case "create":
						proposedCreate.push(result.proposal);
						if (result.modelName) {
							modelName = result.modelName;
						}
						inputTokens += result.inputTokens;
						outputTokens += result.outputTokens;
						break;
					case "declined":
						declinedThemes.push(result.proposal);
						if (result.modelName) {
							modelName = result.modelName;
						}
						inputTokens += result.inputTokens;
						outputTokens += result.outputTokens;
						break;
					case "update":
						proposedUpdate.push(result.proposal);
						break;
					case "skip":
						skippedThemes.push(result.skipped);
						break;
					case "failed":
						draftFailedThemes.push(result.failed);
						break;
				}
			}
		}

		if (pause) {
			const progress: GroupingPauseProgress = {
				doneThemeKeys: [...doneThemeKeys],
				proposedCreate,
				proposedUpdate,
				declinedThemes,
				skippedThemes,
				draftFailedThemes,
				modelName,
				inputTokens,
				outputTokens,
			};
			const paused = await pauseBulkRun({
				kind: "SCAN_GROUPING",
				runId: groupingId,
				input,
				pause,
				progress,
			});
			return {
				success: false,
				proposedCreateCount: 0,
				proposedUpdateCount: 0,
				declinedCount: 0,
				skippedCount: 0,
				failedCount: 0,
				paused: true,
				resumesAt: paused.resumesAt,
			};
		}

		const persisted = await persistGroupingProposalsActivity({
			groupingId,
			proposedCreate,
			proposedUpdate,
			declinedThemes,
			skippedThemes,
			failedThemes: [...failedThemes, ...draftFailedThemes],
			themeCount: gathered.themes.length + gathered.overflowThemes.length,
			findingCount: gathered.findingCount,
			modelName,
			inputTokens,
			outputTokens,
		});

		return { success: true, ...persisted };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		try {
			await failGroupingActivity({ groupingId, message });
		} catch {
			// failGrouping is best-effort; the row stays RUNNING only if both the
			// run AND this fail-write die.
		}
		return {
			success: false,
			proposedCreateCount: 0,
			proposedUpdateCount: 0,
			declinedCount: 0,
			skippedCount: 0,
			failedCount: 0,
			error: message,
		};
	}
}
