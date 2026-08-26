/**
 * Unified Search Module
 *
 * Project-scoped search across all knowledge sources:
 * project contexts, workspace documents, connector-backed documents, and web.
 */

export {
	formatResultCitation,
	formatUnifiedResultsForPrompt,
} from "./format";
export { projectSearch } from "./project-search";
export type {
	ProjectSearchOptions,
	ProjectSearchResponse,
	UnifiedSearchResult,
	UnifiedSearchSourceType,
} from "./types";
export {
	DEFAULT_MIN_SIMILARITY,
	DEFAULT_PER_SOURCE_LIMIT,
	DEFAULT_SOURCE_WEIGHTS,
	DEFAULT_TOTAL_LIMIT,
} from "./types";
