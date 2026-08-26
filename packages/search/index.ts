/**
 * @repo/search - Search providers and tools for Fabric
 *
 * This package provides:
 * - Multiple search provider implementations (Exa, Tavily, etc.)
 * - AI SDK tool definitions for chat integration
 * - Deep research capabilities
 * - Search mode management
 */

// Search Mode Configurations
export {
	defaultSearchMode,
	getAllSearchModes,
	getAvailableSearchModes,
	getSearchModeConfig,
	searchModeConfigs,
} from "./lib/modes";
// Search Orchestrator (strategy pattern with fallbacks)
export {
	createSearchOrchestrator,
	generateResearchPlan,
	type OrchestratedSearchResponse,
	type OrchestratorConfig,
	type ResearchProgressCallback,
	SearchOrchestrator,
	type SearchStrategy,
} from "./lib/orchestrator";
// Providers
export {
	BaseSearchProvider,
	createProvider,
	createProvidersFromConfig,
	ExaSearchProvider,
	getAllProviderMetadata,
	getAvailableProviderNames,
	getConfiguredProviders,
	getProviderMetadata,
	type ISearchProvider,
	searchProviderRegistry,
	TavilySearchProvider,
} from "./lib/providers";
// Tools for AI SDK
export {
	type ContentRetrieveParams,
	contentRetrieveTool,
	createContentRetrieveTool,
	createStreamingWebSearchTool,
	createWebSearchTool,
	type SearchProgressEvent,
	type WebSearchParams,
	type WebSearchResult,
	webSearchTool,
} from "./lib/tools";
// Types
export type {
	AcademicSearchResult,
	FactCheckResult,
	FactCheckSource,
	ProviderConfig,
	ResearchPlan,
	ResearchPlanStep,
	SearchContext,
	SearchMode,
	SearchModeConfig,
	SearchOptions,
	SearchProviderMetadata,
	SearchResponse,
	SearchResult,
	TestConnectionResult,
	VideoSearchResult,
} from "./lib/types";
