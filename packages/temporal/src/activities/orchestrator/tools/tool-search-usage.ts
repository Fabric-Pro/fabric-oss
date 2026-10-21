import type { TenantContext } from "@repo/rag/lib/embedding/types";
import { withDefaultFeature } from "@repo/rag/lib/embedding/usage";

/**
 * Embeddings made to index or search tools are tool-search spend unless the
 * caller already named a feature, so the catalogue's re-index is not an
 * untagged AI Usage row.
 */
export function toolSearchUsage(context: TenantContext): TenantContext {
	return withDefaultFeature(context, "tool-search");
}
