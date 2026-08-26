/**
 * reconcileAiGatewayCostWorkflow.
 *
 * Every few minutes, flips recent Vercel-gateway AI usage rows from their
 * insert-time estimate to the provider's actual billed cost (see the
 * `reconcileGatewayCosts` activity). Runs via a Temporal Schedule; the sleep +
 * continueAsNew is defense-in-depth so it keeps sweeping even if the Schedule
 * fails to spawn a fresh run (the Schedule uses overlap=SKIP, so it never
 * duplicates this self-loop).
 */
import {
	continueAsNew,
	log,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import type * as activities from "../activities/ai-cost-reconciliation";

const { reconcileGatewayCosts } = proxyActivities<typeof activities>({
	startToCloseTimeout: "5m",
	retry: { initialInterval: "30s", maximumAttempts: 3 },
});

export interface ReconcileAiGatewayCostInput {
	/** Only reconcile rows created within this window (ms). Default 6h. */
	windowMs?: number;
	/** Max rows per pass. Default 500. */
	batchLimit?: number;
}

const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_LIMIT = 500;

export async function reconcileAiGatewayCostWorkflow(
	input: ReconcileAiGatewayCostInput = {},
): Promise<void> {
	const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
	const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;

	try {
		const result = await reconcileGatewayCosts({ windowMs, batchLimit });
		log.info("reconcileAiGatewayCostWorkflow completed one pass", {
			...result,
		});
	} catch (err) {
		log.warn("reconcileAiGatewayCostWorkflow pass failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}

	// The gateway's total_cost lands ~1-2 min after a call; sweep frequently.
	await sleep("5m");
	await continueAsNew<typeof reconcileAiGatewayCostWorkflow>({
		windowMs,
		batchLimit,
	});
}
