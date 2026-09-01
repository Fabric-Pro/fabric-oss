/**
 * @repo/ai - AI Model and Provider Configuration
 *
 * This is the main entry point for AI functionality.
 * Model factory functions are defined in model-factory.ts and re-exported here.
 */

// Re-export model factory functions (these are the core model creation utilities)
export {
	getEmbeddingModel,
	getImageModel,
	getModel,
	isVercelGatewayKey,
	type ProviderType,
} from "./model-factory";

// ============================================================================
// EXPLICIT RE-EXPORTS FOR TREE-SHAKING (Vercel React Best Practices)
// ============================================================================
//
// BUNDLE OPTIMIZATION: This file uses explicit re-exports instead of wildcard exports.
// This enables tree-shaking - only imported functions are included in the bundle.
//
// For best bundle size, prefer subpath imports:
// - import { generateText } from "ai";                    // Direct from AI SDK
// - import { getAIModelWithMetadata } from "@repo/ai/model-selector";
// - import { buildEffectiveBaseUrl } from "@repo/ai/gateway";
//
// ============================================================================

// --- AI SDK types (type-only exports don't affect bundle size) ---
export type {
	EmbeddingModel,
	EmbedResult,
	FilePart,
	GenerateObjectResult,
	GenerateTextResult,
	ImagePart,
	LanguageModel,
	StreamTextResult,
	TextPart,
	ToolCallPart,
	ToolResultPart,
	ToolSet,
	UIMessage,
} from "ai";
// --- Commonly used AI SDK exports (explicit for tree-shaking) ---
// These are re-exported for convenience. For smaller bundles, import from "ai" directly.
export {
	// Message conversion utilities
	convertToModelMessages,
	// Gateway provider
	createGateway,
	createTextStreamResponse,
	embed,
	embedMany,
	// Image generation (experimental)
	experimental_generateImage,
	generateObject,
	generateText,
	jsonSchema,
	// Error types
	// Re-exported (not imported straight from `ai`) for the same single-copy-of-
	// `ai` reason documented below for `zodSchema`: callers outside packages/ai
	// must import NoObjectGeneratedError from @repo/ai so `isInstance` checks
	// unify against the same class.
	NoObjectGeneratedError,
	NoSuchToolError,
	pipeTextStreamToResponse,
	stepCountIs,
	streamObject,
	streamText,
	tool,
	// Re-exported so callers never import `zodSchema` from `ai` directly. The
	// `ai` package peer-depends on zod, so pnpm installs one copy of `ai` per
	// zod version — a caller importing `zodSchema` from its own `ai` gets a
	// DIFFERENT copy than the `generateObject` it passes the schema to, and the
	// two types refuse to unify. Going through @repo/ai keeps both on one copy.
	zodSchema,
} from "ai";
// --- Databricks Model Serving compatibility shim (from lib/databricks-compat) ---
// The OpenAI-compatible-fetch wrapper reused by any inference path that talks to
// Databricks serving endpoints through a raw OpenAI-shaped client (the @ai-sdk
// model factory and the CopilotKit route).
export {
	createDatabricksFetch,
	isReasoningModelName,
} from "./lib/databricks-compat";
// --- Databricks service-principal (OAuth M2M) credentials (from lib/databricks-oauth) ---
// `resolveProviderApiKey` is the single chokepoint that turns a stored AI
// provider config into the plaintext bearer token to send upstream — a
// decrypted PAT, or a workspace access token minted from a service principal.
export {
	DatabricksOAuthError,
	getDatabricksOAuthToken,
	hasProviderCredentials,
	hasServicePrincipalCredentials,
	type ProviderCredentialInput,
	resolveProviderApiKey,
} from "./lib/databricks-oauth";
// --- Databricks base-URL normalization (from lib/databricks-url) ---
export {
	hasDatabricksExplicitPath,
	toDatabricksServingBaseUrl,
	toDatabricksWorkspaceHost,
} from "./lib/databricks-url";
export type {
	AIEmbeddingModelResult,
	AIModelMetadata,
	AIModelResult,
	AIOperationContext,
	DynamicModelSelectionOptions,
	DynamicModelSelectionResult,
	DynamicTaskComplexity,
	GetAIModelOptions,
	ModelResolutionContext,
	RAGProviderConfig,
	ResolvedModelConfig,
} from "./lib/dynamic-model-selector";
// --- Model selection and provider configuration (from lib/dynamic-model-selector) ---
export {
	AIProviderNotConfiguredError,
	buildProviderModelString,
	getAIEmbeddingModel,
	getAIEmbeddingModelWithMetadata,
	getAIModel,
	getAIModelWithMetadata,
	getAvailableModels,
	getConfiguredModelString,
	getModelForTaskDynamic,
	getProvidersForModel,
	getRAGProviderConfig,
	isModelAvailableForProvider,
	resolveModelConfiguration,
	resolveModelWithProvider,
	selectModelDynamic,
} from "./lib/dynamic-model-selector";
// --- Fabric prompt enhancement (from lib/fabric-prompt-enhancer) ---
export {
	enhancePromptWithFabric,
	isFabricEnabled,
} from "./lib/fabric-prompt-enhancer";
export type { AiFeatureKey } from "./lib/feature-keys";
// --- AI feature invocation tagging (from lib/feature-keys) ---
export { AI_FEATURE_KEYS } from "./lib/feature-keys";
export type { AIProviderMetadata, ProviderConfig } from "./lib/gateway-config";
// --- Gateway and provider configuration (from lib/gateway-config) ---
export {
	AI_PROVIDER_METADATA,
	buildEffectiveBaseUrl,
	DEFAULT_BASE_URLS,
	DIRECT_PROVIDERS,
	GATEWAY_PROVIDERS,
	getDefaultBaseUrl,
	getProviderDisplayName,
	getProviderMetadata,
	isDirectProvider,
	isGatewayProvider,
	requiresBaseUrl,
	validateApiKeyFormat,
} from "./lib/gateway-config";
export {
	fetchGatewayGenerationCostUsd,
	getGatewayApiKey,
} from "./lib/gateway-generation";
// --- Groq-specific prompts (from lib/groq-prompts) ---
export {
	ASSISTANT_PREFILLS,
	buildGroqSystemPrompt,
	getAssistantPrefill,
} from "./lib/groq-prompts";
export type { AiJobKey } from "./lib/job-keys";
// --- AI job invocation tagging (from lib/job-keys) ---
export { AI_JOB_TYPES } from "./lib/job-keys";
// --- Message extraction (from lib/message-extractor) ---
export {
	type ExtractRelevantExcerptsOptions,
	type ExtractRelevantExcerptsResult,
	extractRelevantExcerpts,
	type RawExtractableMessage,
	type RelevantExcerpt,
} from "./lib/message-extractor";
// --- Direct-REST OpenAI key resolution (from lib/openai-provider-key) ---
// For call sites that hit OpenAI's own API directly instead of going through
// the AI SDK's provider routing (e.g. the TTS endpoint).
export { resolveOpenAiApiKey } from "./lib/openai-provider-key";
// --- Output-token budget helper (from lib/output-token-budget) ---
export {
	type BudgetMetadata,
	computeMaxOutputTokenBudget,
	computeScaledOutputTokenBudget,
	FALLBACK_OUTPUT_TOKEN_CAP,
	MAXIMAL_OUTPUT_TOKEN_CEILING,
	MIN_OUTPUT_TOKEN_BUDGET,
} from "./lib/output-token-budget";
// --- Prompt nomination summaries (from lib/prompt-change-summary) ---
export { generatePromptChangeSummary } from "./lib/prompt-change-summary";
// --- Prompts (from lib/prompts) ---
export {
	getCurrentDateContext,
	promptGenerateChatTitle,
	promptListProductNames,
} from "./lib/prompts";
// --- PR review, QA lens (from lib/prompts/pr-review-qa) ---
export {
	diffAddedLines,
	diffFilePaths,
	groundFindings,
	PR_REVIEW_MAX_FEATURES,
	PR_REVIEW_MAX_FINDINGS,
	PR_REVIEW_MODEL_DIFF_BYTES,
	PR_REVIEW_QA_PROMPT_AGENT,
	PR_REVIEW_QA_PROMPT_FALLBACK_BODY,
	type PrReviewFeature,
	type PrReviewQaFinding,
	reviewPullRequestForQa,
} from "./lib/prompts/pr-review-qa";
// --- Test case drafting (from lib/prompts/test-case-drafting) ---
export {
	ABSOLUTE_MAX_DRAFTED_TEST_CASES,
	boundAcceptanceCriteria,
	countAcceptanceCriteria,
	type DraftedTestCase,
	type DraftedTestStep,
	type DraftQaPolicy,
	type DraftTestCasesContext,
	type DraftTestCasesInput,
	type DraftTestCasesObject,
	DraftTestCasesSchema,
	describeQaPolicy,
	draftTestCases,
	MAX_DRAFTED_TEST_CASES,
	normalizeDraftedTestCases,
} from "./lib/prompts/test-case-drafting";
// --- Test case step revision (from lib/prompts/test-case-step-revision) ---
export {
	type RevisedTestCaseSteps,
	type ReviseFromImplementationInput,
	type ReviseTestCaseStepsContext,
	type ReviseTestCaseStepsInput,
	ReviseTestCaseStepsSchema,
	reviseTestCaseSteps,
	reviseTestCaseStepsFromImplementation,
	TEST_CASE_IMPLEMENTATION_REVISER_PROMPT_FALLBACK_BODY,
	TEST_CASE_STEP_REVISER_PROMPT_FALLBACK_BODY,
} from "./lib/prompts/test-case-step-revision";
// --- Work-item title generation (from lib/story-title-generator) ---
export {
	generateStoryTitleFromDescription,
	type StoryKindForTitle,
	type StoryTitleGenerationContext,
	type StoryTitleResult,
} from "./lib/story-title-generator";
// --- Aggressive streaming (from lib/streaming-aggressive) ---
export { getAggressiveStreamingConfig } from "./lib/streaming-aggressive";
// --- Streaming optimizations (from lib/streaming-optimizations) ---
export {
	CONVERSATIONAL_STREAMING_CONFIG,
	GROQ_STREAMING_CONFIG,
	getOptimalStreamingConfig,
	getStreamingConfigForTask,
	STANDARD_STREAMING_CONFIG,
	ULTRA_FAST_STREAMING_CONFIG,
} from "./lib/streaming-optimizations";
// --- Title generation (from lib/title-generator) ---
export { generateChatTitle } from "./lib/title-generator";
export {
	getAiBillingCategory,
	logEmbeddingUsageAsync,
	logModelUsageAsync,
} from "./lib/usage-logging";
export type { UsageLoggingContext } from "./lib/usage-logging-middleware";
export {
	readTokenCount,
	wrapEmbeddingModelWithUsageLogging,
	wrapModelWithUsageLogging,
} from "./lib/usage-logging-middleware";
