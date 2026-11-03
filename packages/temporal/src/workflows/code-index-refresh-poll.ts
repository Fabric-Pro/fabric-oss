/**
 * Scheduled code index refresh: the poll (spec 2026-10-29 code-index-sync).
 *
 * The `code-index-refresh-poll` schedule starts this every 15 minutes with
 * overlap SKIP. It claims the repository indexes whose next check is due
 * (claiming moves each one a full interval ahead, so a failed check waits
 * for its next interval instead of looping) and asks the web app to check
 * each, a few at a time. A check compares the indexed commit with the branch
 * HEAD and starts an incremental run for the changed files only.
 *
 * One check failing never stops the others; the outcomes are counted.
 */
import { log, proxyActivities } from "@temporalio/workflow";
import type * as refreshActivities from "../activities/code-index-refresh";

/** Indexes checked per tick; the rest stay due for the next tick. */
export const CODE_INDEX_REFRESH_CLAIM_LIMIT = 50;
const CONCURRENCY = 4;

const { claimDueCodeIndexRefreshesActivity } = proxyActivities<
	typeof refreshActivities
>({
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 3 },
});

const { requestCodeIndexRefreshActivity } = proxyActivities<
	typeof refreshActivities
>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		maximumAttempts: 3,
		nonRetryableErrorTypes: ["CodeIndexRefreshRejected"],
	},
});

export interface CodeIndexRefreshPollResult {
	claimed: number;
	outcomes: Record<string, number>;
	failed: number;
}

export async function codeIndexRefreshPollWorkflow(): Promise<CodeIndexRefreshPollResult> {
	const ids = await claimDueCodeIndexRefreshesActivity({
		limit: CODE_INDEX_REFRESH_CLAIM_LIMIT,
	});
	const result: CodeIndexRefreshPollResult = {
		claimed: ids.length,
		outcomes: {},
		failed: 0,
	};
	for (let i = 0; i < ids.length; i += CONCURRENCY) {
		const batch = ids.slice(i, i + CONCURRENCY);
		const settled = await Promise.all(
			batch.map((codeIndexId) =>
				requestCodeIndexRefreshActivity({ codeIndexId }).then(
					(r) => r.outcome,
					(error: unknown) => {
						log.warn("code index refresh check failed", {
							codeIndexId,
							error:
								error instanceof Error
									? error.message
									: String(error),
						});
						return null;
					},
				),
			),
		);
		for (const outcome of settled) {
			if (outcome === null) {
				result.failed++;
			} else {
				result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
			}
		}
	}
	return result;
}
