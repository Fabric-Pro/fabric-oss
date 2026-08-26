/**
 * Perplexity Search Step
 * Performs AI-powered search using Perplexity API
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executePerplexitySearchStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		query,
		model = "llama-3.1-sonar-small-128k-online",
		searchRecency,
		systemPrompt,
	} = params.nodeConfig as {
		query?: string;
		model?: string;
		searchRecency?: string;
		systemPrompt?: string;
	};

	if (!query) {
		return { success: false, error: "Query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"PERPLEXITY",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.PERPLEXITY_API_KEY) {
		return {
			success: false,
			error: "Perplexity API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedQuery = interpolateTemplate(query, params.inputs);
	const interpolatedSystem = systemPrompt
		? interpolateTemplate(systemPrompt, params.inputs)
		: undefined;

	try {
		const requestBody: Record<string, unknown> = {
			model,
			messages: [
				...(interpolatedSystem
					? [{ role: "system", content: interpolatedSystem }]
					: []),
				{ role: "user", content: interpolatedQuery },
			],
		};

		// "any" or empty string means no filter - only add if a specific recency is selected
		if (searchRecency && searchRecency !== "any" && searchRecency !== "") {
			requestBody.search_recency_filter = searchRecency;
		}

		const response = await fetch(
			"https://api.perplexity.ai/chat/completions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.PERPLEXITY_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
			},
		);

		const result = await response.json();

		if (!response.ok) {
			return {
				success: false,
				error: result.error?.message || `HTTP ${response.status}`,
			};
		}

		const answer = result.choices?.[0]?.message?.content;
		const citations = result.citations || [];

		return {
			success: true,
			output: { answer, citations, model: result.model },
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Perplexity search failed",
		};
	}
}
