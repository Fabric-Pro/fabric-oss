/**
 * Model Factory - Core AI Model Creation Functions
 *
 * This module provides the low-level functions for creating AI model instances.
 * It's separated from index.ts to avoid circular dependencies with lib/ modules.
 *
 * For high-level model access, use:
 * - getAIModel() / getAIModelWithMetadata() from @repo/ai/model-selector
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";
import {
	createGateway,
	extractReasoningMiddleware,
	wrapLanguageModel,
} from "ai";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { createDatabricksFetch } from "./lib/databricks-compat";
import { toDatabricksServingBaseUrl } from "./lib/databricks-url";
import { createEmptyToolInputRepairMiddleware } from "./lib/empty-tool-input-middleware";

/**
 * Reasoning model patterns that need middleware extraction
 * These models return reasoning in <think>...</think> tags
 */
const REASONING_MODEL_PATTERNS = [
	"deepseek-r1",
	"deepseek-reasoner",
	"r1-distill",
] as const;

/**
 * Vercel AI Gateway Configuration
 * When AI_GATEWAY_API_KEY is set, all AI requests will be routed through Vercel AI Gateway
 * The gateway provides a unified API to access models from multiple providers
 * This enables centralized monitoring, cost tracking, rate limiting, and provider fallbacks
 *
 * Documentation: https://sdk.vercel.ai/providers/ai-sdk-providers/ai-gateway
 */
const gatewayApiKey = process.env.AI_GATEWAY_API_KEY;
const useGateway = !!gatewayApiKey;

/**
 * Extended timeout for long-running AI Gateway requests (15 minutes).
 * The default undici headersTimeout is 5 minutes, which is too short for
 * large report generation tasks that produce 50K+ char HTML responses.
 *
 * The timeout is extended at the TRANSPORT level via an undici Agent
 * (headersTimeout/bodyTimeout). An `AbortSignal` can't do this — it only caps
 * total duration and can't raise the underlying 5-min headers timeout.
 */
const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000;

const extendedTimeoutAgent = new UndiciAgent({
	headersTimeout: GATEWAY_TIMEOUT_MS,
	bodyTimeout: GATEWAY_TIMEOUT_MS,
});

function gatewayFetch(
	url: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	// Call undici's OWN fetch, not Node's built-in fetch: an undici@8 Agent
	// passed as a dispatcher to the built-in fetch is rejected at request time
	// (`invalid onRequestStart method`), because the built-in fetch is powered by
	// Node's internal (older) undici. undici's fetch accepts its own Agent.
	//
	// undici's fetch is a distinct implementation, so it can't consume a global
	// `Request` object (it throws "Failed to parse URL from [object Request]").
	// When one is passed, forward its URL and fold its full request state into
	// init — matching `fetch(request, init)` semantics, with explicit `init`
	// winning. Strings and URL objects pass straight through.
	const base =
		url instanceof Request
			? {
					method: url.method,
					headers: url.headers,
					body: url.body,
					duplex: url.body ? "half" : undefined,
					signal: url.signal,
					mode: url.mode,
					credentials: url.credentials,
					cache: url.cache,
					redirect: url.redirect,
					referrer: url.referrer,
					referrerPolicy: url.referrerPolicy,
					integrity: url.integrity,
					keepalive: url.keepalive,
				}
			: undefined;
	// Web IDL treats an init member set to `undefined` as absent, so it must not
	// clobber the Request-derived value. A plain spread would overwrite it with
	// `undefined`, so drop undefined entries when merging over a Request. The
	// common (non-Request) path keeps `init` as-is — nothing to protect.
	const overrides =
		base && init
			? Object.fromEntries(
					Object.entries(init).filter(
						([, value]) => value !== undefined,
					),
				)
			: init;
	return undiciFetch(
		(url instanceof Request ? url.url : url) as never,
		{
			...base,
			...overrides,
			dispatcher: extendedTimeoutAgent,
		} as never,
	) as never;
}

/**
 * Create Vercel AI Gateway provider instance
 * This is the recommended way to use Vercel AI Gateway with the AI SDK
 * The gateway automatically routes requests to the correct provider based on model name
 */
const gatewayProvider = useGateway
	? createGateway({
			apiKey: gatewayApiKey,
			fetch: gatewayFetch,
		})
	: null;

/**
 * Cache for gateway providers per API key
 * This prevents creating duplicate gateway instances for the same API key
 */
const gatewayProviderCache = new Map<
	string,
	ReturnType<typeof createGateway>
>();

