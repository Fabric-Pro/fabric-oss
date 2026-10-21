import type { AiFeatureKey } from "@repo/ai";
import type { TenantContext } from "./types";

/**
 * The tenant context with `featureKey` defaulted for a shared embedding path.
 * A feature the caller already named wins, so a library function that serves
 * several features never relabels its caller's spend; it only stops the row
 * landing in AI Usage with no feature at all.
 */
export function withDefaultFeature(
	context: TenantContext | undefined,
	featureKey: AiFeatureKey,
): TenantContext {
	return { ...context, featureKey: context?.featureKey ?? featureKey };
}
