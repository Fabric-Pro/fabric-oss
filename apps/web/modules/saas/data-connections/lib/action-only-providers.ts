/**
 * Action-Only Provider Catalog
 *
 * Some workflow/action integrations have no `DataConnectionProvider` enum
 * value and no sync connector -- they exist purely as an action plugin
 * (see `@saas/workflows/lib/plugins`). They still need to show up on the
 * integrations catalog page so they're discoverable, so each one names the
 * `PROVIDER_CATEGORIES` group its card is shown in.
 *
 * This file lists those entries and resolves their display metadata from
 * the plugin registry -- nothing is duplicated here.
 */

import {
	getIntegration,
	type IntegrationType,
} from "@saas/workflows/lib/plugins";
import type { PROVIDER_CATEGORIES } from "./providers";

export const ACTION_ONLY_PROVIDERS: ReadonlyArray<{
	type: IntegrationType;
	keywords: string[];
	/** Catalog group the card is shown in. */
	category: (typeof PROVIDER_CATEGORIES)[number]["id"];
}> = [
	{
		type: "DATABRICKS_VECTOR_SEARCH",
		keywords: ["databricks", "vector search", "rag", "embeddings", "index"],
		category: "knowledge-docs",
	},
];

/** Resolves the plugin backing an action-only catalog entry. */
export function getActionOnlyProviderPlugin(type: IntegrationType) {
	return getIntegration(type);
}
