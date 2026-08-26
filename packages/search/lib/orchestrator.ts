/**
 * Search Orchestrator
 *
 * Orchestrates search operations across multiple providers with:
 * - Fallback chains (try next provider on failure)
 * - Parallel execution for speed
 * - Result merging and deduplication
 * - Progress tracking for deep research
 *
 * Inspired by Scira's search strategy pattern.
 */

import { logger } from "@repo/logs";
import { createProvidersFromConfig } from "./providers";
import type { BaseSearchProvider } from "./providers/base";
import type {
	ProviderConfig,
	ResearchPlan,
	ResearchPlanStep,
	SearchOptions,
	SearchResponse,
	SearchResult,
} from "./types";

/**
 * Search execution strategy
 */
export type SearchStrategy =
	| "fallback" // Try providers in order until one succeeds
	| "parallel" // Execute all providers in parallel and merge results
	| "fastest"; // Race providers and return first successful response

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
	/** Provider configurations */
	providers: ProviderConfig[];
	/** Execution strategy */
	strategy?: SearchStrategy;
	/** Timeout per provider (ms) */
	timeoutMs?: number;
	/** Maximum retries per provider */
	maxRetries?: number;
	/** Whether to include failed provider errors in response */
	includeErrors?: boolean;
}

/**
 * Enhanced search response with provider details
 */
export interface OrchestratedSearchResponse extends SearchResponse {
	/** Providers that were tried */
	providersTried: string[];
	/** Providers that failed with errors */
	providerErrors?: Record<string, string>;
	/** Strategy used */
	strategyUsed: SearchStrategy;
}

/**
 * Progress callback for research operations
 */
export type ResearchProgressCallback = (
	step: ResearchPlanStep,
	results: SearchResult[],
	progress: number,
) => void;

/**
 * Search Orchestrator class
 */
export class SearchOrchestrator {
	private providers: BaseSearchProvider[];
	private strategy: SearchStrategy;
	private timeoutMs: number;
	private maxRetries: number;
	private includeErrors: boolean;

	constructor(config: OrchestratorConfig) {
		this.providers = createProvidersFromConfig(config.providers);
		this.strategy = config.strategy ?? "fallback";
		this.timeoutMs = config.timeoutMs ?? 30000;
		this.maxRetries = config.maxRetries ?? 2;
		this.includeErrors = config.includeErrors ?? false;
	}

	/**
	 * Execute a search with the configured strategy
	 */
	async search(
		query: string,
		options?: SearchOptions,
	): Promise<OrchestratedSearchResponse> {
		if (this.providers.length === 0) {
			return {
				results: [],
				providerUsed: "none",
				searchTime: 0,
				providersTried: [],
				strategyUsed: this.strategy,
				warnings: ["No search providers configured"],
			};
		}

		switch (this.strategy) {
			case "parallel":
				return this.executeParallel(query, options);
			case "fastest":
				return this.executeFastest(query, options);
			default:
				return this.executeFallback(query, options);
		}
	}

	/**
	 * Execute multi-query search (for deep research)
	 */
	async multiSearch(
		queries: string[],
		options?: SearchOptions,
	): Promise<OrchestratedSearchResponse> {
		const startTime = Date.now();
		const allResults: SearchResult[] = [];
		const seenUrls = new Set<string>();
		const providersTried: string[] = [];
		const providerErrors: Record<string, string> = {};

		// Execute all queries in parallel
		const queryPromises = queries.map((query) =>
			this.search(query, options),
		);
		const responses = await Promise.allSettled(queryPromises);

		for (const response of responses) {
			if (response.status === "fulfilled") {
				const result = response.value;
				providersTried.push(...result.providersTried);

				for (const r of result.results) {
					if (!seenUrls.has(r.url)) {
						seenUrls.add(r.url);
						allResults.push(r);
					}
				}

				if (result.providerErrors) {
					Object.assign(providerErrors, result.providerErrors);
				}
			}
		}

		// Sort by score and limit
		allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
		const maxResults = options?.maxResults ?? 20;
		const limitedResults = allResults.slice(0, maxResults);

		return {
			results: limitedResults,
			providerUsed: providersTried[0] ?? "none",
			searchTime: Date.now() - startTime,
			totalResults: allResults.length,
			hasMore: allResults.length > maxResults,
			providersTried: [...new Set(providersTried)],
			providerErrors: this.includeErrors ? providerErrors : undefined,
			strategyUsed: this.strategy,
		};
	}

