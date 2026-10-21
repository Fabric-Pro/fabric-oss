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
import {
	fetchGatewayGenerationCostUsd,
	getGatewayApiKey,
	resolveProviderApiKey,
} from "@repo/ai";
import {
	applyActualGatewayCost,
	getGatewayCostLookupCredentials,
	getPendingGatewayCostRows,
	type PendingGatewayCostRow,
} from "@repo/database";
import { heartbeat, log } from "@temporalio/activity";

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
	/** Pending rows exist but none has a key to look its cost up with. */
	skippedNoKey: boolean;
}

// Gateway lookups are independent network calls; run a few at a time so a large
// backlog clears fast without hammering the gateway API.
const LOOKUP_CONCURRENCY = 8;

/**
 * The key each row's cost is looked up with: the key of the provider config
 * that made the call (a generation is visible only to the gateway account that
 * ran it), or the platform key for a call made without one. A config whose key
 * cannot be read leaves its rows without a key, and they keep their estimate.
 */
async function lookupKeysFor(
	rows: readonly PendingGatewayCostRow[],
): Promise<Map<string | null, string | undefined>> {
	const configIds = [
		...new Set(
			rows.flatMap((row) =>
				row.providerConfigId ? [row.providerConfigId] : [],
			),
		),
	];
	const credentials = await getGatewayCostLookupCredentials(configIds);
	const keys = new Map<string | null, string | undefined>([
		[null, getGatewayApiKey()],
	]);
	await Promise.all(
		configIds.map(async (configId) => {
			const credential = credentials.get(configId);
			keys.set(
				configId,
				credential
					? await resolveProviderApiKey(credential).catch((error) => {
							log.warn(
								"[AiCostReconciliation] Provider key unreadable",
								{
									configId,
									error:
										error instanceof Error
											? error.message
											: String(error),
								},
							);
							return undefined;
						})
					: undefined,
			);
		}),
	);
	return keys;
}

export async function reconcileGatewayCosts(
	input: ReconcileGatewayCostsInput,
): Promise<ReconcileGatewayCostsResult> {
	const rows = await getPendingGatewayCostRows({
		windowMs: input.windowMs,
		limit: input.batchLimit,
	});
	const keys = await lookupKeysFor(rows);
	const keyed = rows.flatMap((row) => {
		const apiKey = keys.get(row.providerConfigId);
		return apiKey ? [{ row, apiKey }] : [];
	});
	if (rows.length > 0 && keyed.length === 0) {
		return {
			scanned: rows.length,
			reconciled: 0,
			pending: 0,
			skippedNoKey: true,
		};
	}

	let reconciled = 0;
	let pending = 0;

	for (let i = 0; i < keyed.length; i += LOOKUP_CONCURRENCY) {
		heartbeat(`reconcile: ${i}/${keyed.length}`);
		const slice = keyed.slice(i, i + LOOKUP_CONCURRENCY);
		const outcomes = await Promise.all(
			slice.map(async ({ row, apiKey }) => {
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
