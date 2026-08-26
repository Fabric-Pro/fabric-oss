/**
 * Types for Fabric AI REST API
 * Based on https://github.com/Fabric-Pro/fabric-ai
 */

/**
 * Fabric AI operation modes:
 * - hybrid: Use Fabric AI for extraction/patterns, user's AI for execution
 * - delegated: Use Fabric AI with per-request credentials (requires Fabric AI modification)
 * - full: Use Fabric AI's own configured API keys (no user isolation)
 */
export type FabricAIMode = "hybrid" | "delegated" | "full";

export interface FabricConfig {
	baseUrl: string;
	apiKey?: string;
	timeout?: number;
	/** Operation mode - defaults to "hybrid" */
	mode?: FabricAIMode;
}

/**
 * Credentials for delegated mode - passed per-request to Fabric AI
 */
export interface DelegatedCredentials {
	vendor: string;
	apiKey: string;
	model: string;
	/** Optional base URL for the AI provider */
	baseUrl?: string;
}

/**
 * Extended chat request that supports delegated credentials
 */
export interface DelegatedChatRequest extends ChatRequest {
	/** Credentials for delegated mode */
	credentials?: DelegatedCredentials;
}

export interface ChatPrompt {
	userInput: string;
	vendor: string;
	model: string;
	patternName?: string;
	contextName?: string;
	strategyName?: string;
	variables?: Record<string, string>;
}

export interface ChatRequest {
	prompts: ChatPrompt[];
	language?: string;
	temperature?: number;
	topP?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	thinking?: number;
}

export interface ChatStreamEvent {
	type: "content" | "error" | "complete";
	format: "markdown" | "mermaid" | "plain";
	content: string;
}

export interface YouTubeTranscriptRequest {
	url: string;
	/** Include timestamps in transcript (format: [HH:MM:SS] text) */
	timestamps?: boolean;
	/** Language code for transcript (e.g., "en", "es") */
	language?: string;
}

export interface YouTubeTranscriptResponse {
	videoId: string;
	title: string;
	description: string;
	transcript: string;
}

/**
 * Full YouTube video info including optional metadata and comments
 */
export interface YouTubeVideoInfo {
	videoId: string;
	title: string;
	description: string;
	transcript?: string;
	duration?: number;
	comments?: string[];
	metadata?: YouTubeMetadata;
}

export interface YouTubeMetadata {
	id: string;
	title: string;
	description: string;
	publishedAt: string;
	channelId: string;
	channelTitle: string;
	categoryId: string;
	tags: string[];
	viewCount: number;
	likeCount: number;
}

/**
 * Web scraping request using Jina AI
 */
export interface ScrapeRequest {
	url: string;
}

/**
 * Search request using Jina AI
 */
export interface SearchRequest {
	question: string;
}

export interface PatternApplyRequest {
	input: string;
	variables?: Record<string, string>;
}

export interface PatternInfo {
	name: string;
	content: string;
}

export interface ModelInfo {
	models: string[];
	vendors: Record<string, string[]>;
}

export interface StrategyInfo {
	name: string;
	description: string;
	prompt: string;
}

export interface FabricError {
	error: string;
}

export type FabricPattern =
	| "summarize"
	| "extract_wisdom"
	| "analyze_claims"
	| "youtube_summary"
	| "create_summary"
	| "extract_insights"
	| "explain_code"
	| "improve_writing"
	| "extract_main_idea"
	| "create_tags"
	| "rate_content"
	| "extract_sponsors"
	| "find_hidden_message"
	| "create_quiz"
	| "extract_questions"
	| "summarize_meeting"
	| "extract_action_items"
	| string; // Allow custom patterns

// =============================================================================
// Extended YouTube Types
// =============================================================================

/**
 * YouTube video metadata response
 */
export interface YouTubeMetadataResponse {
	videoId: string;
	title: string;
	description: string;
	channelTitle: string;
	publishedAt: string;
	duration: number; // Duration in minutes
	viewCount: number;
	likeCount: number;
	tags?: string[];
}

/**
 * YouTube video comments response
 */
export interface YouTubeCommentsResponse {
	videoId: string;
	comments: string[];
	count: number;
}

/**
 * Playlist video info
 */
export interface PlaylistVideoInfo {
	videoId: string;
	title: string;
	url: string;
}

/**
 * YouTube playlist response
 */
export interface YouTubePlaylistResponse {
	playlistId: string;
	videos: PlaylistVideoInfo[];
	count: number;
}

// =============================================================================
// HTML Readability Types
// =============================================================================

/**
 * Readability extraction request
 */
export interface ReadabilityRequest {
	html: string;
	url?: string;
}

/**
 * Readability extraction response
 */
export interface ReadabilityResponse {
	content: string;
	url?: string;
}

// =============================================================================
// Template Plugin Types
// =============================================================================

/**
 * Template plugin request
 * Supports {{plugin:namespace:operation:value}} syntax
 *
 * Namespaces:
 * - text: uppercase, lowercase, reverse, length, repeat
 * - datetime: now, today, time, unix, rel:-1d, startofweek, etc.
 * - file: read, lines, mtime
 * - fetch: get:URL
 * - sys: hostname, user, os, env:VAR, pwd
 * - hash: sha256:string, sha256file:path
 */
export interface TemplatePluginRequest {
	template: string;
	variables?: Record<string, string>;
	input?: string;
}

/**
 * Template plugin response
 */
export interface TemplatePluginResponse {
	output: string;
	template: string;
}

// =============================================================================
// Strategy & Context Types (Extended)
// =============================================================================

/**
 * Strategy info with full content
 */
export interface StrategyInfoFull {
	name: string;
	content: string;
}

/**
 * Strategies list response
 */
export interface StrategiesResponse {
	strategies: StrategyInfoFull[];
	count: number;
}

/**
 * Context info with full content
 */
export interface ContextInfo {
	name: string;
	content: string;
}

/**
 * Contexts list response
 */
export interface ContextsResponse {
	contexts: ContextInfo[];
	count: number;
}