function getGatewayCacheKey(
	apiKey: string,
	headers?: Record<string, string>,
): string {
	if (!headers || Object.keys(headers).length === 0) {
		return apiKey;
	}

	const serializedHeaders = Object.entries(headers)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}:${value}`)
		.join("|");

	return `${apiKey}::${serializedHeaders}`;
}

/**
 * Get or create a gateway provider for a specific API key
 * Uses caching to avoid creating duplicate instances
 *
 * @param {string} apiKey - The Vercel AI Gateway API key
 * @return {ReturnType<typeof createGateway>} The gateway provider instance
 */
function getGatewayProvider(
	apiKey: string,
	headers?: Record<string, string>,
): ReturnType<typeof createGateway> {
	const cacheKey = getGatewayCacheKey(apiKey, headers);

	if (!gatewayProviderCache.has(cacheKey)) {
		gatewayProviderCache.set(
			cacheKey,
			createGateway({
				apiKey,
				headers,
				fetch: gatewayFetch,
			}),
		);
	}
	const provider = gatewayProviderCache.get(cacheKey);
	if (!provider) {
		throw new Error("Failed to create gateway provider");
	}
	return provider;
}

/**
 * Check if a model needs reasoning middleware extraction
 * Models using DeepSeek R1 architecture return reasoning in <think>...</think> tags
 */
function needsReasoningMiddleware(modelName: string): boolean {
	const lowerModel = modelName.toLowerCase();
	return REASONING_MODEL_PATTERNS.some((pattern) =>
		lowerModel.includes(pattern),
	);
}

/**
 * Decide whether a model needs `<think>`-tag reasoning-extraction middleware.
 *
 * A DeepSeek-R1-architecture model returns its chain-of-thought wrapped in
 * `<think>…</think>` tags in the message content on every OpenAI-compatible
 * serving surface EXCEPT the DeepSeek *direct* provider (`@ai-sdk/deepseek`),
 * which parses it into a dedicated `reasoning_content` field. So the tags must
 * be extracted for everyone else; only the native-reasoning DeepSeek surface is
 * skipped.
 *
 * Bug #1942 (U3): the DeepSeek short-circuit keyed off the model *name*
 * (`extractProvider(...) === "deepseek"`), but a Databricks serving endpoint can
 * be *named* `deepseek-r1` / `deepseek-reasoner` (Databricks strips the routing
 * prefix, so the bare name reaches here) while being served over the raw
 * OpenAI-compatible surface that DOES leak `<think>` tags. The resolved provider
 * TYPE is authoritative: when it's DATABRICKS, always extract for an R1 model.
 *
 * Bug #1942 (review): a Databricks endpoint can also be aliased to an *opaque*
 * name (e.g. `prod-chat`) that matches none of the R1 name patterns, so the
 * name-derived R1 check misses it. The caller (dynamic-model-selector) resolves
 * the model's *canonical* identity and passes `isReasoningModel` explicitly; the
 * name heuristic is only a fallback when that signal is absent.
 *
 * @param {string} modelName - The model identifier (may carry a `provider/` prefix).
 * @param {string} nameProvider - `extractProvider(modelName)` — the name-derived provider.
 * @param {string} [resolvedProvider] - The routed provider TYPE (`context.provider`), if known.
 * @param {boolean} [isReasoningModel] - Explicit canonical-derived "emits `<think>`" signal.
 * @return {boolean} True when the reasoning-extraction middleware should be applied.
 */
export function needsReasoningExtraction(
	modelName: string,
	nameProvider: string,
	resolvedProvider?: string,
	isReasoningModel?: boolean,
): boolean {
	// Prefer the explicit canonical-derived signal; fall back to the model-name
	// heuristic when the caller didn't resolve it. Only R1-architecture models
	// emit <think> tags; everything else is a no-op.
	const emitsThinkTags =
		isReasoningModel ?? needsReasoningMiddleware(modelName);
	if (!emitsThinkTags) {
		return false;
	}
	// Databricks passes the raw model output through untouched, so R1's <think>
	// tags leak regardless of what the (user-defined) endpoint name suggests.
	if (resolvedProvider === "DATABRICKS") {
		return true;
	}
	// DeepSeek's direct provider parses reasoning natively (reasoning_content),
	// so no <think> tags reach the content. Keyed on the name-derived provider to
	// preserve the pre-existing gateway / name-only default.
	if (nameProvider === "deepseek") {
		return false;
	}
	// Any other OpenAI-compatible surface (Together, OpenRouter, self-hosted, …).
	return true;
}

/**
 * Wrap a model with reasoning extraction middleware if needed
 * For Groq/Together AI / Databricks models that use DeepSeek R1 architecture,
 * the middleware extracts reasoning from <think> tags. See
 * {@link needsReasoningExtraction} for how the resolved provider + explicit
 * `isReasoningModel` signal drive the decision (Bug #1942).
 */
function wrapWithProviderMiddleware(
	model: LanguageModel,
	modelName: string,
	nameProvider: string,
	resolvedProvider?: string,
	isReasoningModel?: boolean,
): LanguageModel {
	// Always applied, and a no-op on any provider that emits its tool calls
	// correctly: `@ai-sdk/openai@3` silently drops a streamed call whose
	// arguments never parse as JSON, which is every NO-PARAMETER tool (they
	// arrive as `arguments: ""`). See empty-tool-input-middleware.ts.
	const middleware = [createEmptyToolInputRepairMiddleware()];

	if (
		needsReasoningExtraction(
			modelName,
			nameProvider,
			resolvedProvider,
			isReasoningModel,
		)
	) {
		middleware.push(
			extractReasoningMiddleware({
				tagName: "think",
				// For providers that bypass thinking patterns, start with reasoning
				startWithReasoning: nameProvider === "together",
			}),
		);
	}

	// Type assertion needed due to AI SDK type constraints
	return wrapLanguageModel({
		model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
		middleware,
	}) as LanguageModel;
}

/**
 * Normalize model name for gateway routing
 * Handles Groq models with nested prefixes like "groq/openai/gpt-oss-120b"
 * by stripping the outer "groq/" prefix since Vercel Gateway routes based on
 * the inner prefix (openai/gpt-oss-120b will be routed to Groq which hosts this model)
 */
function normalizeModelForGateway(modelName: string): string {
	// Handle "groq/openai/gpt-oss-*" pattern - strip outer groq/ prefix
	// Vercel Gateway will route "openai/gpt-oss-120b" correctly
	if (modelName.startsWith("groq/") && modelName.includes("/", 5)) {
		const normalized = modelName.slice(5); // Remove "groq/"
		console.log(
			`[AI] Normalized model for gateway: ${modelName} -> ${normalized}`,
		);
		return normalized;
	}
	return modelName;
}

/**
 * Provider type enum matching database AIProvider values
 */
export type ProviderType =
	| "VERCEL_GATEWAY"
	| "OPENROUTER"
	| "OPENAI_DIRECT"
	| "ANTHROPIC_DIRECT"
	| "GROQ"
	| "DEEPSEEK"
	| "CEREBRAS"
	| "MISTRAL_AI"
	| "TOGETHER_AI"
	| "COHERE"
	| "PERPLEXITY"
	| "XAI"
	| "FIREWORKS"
	| "AWS_BEDROCK"
	| "GOOGLE_VERTEX_AI"
	| "AZURE_AI_FOUNDRY"
	| "DATABRICKS"
	| "CLOUDFLARE_AI";

/**
 * Check if a provider type is a gateway provider (routes to other providers)
 */
function isGatewayProviderType(provider: string): boolean {
	return ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"].includes(provider);
}

/**
 * Vercel AI Gateway base URL for image generation
 * When using gateway keys (vck_*), requests must be routed through this endpoint
 */
const VERCEL_AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/**
 * Cache for OpenAI providers with custom API keys
 * Stores providers configured for both gateway and direct access
 */
const openaiProviderCache = new Map<string, ReturnType<typeof createOpenAI>>();

/**
 * Cache for Anthropic providers with custom API keys
 */
const anthropicProviderCache = new Map<
	string,
	ReturnType<typeof createAnthropic>
>();

/**
 * Cache for Groq providers with custom API keys
 */
const groqProviderCache = new Map<string, ReturnType<typeof createGroq>>();

/**
 * Cache for DeepSeek providers with custom API keys
 */
const deepseekProviderCache = new Map<
	string,
	ReturnType<typeof createDeepSeek>
>();

/**
 * Cache for Cerebras providers with custom API keys
 */
const cerebrasProviderCache = new Map<
	string,
	ReturnType<typeof createCerebras>
>();

/**
 * Cache for Databricks providers, keyed by `${apiKey}::${servingBaseUrl}`.
 * Databricks Model Serving is OpenAI-compatible, so it reuses createOpenAI
 * pointed at the tenant's per-workspace serving endpoint base URL.
 *
 * BOUNDED, unlike the other provider caches: a service-principal tenant's
 * `apiKey` is a short-lived OAuth access token that rotates roughly hourly, so
 * every refresh mints a NEW cache key. A static PAT keeps the key set naturally
 * bounded by tenant count, but rotation would grow this map without limit in
 * long-lived processes (the Temporal worker, agent containers). Stale entries
 * are harmless — just an expired token nobody asks for again — so oldest-first
 * eviction is sufficient.
 */
const DATABRICKS_PROVIDER_CACHE_MAX = 256;
const databricksProviderCache = new Map<
	string,
	ReturnType<typeof createOpenAI>
>();

/**
 * Shared fetch for Databricks providers: strips the `stream_options` field some
 * serving backends reject, and flattens Claude's non-standard `delta.content`
 * reasoning arrays to plain text. See lib/databricks-compat.ts.
 */
const databricksFetch = createDatabricksFetch();

/**
 * Check if an API key is a Vercel AI Gateway key
 * Gateway keys typically start with "vck_" prefix
 */
export function isVercelGatewayKey(apiKey: string): boolean {
	return apiKey.startsWith("vck_");
}

/**
 * Get or create an OpenAI provider for a specific API key
 * Automatically detects if it's a Vercel Gateway key and configures baseURL accordingly
 *
 * @param {string} apiKey - The API key (Vercel AI Gateway key or direct OpenAI key)
 * @return {ReturnType<typeof createOpenAI>} The OpenAI provider instance
 */
function getOpenAIProviderWithKey(
	apiKey: string,
): ReturnType<typeof createOpenAI> {
	if (!openaiProviderCache.has(apiKey)) {
		if (isVercelGatewayKey(apiKey)) {
			// When using Vercel AI Gateway key, configure OpenAI provider to use gateway endpoint
			openaiProviderCache.set(
				apiKey,
				createOpenAI({
					apiKey,
					baseURL: VERCEL_AI_GATEWAY_BASE_URL,
				}),
			);
		} else {
			// Direct OpenAI API key - use default OpenAI endpoint
			openaiProviderCache.set(apiKey, createOpenAI({ apiKey }));
		}
	}
	const provider = openaiProviderCache.get(apiKey);
	if (!provider) {
		throw new Error("Failed to create OpenAI provider");
	}
	return provider;
}

/**
 * Get or create an Anthropic provider for a specific API key
 */
function getAnthropicProviderWithKey(
	apiKey: string,
): ReturnType<typeof createAnthropic> {
	if (!anthropicProviderCache.has(apiKey)) {
		anthropicProviderCache.set(apiKey, createAnthropic({ apiKey }));
	}
	const provider = anthropicProviderCache.get(apiKey);
	if (!provider) {
		throw new Error("Failed to create Anthropic provider");
	}
	return provider;
}

/**
 * Get or create a Groq provider for a specific API key
 */
function getGroqProviderWithKey(apiKey: string): ReturnType<typeof createGroq> {
	if (!groqProviderCache.has(apiKey)) {
		groqProviderCache.set(apiKey, createGroq({ apiKey }));
	}
	const provider = groqProviderCache.get(apiKey);
	if (!provider) {
		throw new Error("Failed to create Groq provider");
	}
	return provider;
}

/**
 * Get or create a DeepSeek provider for a specific API key
 */
function getDeepSeekProviderWithKey(
	apiKey: string,
): ReturnType<typeof createDeepSeek> {
	if (!deepseekProviderCache.has(apiKey)) {
		deepseekProviderCache.set(apiKey, createDeepSeek({ apiKey }));
	}
	const provider = deepseekProviderCache.get(apiKey);
	if (!provider) {
		throw new Error("Failed to create DeepSeek provider");
	}
	return provider;
}

/**
 * Get or create a Cerebras provider for a specific API key
 * Cerebras is an inference provider with extremely fast inference speeds
 */
function getCerebrasProviderWithKey(
	apiKey: string,
): ReturnType<typeof createCerebras> {
	if (!cerebrasProviderCache.has(apiKey)) {
		cerebrasProviderCache.set(apiKey, createCerebras({ apiKey }));
	}
	const provider = cerebrasProviderCache.get(apiKey);
	if (!provider) {
		throw new Error("Failed to create Cerebras provider");
	}
	return provider;
}

/**
 * Get or create a Databricks provider for a specific API key + workspace host.
 * Databricks Model Serving (Mosaic AI Gateway) is OpenAI-compatible and uses
 * standard Bearer auth (the default for createOpenAI) — no api-key header or
 * api-version query param (unlike Azure). The serving-endpoint name is passed
 * as the model in the request body.
 */
function getDatabricksProviderWithKey(
	apiKey: string,
	baseUrl: string,
): ReturnType<typeof createOpenAI> {
	const servingUrl = toDatabricksServingBaseUrl(baseUrl);
	const cacheKey = `${apiKey}::${servingUrl}`;
	if (!databricksProviderCache.has(cacheKey)) {
		// Evict oldest-first before inserting. Map preserves insertion order, so
		// the first key is the least recently CREATED — good enough here, since
		// entries age out because their token rotated, not because they went cold.
		while (databricksProviderCache.size >= DATABRICKS_PROVIDER_CACHE_MAX) {
			const oldest = databricksProviderCache.keys().next();
			if (oldest.done) {
				break;
			}
			databricksProviderCache.delete(oldest.value);
		}
		databricksProviderCache.set(
			cacheKey,
			createOpenAI({
				apiKey,
				baseURL: servingUrl,
				fetch: databricksFetch,
			}),
		);
	}
	const provider = databricksProviderCache.get(cacheKey);
	if (!provider) {
		throw new Error("Failed to create Databricks provider");
	}
	return provider;
}

/**
 * Helper function to format model name with provider prefix if not already present
 * Detects provider from model name patterns
 */
function formatModelName(modelStr: string): string {
	// If model already has provider prefix (e.g., "openai/gpt-4o"), return as-is
	if (modelStr.includes("/")) {
		return modelStr;
	}

	// Detect Groq models (llama, gemma, mixtral)
	if (
		modelStr.startsWith("llama") ||
		modelStr.startsWith("gemma") ||
		modelStr.startsWith("mixtral")
	) {
		return `groq/${modelStr}`;
	}

	// DeepSeek models
	if (modelStr.startsWith("deepseek")) {
		return `deepseek/${modelStr}`;
	}

	// Anthropic models
	if (modelStr.startsWith("claude")) {
		return `anthropic/${modelStr}`;
	}

	// OpenAI models (default)
	return `openai/${modelStr}`;
}

/**
 * Helper function to extract model name without provider prefix
 */
function extractModelName(modelStr: string): string {
	if (modelStr.includes("/")) {
		return modelStr.split("/")[1] ?? modelStr;
	}
	return modelStr;
}

/**
 * Helper function to extract provider from model string
 */
function extractProvider(modelStr: string): string {
	if (modelStr.includes("/")) {
		return modelStr.split("/")[0] ?? "openai";
	}

	// Detect provider from model name patterns
	if (
		modelStr.startsWith("llama") ||
		modelStr.startsWith("gemma") ||
		modelStr.startsWith("mixtral")
	) {
		return "groq";
	}
	if (modelStr.startsWith("deepseek")) {
		return "deepseek";
	}
	if (modelStr.startsWith("claude")) {
		return "anthropic";
	}
	return "openai";
}

/**
 * Get an AI model instance based on the model name and provider configuration.
 *
 * This function properly handles both gateway providers (Vercel Gateway, OpenRouter)
 * and direct providers (OpenAI, Anthropic, Groq, DeepSeek).
 *
 * When a provider is specified:
 * - Gateway providers: Routes through the gateway with the model name formatted appropriately
 * - Direct providers: Uses the provider's SDK directly with the API key
 *
 * When no provider is specified:
 * - Uses global gateway if configured (AI_GATEWAY_API_KEY)
 * - Falls back to direct provider based on model name pattern
 *
 * @param {string} modelName - The model identifier (e.g., "gpt-4o", "claude-3.5-sonnet", "openai/gpt-4o")
 * @param {object} context - Context for API key and provider routing
 * @param {string} context.apiKey - The API key for the provider
 * @param {string} context.provider - The provider type (e.g., "OPENAI_DIRECT", "VERCEL_GATEWAY")
 * @return {LanguageModel} The AI model instance
 */
/**
 * Apply Azure-deployment request-body compatibility transforms (in place) to an
 * Azure OpenAI chat/completions request body. Returns whether the body changed.
 *
 * Exported as a pure function so the transform rules are unit-testable without a
 * live Azure endpoint. Mirrors the inline patches the Azure `fetch` interceptor
 * has always done (temperature / max_tokens), plus the Bug #1681 strict-schema
 * flip that fixes structured `generateObject` across every Azure caller.
 */
export function applyAzureChatBodyCompat(
	body: Record<string, unknown>,
	effectiveModel: string,
): boolean {
	let modified = false;

	// Some Azure deployments reject any `temperature` value — drop it and let
	// the model use its default.
	if (body.temperature !== undefined) {
		delete body.temperature;
		modified = true;
	}

	// o1/o3 and most modern models require `max_completion_tokens` and reject
	// `max_tokens`; older models (gpt-4, gpt-35-turbo) only accept `max_tokens`,
	// so only convert for models known to require it.
	const m = effectiveModel.toLowerCase();
	const usesLegacyMaxTokensOnly =
		m.startsWith("gpt-35") || m.startsWith("gpt-4-") || m === "gpt-4";
	if (!usesLegacyMaxTokensOnly && body.max_tokens !== undefined) {
		if (body.max_completion_tokens === undefined) {
			body.max_completion_tokens = body.max_tokens;
		}
		delete body.max_tokens;
		modified = true;
	}

	// Bug #1681: @ai-sdk/openai defaults strict JSON-schema structured outputs
	// (`response_format.json_schema.strict = true`), which Azure rejects with a
	// 400 when the Zod schema has optional fields (strict mode requires every
	// property in `required`). Force non-strict so optional-heavy schemas
	// (backlog analysis, daily-brief, deep-researcher, …) work across ALL
	// `generateObject` callers on Azure; the AI SDK still validates the result
	// against the Zod schema.
	const responseFormat = body.response_format as
		| { type?: string; json_schema?: { strict?: boolean } }
		| undefined;
	if (
		responseFormat?.type === "json_schema" &&
		responseFormat.json_schema?.strict === true
	) {
		responseFormat.json_schema.strict = false;
		modified = true;
	}

	return modified;
}

export function getModel(
	modelName?: string,
	context?: {
		userId?: string;
		organizationId?: string;
		apiKey?: string;
		provider?: ProviderType | string;
		baseUrl?: string | null;
		headers?: Record<string, string>;
		/** For Azure AI Foundry - the user-defined deployment name */
		deploymentName?: string | null;
		/**
		 * Explicit "this model emits `<think>` reasoning tags" signal, resolved
		 * from the model's CANONICAL identity by the caller (dynamic-model-selector).
		 * Preferred over the model-name heuristic so a DeepSeek-R1 endpoint mapped
		 * to an opaque Databricks alias (e.g. `prod-chat`) is still detected
		 * (Bug #1942 review).
		 */
		isReasoningModel?: boolean;
	},
): LanguageModel {
	if (!modelName) {
		throw new Error(
			"[getModel] Model name is required. Use getConfiguredModelString() to get the model dynamically.",
		);
	}
	const model = modelName;
	const modelProvider = extractProvider(model);
	const normalizedModel = normalizeModelForGateway(model);
	const modelWithoutPrefix = extractModelName(model);

	// If API key and provider are specified, route appropriately
	if (context?.apiKey && context?.provider) {
		const provider = context.provider;

		if (isGatewayProviderType(provider)) {
			// Gateway providers - route through gateway
			const gateway = getGatewayProvider(context.apiKey, context.headers);
			const baseModel = gateway(formatModelName(normalizedModel));
			return wrapWithProviderMiddleware(
				baseModel,
				model,
				modelProvider,
				provider,
				context.isReasoningModel,
			);
		}

		// Direct providers - use provider SDK directly
		// BUT: If the API key is a gateway key, we MUST route through the gateway
		// regardless of what provider was configured (this is a configuration mismatch)
		const isGatewayKey = isVercelGatewayKey(context.apiKey);

		if (isGatewayKey) {
			// API key is a gateway key - MUST use gateway routing with prefixed model name
			console.warn(
				`[AI] Provider "${provider}" configured but API key is a Vercel Gateway key. ` +
					`Routing through gateway instead. Model: ${normalizedModel}`,
			);
			const gateway = getGatewayProvider(context.apiKey, context.headers);
			const baseModel = gateway(formatModelName(normalizedModel));
			return wrapWithProviderMiddleware(
				baseModel,
				model,
				modelProvider,
				provider,
				context.isReasoningModel,
			);
		}

		let baseModel: LanguageModel;
		switch (provider) {
			case "OPENAI_DIRECT":
				baseModel = getOpenAIProviderWithKey(context.apiKey)(
					modelWithoutPrefix,
				);
				break;
			case "ANTHROPIC_DIRECT":
				baseModel = getAnthropicProviderWithKey(context.apiKey)(
					modelWithoutPrefix,
				);
				break;
			case "GROQ":
				baseModel = getGroqProviderWithKey(context.apiKey)(
					modelWithoutPrefix,
				);
				break;
			case "DEEPSEEK":
				baseModel = getDeepSeekProviderWithKey(context.apiKey)(
					modelWithoutPrefix,
				);
				break;
			case "CEREBRAS":
				baseModel = getCerebrasProviderWithKey(context.apiKey)(
					modelWithoutPrefix,
				);
				break;
			case "AZURE_AI_FOUNDRY": {
				if (!context.baseUrl) {
					throw new Error(
						"Azure AI Foundry requires a base URL. Please configure your Azure OpenAI resource endpoint in Settings → AI Providers.",
					);
				}
				// Azure AI Foundry deployment name resolution:
				// IMPORTANT: Azure deployments are model-specific - a "gpt-5-nano" deployment can ONLY serve gpt-5-nano.
				// Priority: 1) Configured deployment name from Settings, 2) Model name from AI Models page selection.
				// This matches how the LangGraph agent handles Azure (uses deploymentName from token exchange).
				// If user wants different models, they need to create corresponding deployments in Azure.
				const azureDeploymentName =
					context.deploymentName || modelWithoutPrefix;
				if (!azureDeploymentName) {
					throw new Error(
						"Azure AI Foundry requires a deployment name. Please configure the deployment name in Settings → AI Providers.",
					);
				}
				if (
					context.deploymentName &&
					context.deploymentName !== modelWithoutPrefix
				) {
					console.log(
						`[AI] Azure AI Foundry: Using configured deployment "${context.deploymentName}" ` +
							`(AI Models page shows "${modelWithoutPrefix}" but Azure deployments are model-specific)`,
					);
				}
				// Azure OpenAI chat endpoint format:
				// {base-url}/openai/deployments/{deployment-name}/chat/completions?api-version=2025-01-01-preview
				const azureChatBaseUrl = `${context.baseUrl.replace(/\/$/, "")}/openai/deployments/${azureDeploymentName}`;
				const azureChatProvider = createOpenAI({
					apiKey: context.apiKey,
					baseURL: azureChatBaseUrl,
					headers: {
						"api-key": context.apiKey,
					},
					// Azure requires api-version query parameter on all requests
					// Also remove temperature: Azure deployments (e.g., gpt-5-nano) may not support
					// any temperature setting - let the model use its default
					fetch: async (url, options) => {
						const urlWithVersion = new URL(url.toString());
						urlWithVersion.searchParams.set(
							"api-version",
							"2025-01-01-preview",
						);

						// Patch request body for Azure deployment compatibility
						// (temperature / max_tokens / Bug #1681 strict json_schema).
						// Transform rules live in `applyAzureChatBodyCompat` so
						// they can be unit-tested without a live Azure endpoint.
						if (options?.body && typeof options.body === "string") {
							try {
								const body = JSON.parse(options.body) as Record<
									string,
									unknown
								>;
								const effectiveModel =
									azureDeploymentName || modelWithoutPrefix;
								if (
									applyAzureChatBodyCompat(
										body,
										effectiveModel,
									)
								) {
									return fetch(urlWithVersion.toString(), {
										...options,
										body: JSON.stringify(body),
									});
								}
							} catch {
								// If body parsing fails, proceed with original request
							}
						}

						return fetch(urlWithVersion.toString(), options);
					},
				});
				// Use .chat() to force chat/completions API (Azure doesn't support responses API)
				// Empty model string since deployment is in the URL
				baseModel = azureChatProvider.chat("");
				break;
			}
			case "DATABRICKS": {
				if (!context.baseUrl) {
					throw new Error(
						"Databricks requires a base URL (workspace host). Please configure your Databricks workspace URL in Settings → AI Providers.",
					);
				}
				// modelWithoutPrefix is the serving-endpoint name (e.g.
				// "databricks-meta-llama-3-3-70b-instruct"). .chat() forces the
				// chat/completions path — Databricks has no OpenAI Responses API.
				baseModel = getDatabricksProviderWithKey(
					context.apiKey,
					context.baseUrl,
				).chat(modelWithoutPrefix);
				break;
			}
			default:
				// Fall back to OpenAI-compatible endpoint for unknown providers
				baseModel = getOpenAIProviderWithKey(context.apiKey)(
					modelWithoutPrefix,
				);
		}
		return wrapWithProviderMiddleware(
			baseModel,
			model,
			modelProvider,
			provider,
			context.isReasoningModel,
		);
	}

	// If only API key is provided without provider, require explicit provider specification
	// This prevents ambiguity in routing and ensures correct API key usage
	if (context?.apiKey && !context?.provider) {
		throw new Error(
			"Provider must be specified when providing an API key. Use context.provider to specify the provider type (e.g., 'OPENAI_DIRECT', 'VERCEL_GATEWAY', etc.)",
		);
	}

	// Fall back to global gateway only (no environment variable fallbacks)
	if (useGateway && gatewayProvider) {
		const provider = context?.headers
			? getGatewayProvider(gatewayApiKey as string, context.headers)
			: gatewayProvider;
		const baseModel = provider(formatModelName(normalizedModel));
		return wrapWithProviderMiddleware(
			baseModel,
			model,
			modelProvider,
			undefined,
			context?.isReasoningModel,
		);
	}

	// No API key provided and no global gateway configured - throw clear error
	throw new Error(
		"[getModel] No AI provider configured. " +
			"Either provide context.apiKey and context.provider, " +
			"or configure AI_GATEWAY_API_KEY environment variable for global gateway access. " +
			"User/Organization API keys should be configured in Settings → AI Providers.",
	);
}

/**
 * Get an Embedding model instance based on the model name and provider configuration.
 *
 * This function properly handles both gateway providers (Vercel Gateway, OpenRouter)
 * and direct providers (OpenAI).
 *
 * Note: Supports OpenAI, Azure AI Foundry, and gateway providers for embeddings.
 *
 * @param {string} modelName - The embedding model identifier (e.g., "text-embedding-3-small")
 * @param {object} context - Context for API key and provider routing
 * @param {string} context.apiKey - The API key for the provider
 * @param {string} context.provider - The provider type (e.g., "OPENAI_DIRECT", "VERCEL_GATEWAY", "AZURE_AI_FOUNDRY")
 * @param {string} context.baseUrl - The base URL for providers that require it (e.g., Azure AI Foundry)
 * @return {EmbeddingModel} The embedding model instance
 */
export function getEmbeddingModel(
	modelName: string,
	context?: {
		apiKey?: string;
		provider?: ProviderType | string;
		baseUrl?: string | null;
		headers?: Record<string, string>;
		/** For Azure AI Foundry - the user-defined deployment name */
		deploymentName?: string | null;
	},
): EmbeddingModel {
	if (!modelName) {
		throw new Error(
			"Embedding model name is required. Configure an embedding model in Settings → AI Models.",
		);
	}
	const model = modelName;

	// If API key and provider are specified, route appropriately
	if (context?.apiKey && context?.provider) {
		if (isGatewayProviderType(context.provider)) {
			const gateway = getGatewayProvider(context.apiKey, context.headers);
			// Model may already have provider prefix (e.g., "openai/text-embedding-3-small")
			// Only add prefix if not already present
			const embeddingModelId = model.includes("/")
				? model
				: `openai/${model}`;
			console.log("[AI:Embedding] Gateway embedding model:", {
				inputModel: model,
				finalModelId: embeddingModelId,
				provider: context.provider,
			});
			return gateway.textEmbeddingModel(embeddingModelId);
		}

		// Azure AI Foundry - uses OpenAI SDK with custom base URL and api-version
		if (context.provider === "AZURE_AI_FOUNDRY") {
			if (!context.baseUrl) {
				throw new Error(
					"Azure AI Foundry requires a base URL. Please configure your Azure OpenAI resource endpoint in Settings → AI Providers.",
				);
			}
			// Use user-configured deployment name if provided, otherwise fall back to model name
			const azureEmbeddingDeployment = context.deploymentName || model;
			console.log(
				`[AI] Azure AI Foundry embeddings: Using deployment "${azureEmbeddingDeployment}" (configured: ${context.deploymentName || "not set"})`,
			);
			// Azure OpenAI embeddings endpoint format:
			// {base-url}/openai/deployments/{deployment-name}/embeddings?api-version=2025-01-01-preview
			const azureBaseUrl = `${context.baseUrl.replace(/\/$/, "")}/openai/deployments/${azureEmbeddingDeployment}`;
			const azureProvider = createOpenAI({
				apiKey: context.apiKey,
				baseURL: azureBaseUrl,
				headers: {
					"api-key": context.apiKey,
				},
				// Azure requires api-version query parameter on all requests
				// Also remove temperature for consistency with chat models
				fetch: async (url, options) => {
					const urlWithVersion = new URL(url.toString());
					urlWithVersion.searchParams.set(
						"api-version",
						"2025-01-01-preview",
					);

					// Remove temperature entirely for Azure deployments
					if (options?.body && typeof options.body === "string") {
						try {
							const body = JSON.parse(options.body);
							if (body.temperature !== undefined) {
								delete body.temperature;
								return fetch(urlWithVersion.toString(), {
									...options,
									body: JSON.stringify(body),
								});
							}
						} catch {
							// If body parsing fails, proceed with original request
						}
					}

					return fetch(urlWithVersion.toString(), options);
				},
			});
			// For Azure, we use an empty model string since deployment is in the URL
			return azureProvider.embedding("");
		}

		// Databricks - OpenAI-compatible serving endpoints under the workspace host.
		// The embedding serving-endpoint name (e.g. "databricks-gte-large-en") is
		// passed as the model in the request body.
		if (context.provider === "DATABRICKS") {
			if (!context.baseUrl) {
				throw new Error(
					"Databricks requires a base URL (workspace host). Please configure your Databricks workspace URL in Settings → AI Providers.",
				);
			}
			return getDatabricksProviderWithKey(
				context.apiKey,
				context.baseUrl,
			).embedding(model);
		}

		// Direct provider - OpenAI and compatible providers
		const provider = getOpenAIProviderWithKey(context.apiKey);
		return provider.embedding(model);
	}

	// If only API key is provided without provider, require explicit provider specification
	if (context?.apiKey && !context?.provider) {
		throw new Error(
			"Provider must be specified when providing an API key for embeddings. Use context.provider to specify the provider type.",
		);
	}

	// Route through Vercel AI Gateway when enabled (global key)
	if (useGateway && gatewayProvider) {
		const provider = context?.headers
			? getGatewayProvider(gatewayApiKey as string, context.headers)
			: gatewayProvider;
		return provider.textEmbeddingModel(`openai/${model}`);
	}

	// No API key provided and no global gateway configured - throw clear error
	throw new Error(
		"[getEmbeddingModel] No AI provider configured for embeddings. " +
			"Either provide context.apiKey and context.provider, " +
			"or configure AI_GATEWAY_API_KEY environment variable for global gateway access. " +
			"User/Organization API keys should be configured in Settings → AI Providers.",
	);
}

/**
 * Get an Image model instance based on the model name and provider configuration.
 *
 * This function properly handles both gateway providers (Vercel Gateway, OpenRouter)
 * and direct providers (OpenAI).
 *
 * Note: Currently only OpenAI provides image models (DALL-E), but the function is designed
 * to support future providers that may offer image generation.
 *
 * @param {string} modelName - The image model identifier (e.g., "dall-e-3", "openai/dall-e-3")
 * @param {object} context - Context for API key and provider routing
 * @param {string} context.apiKey - The API key for the provider
 * @param {string} context.provider - The provider type (e.g., "OPENAI_DIRECT", "VERCEL_GATEWAY")
 * @return {ImageModel} The image model instance
 */
export function getImageModel(
	modelName?: string,
	context?: {
		userId?: string;
		organizationId?: string;
		apiKey?: string;
		provider?: ProviderType | string;
	},
) {
	const model = modelName ?? "dall-e-3";

	// Extract model name without provider prefix
	const getModelWithoutPrefix = (modelStr: string): string => {
		if (modelStr.includes("/")) {
			return modelStr.split("/")[1] ?? modelStr;
		}
		return modelStr;
	};

	const modelWithoutPrefix = getModelWithoutPrefix(model);

	// Validate supported image models
	const supportedModels = ["dall-e-3", "dall-e-2", "gpt-image-2"];
	if (!supportedModels.includes(modelWithoutPrefix)) {
		throw new Error(
			`Unsupported image model: ${modelWithoutPrefix}. Supported models: ${supportedModels.join(", ")}`,
		);
	}

	// If API key is provided, route based on provider type
	if (context?.apiKey) {
		// Currently only OpenAI supports image models, so use OpenAI provider
		// getOpenAIProviderWithKey already handles gateway vs direct based on key prefix
		const provider = getOpenAIProviderWithKey(context.apiKey);
		return provider.image(modelWithoutPrefix);
	}

	// Fall back to global gateway key only (no environment variable fallbacks)
	if (gatewayApiKey) {
		const provider = getOpenAIProviderWithKey(gatewayApiKey);
		return provider.image(modelWithoutPrefix);
	}

	// No API key provided and no global gateway configured - throw clear error
	throw new Error(
		"[getImageModel] No AI provider configured for image generation. " +
			"Either provide context.apiKey, " +
			"or configure AI_GATEWAY_API_KEY environment variable for global gateway access. " +
			"User/Organization API keys should be configured in Settings → AI Providers.",
	);
}
