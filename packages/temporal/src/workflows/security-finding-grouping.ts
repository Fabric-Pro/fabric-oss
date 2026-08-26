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
const { proposeThemeActivity } = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

/** Bounded concurrency for per-theme drafting (workflow-level — see header). */
const GROUPING_CONCURRENCY = 3;

export interface SecurityFindingGroupingInput {
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
}

export async function securityFindingGroupingWorkflow(
	input: SecurityFindingGroupingInput,
): Promise<SecurityFindingGroupingOutput> {
	const { groupingId, projectId, userId, organizationId } = input;

	try {
		await markGroupingRunningActivity({ groupingId });

		// No special-case branch for "no scan yet" / "zero eligible findings":
		// `gathered.themes` is simply empty, the loop runs zero iterations, and
		// persistGroupingProposalsActivity is still called with empty proposals —
		// the same "graceful empty" AWAITING_REVIEW outcome.
		const gathered = await gatherEligibleFindingsActivity({ projectId });

		const proposedCreate: GroupingProposalCreate[] = [];
		const proposedUpdate: GroupingProposalUpdate[] = [];
		const declinedThemes: GroupingProposalCreate[] = [];
		const skippedThemes: GroupingSkippedTheme[] = [];
		// Overflow themes (beyond the cap) are already shaped as failed — seed the
		// list with them; they never reach proposeThemeActivity.
		const failedThemes: GroupingFailedTheme[] = [
			...gathered.overflowThemes,
		];

		let modelName: string | null = null;
		let inputTokens = 0;
		let outputTokens = 0;

		for (
			let batchStart = 0;
			batchStart < gathered.themes.length;
			batchStart += GROUPING_CONCURRENCY
		) {
			const batch = gathered.themes.slice(
				batchStart,
				batchStart + GROUPING_CONCURRENCY,
			);
			const settled = await Promise.allSettled(
				batch.map((theme) =>
					proposeThemeActivity({
						theme,
						projectId,
						userId,
						organizationId,
						scanCompletedAt: gathered.scanCompletedAt,
					}),
				),
			);

			for (let i = 0; i < settled.length; i++) {
				const outcome = settled[i];
				const theme = batch[i];

				// Any rejection (after retries) is caught HERE and recorded into
				// failedThemes; the loop always continues — one theme's failure
				// never aborts the run.
				if (outcome.status === "rejected") {
					const reason =
						outcome.reason instanceof Error
							? outcome.reason.message
							: String(outcome.reason);
					failedThemes.push({
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
						failedThemes.push(result.failed);
						break;
				}
			}
		}

		const persisted = await persistGroupingProposalsActivity({
			groupingId,
			proposedCreate,
			proposedUpdate,
			declinedThemes,
			skippedThemes,
			failedThemes,
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
