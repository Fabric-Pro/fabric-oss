/**
 * Firecrawl Search Step
 * Searches the web using Firecrawl API
 *
 * Uses the unified search providers configuration from UserSearchProvider/OrganizationSearchProvider
 */

import { getSearchProviderConfig } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

async function getFirecrawlApiKey(
	userId: string,
	organizationId?: string,
): Promise<string | null> {
	try {
		const config = await getSearchProviderConfig({
			userId,
			organizationId,
			providerName: "firecrawl",
		});

		if (config?.encryptedApiKey) {
			return decryptApiKey(config.encryptedApiKey);
		}

		return null;
	} catch (error) {
		console.error("[Firecrawl] Error getting API key:", error);
		return null;
	}
}

export async function executeFirecrawlSearchStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query, limit = 5 } = params.nodeConfig as {
		query?: string;
		limit?: number;
	};

	if (!query) {
		return { success: false, error: "Query is required" };
	}

	const interpolatedQuery = interpolateTemplate(query, params.inputs);
	const apiKey = await getFirecrawlApiKey(
		params.userId,
		params.organizationId,
	);

	if (!apiKey) {
		return {
			success: false,
			error: "Firecrawl API key not configured. Please configure it in Settings > Search Providers.",
		};
	}

	try {
		const response = await fetch("https://api.firecrawl.dev/v1/search", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query: interpolatedQuery, limit }),
		});

		const result = await response.json();
		const results = result.data;
		return {
			success: result.success,
			output: {
				results,
				// Declared in outputFields, so the UI offers it for
				// autocomplete — it has to actually be here.
				count: Array.isArray(results) ? results.length : 0,
			},
			error: result.success ? undefined : result.error,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Firecrawl search failed",
		};
	}
}
