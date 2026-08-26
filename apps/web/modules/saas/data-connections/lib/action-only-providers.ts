/**
 * Action-Only Provider Catalog
 *
 * Some workflow/action integrations have no `DataConnectionProvider` enum
 * value and no sync connector -- they exist purely as an action plugin
 * (see `@saas/workflows/lib/plugins`). They still need to show up on the
 * integrations catalog page so they're discoverable, but they can't flow
 * through the `PROVIDER_CATEGORIES` grid built from `DataConnectionProvider`.
 *
 * This file lists those entries and resolves their display metadata from
 * the plugin registry -- nothing is duplicated here.
 */

import {
	getIntegration,
	type IntegrationType,
} from "@saas/workflows/lib/plugins";

export const ACTION_ONLY_PROVIDERS: ReadonlyArray<{
	type: IntegrationType;
	keywords: string[];
}> = [
	{
		type: "DATABRICKS_VECTOR_SEARCH",
		keywords: ["databricks", "vector search", "rag", "embeddings", "index"],
	},
];

/** Resolves the plugin backing an action-only catalog entry. */
export function getActionOnlyProviderPlugin(type: IntegrationType) {
	return getIntegration(type);
}
