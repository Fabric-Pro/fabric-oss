/**
 * Fetch the ACTUAL billed cost of a Vercel AI Gateway generation.
 *
 * The gateway stamps each response with a `generationId`
 * (providerMetadata.gateway.generationId). Its real billed cost — `total_cost`
 * in USD, including surcharges — becomes available shortly AFTER the call via
 * `GET /v1/generation?id=<id>`. This is the source of truth for gateway spend;
 * the estimate is only the immediate placeholder until this lands.
 *
 * Returns `null` when the cost is not (yet) available or on any error — the
 * caller keeps the estimate and may retry on a later reconciliation sweep. Never
 * throws.
 *
 * Uses the platform gateway key (`AI_GATEWAY_API_KEY`); a generation made with a
 * tenant's own BYOK key cannot be looked up with the platform key and stays an
 * estimate.
 */

const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export function getGatewayApiKey(): string | undefined {
	return (
		process.env.AI_GATEWAY_API_KEY || process.env.AI_GATEWAY || undefined
	);
}

export async function fetchGatewayGenerationCostUsd(
	generationId: string,
	apiKey: string,
	opts?: { baseUrl?: string; signal?: AbortSignal },
): Promise<number | null> {
	const baseUrl = opts?.baseUrl ?? DEFAULT_GATEWAY_BASE_URL;
	try {
		const res = await fetch(
			`${baseUrl}/generation?id=${encodeURIComponent(generationId)}`,
			{
				headers: { Authorization: `Bearer ${apiKey}` },
				signal: opts?.signal,
			},
		);
		// 404 = not yet available (the row stays pending for a later sweep); any
		// other non-2xx is treated the same — keep the estimate.
		if (!res.ok) {
			return null;
		}
		const body = (await res.json()) as { total_cost?: unknown };
		const cost =
			typeof body.total_cost === "number"
				? body.total_cost
				: Number(body.total_cost);
		return Number.isFinite(cost) && cost >= 0 ? cost : null;
	} catch {
		return null;
	}
}