	/**
	 * Execute deep research with progress tracking
	 */
	async executeResearch(
		plan: ResearchPlan,
		options?: SearchOptions,
		onProgress?: ResearchProgressCallback,
	): Promise<OrchestratedSearchResponse> {
		const startTime = Date.now();
		const allResults: SearchResult[] = [];
		const seenUrls = new Set<string>();
		const providersTried: string[] = [];
		const providerErrors: Record<string, string> = {};

		let completedSteps = 0;

		for (const step of plan.steps) {
			step.status = "in_progress";

			try {
				// Execute all queries for this step
				const response = await this.multiSearch(step.queries, options);

				providersTried.push(...response.providersTried);
				if (response.providerErrors) {
					Object.assign(providerErrors, response.providerErrors);
				}

				// Collect unique results
				for (const r of response.results) {
					if (!seenUrls.has(r.url)) {
						seenUrls.add(r.url);
						allResults.push(r);
					}
				}

				step.status = "completed";
				completedSteps++;

				// Report progress
				const progress = Math.round(
					(completedSteps / plan.steps.length) * 100,
				);
				if (onProgress) {
					onProgress(step, response.results, progress);
				}
			} catch (error) {
				step.status = "failed";
				logger.error("[SearchOrchestrator] Research step failed:", {
					step: step.step,
					error,
				});
			}
		}

		// Sort by relevance and limit
		allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

		return {
			results: allResults,
			providerUsed: providersTried[0] ?? "none",
			searchTime: Date.now() - startTime,
			totalResults: allResults.length,
			providersTried: [...new Set(providersTried)],
			providerErrors: this.includeErrors ? providerErrors : undefined,
			strategyUsed: this.strategy,
		};
	}

	/**
	 * Fallback strategy: try providers in order until one succeeds
	 */
	private async executeFallback(
		query: string,
		options?: SearchOptions,
	): Promise<OrchestratedSearchResponse> {
		const startTime = Date.now();
		const providersTried: string[] = [];
		const providerErrors: Record<string, string> = {};

		for (const provider of this.providers) {
			providersTried.push(provider.name);

			for (let attempt = 0; attempt < this.maxRetries; attempt++) {
				try {
					const result = await this.executeWithTimeout(
						() => provider.search(query, options),
						this.timeoutMs,
					);

					return {
						...result,
						providersTried,
						providerErrors: this.includeErrors
							? providerErrors
							: undefined,
						strategyUsed: "fallback",
					};
				} catch (error) {
					const errorMsg =
						error instanceof Error
							? error.message
							: "Unknown error";
					providerErrors[provider.name] = errorMsg;

					logger.warn(
						`[SearchOrchestrator] Provider ${provider.name} failed (attempt ${attempt + 1}):`,
						errorMsg,
					);

					// Only retry on certain errors
					if (!this.isRetryableError(error)) {
						break;
					}
				}
			}
		}

		// All providers failed
		return {
			results: [],
			providerUsed: "none",
			searchTime: Date.now() - startTime,
			providersTried,
			providerErrors: this.includeErrors ? providerErrors : undefined,
			strategyUsed: "fallback",
			warnings: ["All search providers failed"],
		};
	}

	/**
	 * Parallel strategy: execute all providers and merge results
	 */
	private async executeParallel(
		query: string,
		options?: SearchOptions,
	): Promise<OrchestratedSearchResponse> {
		const startTime = Date.now();
		const providersTried = this.providers.map((p) => p.name);
		const providerErrors: Record<string, string> = {};
		const allResults: SearchResult[] = [];
		const seenUrls = new Set<string>();

		const promises = this.providers.map(async (provider) => {
			try {
				return await this.executeWithTimeout(
					() => provider.search(query, options),
					this.timeoutMs,
				);
			} catch (error) {
				providerErrors[provider.name] =
					error instanceof Error ? error.message : "Unknown error";
				return null;
			}
		});

		const results = await Promise.allSettled(promises);

		let primaryProvider = "none";
		for (const result of results) {
			if (result.status === "fulfilled" && result.value) {
				if (primaryProvider === "none") {
					primaryProvider = result.value.providerUsed;
				}

				for (const r of result.value.results) {
					if (!seenUrls.has(r.url)) {
						seenUrls.add(r.url);
						allResults.push(r);
					}
				}
			}
		}

		// Sort by score
		allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

		// Limit results
		const maxResults = options?.maxResults ?? 10;
		const limitedResults = allResults.slice(0, maxResults);

		return {
			results: limitedResults,
			providerUsed: primaryProvider,
			searchTime: Date.now() - startTime,
			totalResults: allResults.length,
			hasMore: allResults.length > maxResults,
			providersTried,
			providerErrors: this.includeErrors ? providerErrors : undefined,
			strategyUsed: "parallel",
		};
	}

