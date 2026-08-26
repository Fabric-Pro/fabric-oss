/**
 * Fabric AI Client
 *
 * Client library for interacting with Fabric AI REST API.
 * Fabric is an open-source framework for augmenting humans using AI.
 *
 * Repository: https://github.com/Fabric-Pro/fabric-ai
 *
 * Features:
 * - YouTube transcript extraction
 * - AI pattern execution (summarize, extract_wisdom, analyze_claims, etc.)
 * - 230+ pre-built patterns for various tasks
 * - Streaming chat completions
 * - Three execution modes: hybrid, delegated, full
 *
 * Execution Modes:
 * - hybrid: Use Fabric AI for extraction/patterns, user's AI for execution (default, most secure)
 * - delegated: Use Fabric AI with per-request credentials (requires Fabric AI modification)
 * - full: Use Fabric AI's own API keys (no user isolation)
 *
 * Usage:
 * ```typescript
 * import { executeFabricPattern, analyzeYouTube } from "@repo/fabric-ai";
 *
 * // Hybrid mode - uses user's AI provider
 * const result = await executeFabricPattern({
 *   input: "Some content to analyze",
 *   pattern: "summarize",
 *   userContext: { userId: "user123", organizationId: "org456" },
 * });
 *
 * // YouTube analysis with user's AI
 * const analysis = await analyzeYouTube({
 *   url: "https://youtube.com/watch?v=...",
 *   pattern: "extract_wisdom",
 *   userContext: { userId: "user123" },
 * });
 * ```
 *
 * Environment Variables:
 * - FABRIC_AI_URL: Base URL of Fabric server (default: http://localhost:8080)
 * - FABRIC_AI_API_KEY: API key for authentication (optional)
 * - FABRIC_AI_TIMEOUT: Request timeout in milliseconds (default: 120000)
 * - FABRIC_AI_MODE: Execution mode - "hybrid" | "delegated" | "full" (default: "hybrid")
 */

// Core client
export {
	createFabricClient,
	FabricClient,
	type McpCliCallResponse,
	type McpCliGrepResponse,
	type McpCliListResponse,
	type McpCliSchemaResponse,
	type McpCliServerInfo,
	// MCP CLI types
	type McpCliToolInfo,
} from "./client";
// Delegated mode (Fabric AI with per-request credentials)
export {
	type DelegatedExecutionOptions,
	type DelegatedExecutionResult,
	executePatternDelegated,
	executePatternDelegatedStream,
	isDelegatedModeSupported,
} from "./delegated-executor";
// Unified executor (recommended)
export {
	analyzeYouTube,
	checkFabricAIHealth,
	executeFabricPattern,
	executeFabricPatternStream,
	extractYouTubeTranscript,
	type FabricExecutionOptions,
	type FabricExecutionResult,
	getFabricAIMode,
	getFabricPattern,
	listFabricContexts,
	listFabricPatterns,
	listFabricStrategies,
	type YouTubeAnalysisOptions,
} from "./executor";
// Full mode (Fabric AI's own keys - no user isolation)
export {
	analyzeYouTubeFull,
	executePatternFull,
	executePatternFullStream,
	type FullExecutionOptions,
	type FullExecutionResult,
} from "./full-executor";
// Hybrid mode (extract via Fabric AI, execute with user's AI)
export {
	analyzeYouTubeHybrid,
	executePatternHybrid,
	executePatternHybridStream,
	type HybridExecutionOptions,
	type HybridExecutionResult,
	scrapeAndAnalyzeHybrid,
	searchAndAnalyzeHybrid,
} from "./hybrid-executor";

// Transcription (audio/video)
export {
	ALLOWED_AUDIO_EXTENSIONS,
	type GroqTranscriptionModel,
	MAX_AUDIO_FILE_SIZE,
	type OpenAITranscriptionModel,
	TRANSCRIPTION_MODELS,
	type TranscribeAndAnalyzeOptions,
	type TranscribeAndAnalyzeResult,
	type TranscriptionModel,
	type TranscriptionOptions,
	type TranscriptionResult,
	transcribeAndAnalyze,
	transcribeAudio,
	type UserContext,
} from "./transcription";

// Types
export type {
	ChatPrompt,
	ChatRequest,
	ChatStreamEvent,
	ContextInfo,
	ContextsResponse,
	DelegatedChatRequest,
	DelegatedCredentials,
	FabricAIMode,
	FabricConfig,
	FabricError,
	FabricPattern,
	ModelInfo,
	PatternApplyRequest,
	PatternInfo,
	PlaylistVideoInfo,
	// HTML Readability types
	ReadabilityRequest,
	ReadabilityResponse,
	// Core types
	ScrapeRequest,
	SearchRequest,
	StrategiesResponse,
	StrategyInfo,
	// Extended Strategy & Context types
	StrategyInfoFull,
	// Template plugin types
	TemplatePluginRequest,
	TemplatePluginResponse,
	YouTubeCommentsResponse,
	YouTubeMetadata,
	// Extended YouTube types
	YouTubeMetadataResponse,
	YouTubePlaylistResponse,
	YouTubeTranscriptRequest,
	YouTubeTranscriptResponse,
	YouTubeVideoInfo,
} from "./types";

// Re-export common patterns for convenience
export const FABRIC_PATTERNS = {
	// Content Analysis
	SUMMARIZE: "summarize",
	EXTRACT_WISDOM: "extract_wisdom",
	ANALYZE_CLAIMS: "analyze_claims",
	RATE_CONTENT: "rate_content",
	EXTRACT_MAIN_IDEA: "extract_main_idea",

	// YouTube Specific
	YOUTUBE_SUMMARY: "youtube_summary",
	EXTRACT_SPONSORS: "extract_sponsors",

	// Writing & Documentation
	IMPROVE_WRITING: "improve_writing",
	CREATE_SUMMARY: "create_summary",
	EXPLAIN_CODE: "explain_code",

	// Learning & Study
	CREATE_QUIZ: "create_quiz",
	EXTRACT_QUESTIONS: "extract_questions",
	FIND_HIDDEN_MESSAGE: "find_hidden_message",

	// Meeting & Collaboration
	SUMMARIZE_MEETING: "summarize_meeting",
	EXTRACT_ACTION_ITEMS: "extract_action_items",

	// Metadata
	CREATE_TAGS: "create_tags",
	EXTRACT_INSIGHTS: "extract_insights",
} as const;

export type FabricPatternKey = keyof typeof FABRIC_PATTERNS;

// Jina AI client (for direct search/scrape with user's API key)
export {
	createJinaClient,
	JinaClient,
	type JinaClientConfig,
	type JinaScrapeResult,
	type JinaSearchResult,
} from "./jina-client";
