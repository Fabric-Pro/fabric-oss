import type { TenantContext } from "@repo/rag/lib/embedding/types";

/**
 * Embeddings made to index or search tools are tool-search spend unless the
 * caller already named a feature, so the catalogue's re-index is not an
 * untagged AI Usage row.
 */
export function toolSearchUsage(context: TenantContext): TenantContext {
	return { ...context, featureKey: context.featureKey ?? "tool-search" };
}