	/**
	 * Fastest strategy: race providers and return first success
	 */
	private async executeFastest(
		query: string,
		options?: SearchOptions,
	): Promise<OrchestratedSearchResponse> {
		const startTime = Date.now();
		const providersTried = this.providers.map((p) => p.name);
		const providerErrors: Record<string, string> = {};

		const promises = this.providers.map(async (provider) => {
			try {
				const result = await this.executeWithTimeout(
					() => provider.search(query, options),
					this.timeoutMs,
				);
				return { provider: provider.name, result };
			} catch (error) {
				providerErrors[provider.name] =
					error instanceof Error ? error.message : "Unknown error";
				throw error;
			}
		});

		// Use Promise.race with a wrapper to handle failures
		// This is equivalent to Promise.any but works in ES2020
		const wrappedPromises = promises.map((p) =>
			p.catch((error) => ({ error, failed: true as const })),
		);

		const raceResults = await Promise.all(wrappedPromises);

		// Find the first successful result
		for (const result of raceResults) {
			if (!("failed" in result)) {
				return {
					...result.result,
					providersTried,
					providerErrors: this.includeErrors
						? providerErrors
						: undefined,
					strategyUsed: "fastest",
				};
			}
		}

		// All providers failed
		return {
			results: [],
			providerUsed: "none",
			searchTime: Date.now() - startTime,
			providersTried,
			providerErrors: this.includeErrors ? providerErrors : undefined,
			strategyUsed: "fastest",
			warnings: ["All search providers failed"],
		};
	}

	/**
	 * Execute a promise with timeout
	 */
	private async executeWithTimeout<T>(
		fn: () => Promise<T>,
		timeoutMs: number,
	): Promise<T> {
		return Promise.race([
			fn(),
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error(`Timeout after ${timeoutMs}ms`)),
					timeoutMs,
				),
			),
		]);
	}

	/**
	 * Check if an error is retryable
	 */
	private isRetryableError(error: unknown): boolean {
		if (error instanceof Error) {
			const message = error.message.toLowerCase();
			return (
				message.includes("timeout") ||
				message.includes("network") ||
				message.includes("rate limit") ||
				message.includes("503") ||
				message.includes("429")
			);
		}
		return false;
	}

	/**
	 * Get available providers
	 */
	getProviders(): BaseSearchProvider[] {
		return this.providers;
	}

	/**
	 * Check if any provider is available
	 */
	async hasAvailableProvider(): Promise<boolean> {
		for (const provider of this.providers) {
			if (await provider.isAvailable()) {
				return true;
			}
		}
		return false;
	}
}

/**
 * Create a search orchestrator from provider configs
 */
export function createSearchOrchestrator(
	providers: ProviderConfig[],
	strategy: SearchStrategy = "fallback",
): SearchOrchestrator {
	return new SearchOrchestrator({
		providers,
		strategy,
	});
}

/**
 * Generate a research plan for deep research
 */
export function generateResearchPlan(
	topic: string,
	subQueries: string[],
): ResearchPlan {
	const steps: ResearchPlanStep[] = [
		{
			step: 1,
			description: `Initial search for "${topic}"`,
			queries: [topic],
			status: "pending",
		},
	];

	// Add sub-query steps
	for (let i = 0; i < subQueries.length; i++) {
		steps.push({
			step: i + 2,
			description: `Exploring: ${subQueries[i]}`,
			queries: [subQueries[i]],
			status: "pending",
		});
	}

	return {
		topic,
		steps,
		status: "planning",
		progress: 0,
	};
}
