/**
 * Firecrawl Search Step
 * Searches the web using Firecrawl API
 *
 * Uses the unified search providers configuration from UserSearchProvider/OrganizationSearchProvider
 */

import type { NodeExecutionResult, StepParams } from "../../types";
import { connectorErrorMessage } from "../connector-error";
import { getFirecrawlApiKey } from "../firecrawl-credentials";
import { interpolateTemplate } from "./utils";

export async function executeFirecrawlSearchStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query, limit = 5 } = params.nodeConfig as {
		query?: string;
		limit?: number | string;
	};

	if (!query) {
		return { success: false, error: "Query is required" };
	}

	const resultLimit = Number(limit);
	if (!Number.isInteger(resultLimit) || resultLimit < 1) {
		return {
			success: false,
			error: "Search limit must be a positive integer",
		};
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
			body: JSON.stringify({
				query: interpolatedQuery,
				limit: resultLimit,
			}),
		});

		const result = await response.json();
		if (!response.ok || result.success !== true) {
			return {
				success: false,
				error: connectorErrorMessage(
					result.error || result,
					`Firecrawl returned status ${response.status}`,
				),
			};
		}
		if (!Array.isArray(result.data)) {
			return {
				success: false,
				error: "Firecrawl returned an invalid search result",
			};
		}
		const results = result.data;
		return {
			success: true,
			output: {
				results,
				// Declared in outputFields, so the UI offers it for
				// autocomplete — it has to actually be here.
				count: Array.isArray(results) ? results.length : 0,
			},
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
