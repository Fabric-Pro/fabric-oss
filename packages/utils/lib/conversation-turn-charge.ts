/** Cache hits consume less of an answer allowance so cached history can stay useful. */
export const CACHE_READ_CHARGE_WEIGHT = 0.1;

/** Raw input includes writes and reads; only a reported cache-read bucket is discounted. */
export function chargedConversationInputTokens(
	inputTokens: number,
	cacheReadTokens?: number | null,
): number {
	const reads =
		typeof cacheReadTokens === "number" && Number.isFinite(cacheReadTokens)
			? Math.min(inputTokens, Math.max(0, Math.floor(cacheReadTokens)))
			: 0;
	return inputTokens - reads + Math.ceil(CACHE_READ_CHARGE_WEIGHT * reads);
}
