/**
 * Instrumentation Modules
 *
 * Centralized instrumentation for various application concerns.
 * Import individual modules or use the combined export.
 */

export {
	type DatabaseTraceOptions,
	databaseInstrumentation,
} from "./database";
export {
	type ApiCallOptions,
	type HttpSpan,
	httpInstrumentation,
} from "./http";
export { type LLMCallOptions, type LLMSpan, llmInstrumentation } from "./llm";
export {
	type EmbeddingOptions,
	ragInstrumentation,
	type VectorSearchOptions,
	type VectorSearchSpan,
} from "./rag";
