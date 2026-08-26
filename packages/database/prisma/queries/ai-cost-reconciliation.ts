/**
 * Actual-cost reconciliation for Vercel-gateway AI usage rows.
 *
 * A gateway call is logged immediately with a cache-aware ESTIMATE plus its
 * `gatewayGenerationId`. Shortly after, the gateway exposes the real billed
 * `total_cost` (see @repo/ai `fetchGatewayGenerationCostUsd`); a periodic sweep
 * reads the pending rows here and writes that actual figure back, flipping
 * `costIsActual` to true. The displayed/logged cost then reflects real spend.
 *
 * Scope note: this reconciles the LOG row's cost (what the usage dashboards sum).
 * The tenant credit accumulator + usage-limit counters keep the insert-time
 * estimate (they gate throttling, for which the cache-aware estimate is close);
 * adjusting those by the reconciliation delta is a separate refinement.
 */
import { db } from "../client";

export interface PendingGatewayCostRow {
	id: string;
	gatewayGenerationId: string;
}

/**
 * Gateway rows still holding an estimate: `costIsActual=false` AND a
 * `gatewayGenerationId`, bounded to a recent window so the sweep stays cheap and
 * rows whose lookup never resolved are eventually left with their estimate.
 */
export async function getPendingGatewayCostRows(params: {
	windowMs: number;
	limit: number;
}): Promise<PendingGatewayCostRow[]> {
	const cutoff = new Date(Date.now() - params.windowMs);
	const rows = await db.aiUsageLog.findMany({
		where: {
			costIsActual: false,
			gatewayGenerationId: { not: null },
			createdAt: { gte: cutoff },
		},
		select: { id: true, gatewayGenerationId: true },
		orderBy: { createdAt: "asc" },
		take: params.limit,
	});
	return rows.filter(
		(r): r is PendingGatewayCostRow => r.gatewayGenerationId !== null,
	);
}

/**
 * Write the provider's actual billed cost onto a usage row and flip it to
 * actual. Idempotent + race-safe: the `costIsActual: false` guard means a second
 * sweep (or a concurrent one) never double-applies.
 */
export async function applyActualGatewayCost(params: {
	id: string;
	actualCostUsd: number;
}): Promise<boolean> {
	const costUsd = Math.max(0, params.actualCostUsd);
	const costCents = Math.round(Number((costUsd * 100).toFixed(6)));
	const costMicroUsd = Math.round(Number((costUsd * 1_000_000).toFixed(0)));
	const result = await db.aiUsageLog.updateMany({
		where: { id: params.id, costIsActual: false },
		data: { costCents, costMicroUsd, costIsActual: true },
	});
	return result.count > 0;
}
