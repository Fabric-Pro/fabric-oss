/**
 * Reconcile Vercel-gateway AI usage rows from the insert-time estimate to the
 * provider's ACTUAL billed cost.
 *
 * Each gateway call is logged immediately with a cache-aware estimate + its
 * `gatewayGenerationId`. This activity (driven by `reconcileAiGatewayCostWorkflow`
 * every few minutes) reads the pending rows, fetches the real `total_cost` from
 * the gateway (`GET /v1/generation`), and writes it back — flipping the row to
 * actual. A row whose cost isn't available yet stays pending for the next sweep.
 */
import { fetchGatewayGenerationCostUsd, getGatewayApiKey } from "@repo/ai";
import {
	applyActualGatewayCost,
	getPendingGatewayCostRows,
} from "@repo/database";
import { heartbeat } from "@temporalio/activity";

export interface ReconcileGatewayCostsInput {
	/** Only rows created within this window are swept (older ones keep the estimate). */
	windowMs: number;
	/** Max rows per pass. */
	batchLimit: number;
}

export interface ReconcileGatewayCostsResult {
	scanned: number;
	reconciled: number;
	/** Looked up but the gateway cost isn't available yet — retried next sweep. */
	pending: number;
	/** No gateway API key configured; nothing to do. */
	skippedNoKey: boolean;
}

// Gateway lookups are independent network calls; run a few at a time so a large
// backlog clears fast without hammering the gateway API.
const LOOKUP_CONCURRENCY = 8;

export async function reconcileGatewayCosts(
	input: ReconcileGatewayCostsInput,
): Promise<ReconcileGatewayCostsResult> {
	const apiKey = getGatewayApiKey();
	if (!apiKey) {
		return { scanned: 0, reconciled: 0, pending: 0, skippedNoKey: true };
	}

	const rows = await getPendingGatewayCostRows({
		windowMs: input.windowMs,
		limit: input.batchLimit,
	});

	let reconciled = 0;
	let pending = 0;

	for (let i = 0; i < rows.length; i += LOOKUP_CONCURRENCY) {
		heartbeat(`reconcile: ${i}/${rows.length}`);
		const slice = rows.slice(i, i + LOOKUP_CONCURRENCY);
		const outcomes = await Promise.all(
			slice.map(async (row) => {
				const costUsd = await fetchGatewayGenerationCostUsd(
					row.gatewayGenerationId,
					apiKey,
				);
				if (costUsd === null) {
					return "pending" as const;
				}
				const applied = await applyActualGatewayCost({
					id: row.id,
					actualCostUsd: costUsd,
				});
				return applied ? ("reconciled" as const) : ("skipped" as const);
			}),
		);
		for (const outcome of outcomes) {
			if (outcome === "reconciled") {
				reconciled += 1;
			} else if (outcome === "pending") {
				pending += 1;
			}
		}
	}

	return { scanned: rows.length, reconciled, pending, skippedNoKey: false };
}
