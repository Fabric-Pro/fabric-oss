/**
 * LangChain Model Factory
 *
 * Centralized model creation for LangGraph agents.
 * Supports multiple AI providers through:
 * 1. AI Gateways (Vercel, OpenRouter, Cloudflare) - using ChatOpenAI with baseURL
 * 2. Direct providers (Groq, OpenAI, Anthropic) - using native SDKs
 *
 * Provider configuration is passed from the runtime via the RunnableConfig,
 * or fetched from the API using tenant context.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGroq } from "@langchain/groq";
import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { createSecurityHeaders } from "@repo/agent-runtime";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import {
	createDatabricksFetch,
	isReasoningModelName,
} from "./databricks-compat";

// NOTE: AI config (provider, apiKey, baseUrl, model) must come from:
// 1. Runtime headers (X-AI-* headers from CopilotKit)
// 2. API call to /api/agents/ai-config (which queries the database)
// Agents must remain stateless - no direct @repo/database imports allowed.

// ============================================================================
// AI Config API Client
// ============================================================================

/**
 * Response from the AI Config API endpoint
 */
interface AiConfigResponse {
	provider: string;
	apiKey: string;
	model: string;
	/**
	 * Effective gateway/base URL, or null when the resolved provider requires a
	 * tenant-supplied base URL but none is configured. The route deliberately
	 * sends null (rather than an OpenRouter fallback) for those providers so we
	 * surface a clear "requires a base URL" error instead of misrouting the
	 * tenant's key to the wrong host.
	 */
	gatewayUrl: string | null;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName?: string | null;
	/** Whether the resolved model emits `<think>` tags (canonical-derived; Bug #1942). */
	isReasoningModel?: boolean;
}

/**
 * Response from the task-specific AI config API endpoint
 *
 * In the simplified design:
 * - User has ONE default provider
 * - Model overrides are scoped to that provider
 * - The `provider` field is always the effective provider (user's default)
 * - The `model` field may be the user's override or system default for the task
 */
interface UserPreferenceResponse {
	provider: string;
	apiKey: string;
	model: string;
	gatewayUrl: string | null;
	source?: string; // "user_override" | "org_override" | "system_default"
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName?: string | null;
	/** Whether the resolved model emits `<think>` tags (canonical-derived; Bug #1942). */
	isReasoningModel?: boolean;
	/** Catalog output cap for the resolved model; null when the catalog is silent. */
	maxOutputTokens?: number | null;
	/** Catalog context window for the resolved model; null when unknown. */
	contextWindow?: number | null;
}

/**
 * Fetch AI configuration from the API using tenant context.
 * This is used when AI config is not passed directly through CopilotKit.
 *
 * @param userId - Tenant user ID
 * @param organizationId - Optional organization ID
 * @returns Provider config or null if not available
 */
async function fetchAiConfigFromApi(
	userId: string,
	organizationId?: string,
): Promise<RuntimeProviderConfig | null> {
	// Check multiple possible environment variables for the API URL
	// FABRIC_API_URL: Explicit config for agents
	// RUNTIME_API_URL: Set by docker-compose for agents (e.g., http://web:3001)
	// NEXT_PUBLIC_APP_URL: Next.js app URL
	const apiUrl =
		process.env.FABRIC_API_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.NEXT_PUBLIC_APP_URL;

	if (!apiUrl) {
		console.warn(
			"[LangChainModels] No API URL configured (FABRIC_API_URL, RUNTIME_API_URL, or NEXT_PUBLIC_APP_URL). Cannot fetch AI config from API.",
		);
		return null;
	}

	try {
		const response = await fetch(`${apiUrl}/api/agents/ai-config`, {
			method: "GET",
			headers: {
				"Content-Type": "application/json",
				...createSecurityHeaders({
					userId,
					organizationId: organizationId ?? null,
				}),
			},
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			console.error(
				`[LangChainModels] Failed to fetch AI config: ${response.status}`,
				error,
			);
			return null;
		}

		const data = (await response.json()) as AiConfigResponse;

		console.log(
			`[LangChainModels] Fetched AI config from API: provider=${data.provider}, model=${data.model}`,
		);

		return {
			provider: data.provider,
			apiKey: data.apiKey,
			model: data.model,
			// null (base-URL-required provider with none configured) becomes
			// undefined so the provider branches below throw their clear
			// "requires a base URL" error rather than silently defaulting.
			baseUrl: data.gatewayUrl ?? undefined,
			deploymentName: data.deploymentName || undefined,
			isReasoningModel: data.isReasoningModel,
		};
	} catch (error) {
		console.error(
			"[LangChainModels] Error fetching AI config from API:",
			error,
		);
		return null;
	}
}

/**
 * Fetch AI configuration for a specific task type from the API.
 * Returns the model configured for this task type using user's default provider.
 *
 * @param userId - Tenant user ID
 * @param organizationId - Optional organization ID
 * @param taskType - Task type (e.g., "TOOL_CALLING", "CHAT")
 * @returns Provider config with override or null if not available
 */
async function fetchTaskSpecificConfig(
	userId: string,
	organizationId?: string,
	taskType?: string,
): Promise<UserPreferenceResponse | null> {
	const apiUrl =
		process.env.FABRIC_API_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.NEXT_PUBLIC_APP_URL;

	console.log(
		`[LangChainModels] fetchTaskSpecificConfig called: userId=${userId}, taskType=${taskType}, apiUrl=${apiUrl ? "set" : "NOT SET"}`,
	);

	if (!apiUrl || !taskType) {
		console.log(
			`[LangChainModels] Skipping task-specific config fetch: apiUrl=${!!apiUrl}, taskType=${taskType}`,
		);
		return null;
	}

	try {
		const queryParams = new URLSearchParams({ taskType });
		if (organizationId) {
			queryParams.set("organizationId", organizationId);
		}

		const response = await fetch(
			`${apiUrl}/api/agents/ai-config/task?${queryParams}`,
			{
				method: "GET",
				headers: {
					"Content-Type": "application/json",
					...createSecurityHeaders({
						userId,
						organizationId: organizationId ?? null,
					}),
				},
			},
		);

		if (!response.ok) {
			// 404 is expected if no task-specific preference exists
			if (response.status !== 404) {
				console.warn(
					`[LangChainModels] Failed to fetch task-specific config: ${response.status}`,
				);
			}
			return null;
		}

		const data = (await response.json()) as UserPreferenceResponse;

		console.log(
			`[LangChainModels] Fetched task-specific config: taskType=${taskType}, provider=${data.provider}, model=${data.model}, source=${data.source}`,
		);

		return data;
	} catch (error) {
		console.warn(
			"[LangChainModels] Error fetching task-specific config:",
			error,
		);
		return null;
	}
}

// ============================================================================
// Types
// ============================================================================

export interface LangChainModelConfig {
	/** Model name (e.g., "llama-3.3-70b-versatile") */
	model?: string;
	/** Temperature for generation (0-1) */
	temperature?: number;
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** API key override (defaults to GROQ_API_KEY env var) */
	apiKey?: string;
}

/**
 * Provider configuration from runtime (passed via CopilotKit properties)
 */
export interface RuntimeProviderConfig {
	/** Provider type (e.g., "VERCEL_GATEWAY", "OPENROUTER", "GROQ") */
	provider?: string;
	/** API key for the provider */
	apiKey: string;
	/** Model string (e.g., "groq/llama-3.3-70b-versatile") */
	model: string;
	/** Base URL for the API (for gateways and OpenAI-compatible providers) */
	baseUrl?: string;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName?: string;
	/**
	 * Whether the resolved model emits `<think>` reasoning tags (DeepSeek-R1
	 * architecture), derived from the CANONICAL identity upstream. Used to gate
	 * Databricks `<think>` stripping when the serving-endpoint alias is opaque
	 * (e.g. `prod-chat`) — Bug #1942 review. Falls back to a name check on `model`
	 * when absent.
	 */
	isReasoningModel?: boolean;
	/** Catalog output cap for the resolved model; undefined when unknown. */
	maxOutputTokens?: number;
	/** Catalog context window for the resolved model; undefined when unknown. */
	contextWindow?: number;
}

/**
 * Model creation options
 */
export interface ModelOptions {
	/** Temperature for generation (default: 0.7) */
	temperature?: number;
	/** Maximum tokens to generate (default: 4000) */
	maxTokens?: number;
	/**
	 * Computes the effective `maxTokens` from the FINAL resolved provider
	 * config, evaluated once by `createProviderModel` — after
	 * `getAgentModelAsync` has finished any task-specific-preference or
	 * API-fallback resolution that can replace `RuntimeProviderConfig.model`
	 * (and `isReasoningModel`) with something the caller never saw. When
	 * present, its return value REPLACES `maxTokens` above for that call.
	 *
	 * Exists because a caller that extracts provider config up front (e.g.
	 * `extractProviderConfig(config)`, before calling `getAgentModelAsync`)
	 * cannot know the model `createProviderModel` will actually build
	 * against: `getAgentModelAsync` may substitute a task-specific override
	 * (`fetchTaskSpecificConfig`) or an API-fetched config
	 * (`fetchAiConfigFromApi`) that differs from what the caller extracted.
	 * A model-dependent budget (e.g. `reasoningOutputAllowanceForConfig`)
	 * computed against the pre-resolution model would silently apply to the
	 * wrong model, or not apply at all when the caller had no config to read
	 * (issue #2781 review finding).
	 */
	maxTokensForConfig?: (config: RuntimeProviderConfig) => number;
	/** Retry count for progressive temperature reduction */
	retryCount?: number;
	/** Task type for user preference lookup (e.g., "TOOL_CALLING", "CHAT") */
	taskType?: string;
	/** Max retries for rate limit errors (default: 10) */
	maxRetries?: number;
}

/**
 * Default output-token budget when a caller asks for nothing specific.
 *
 * The previous value was a bare `4000`, which predates the catalog and is a
 * fraction of what the models actually in use allow (Claude Sonnet 5 is rated
 * at 128,000). It silently capped every agent that did not pass an explicit
 * `maxTokens` — the sibling Vercel AI SDK path has sent explicit budgets since
 * #2198, so the two halves of the product disagreed by 8×.
 *
 * 32,768 mirrors `MAXIMAL_OUTPUT_TOKEN_CEILING` in
 * `@repo/ai`'s `output-token-budget.ts`. It is deliberately NOT the catalog
 * maximum: several providers admit requests against their rate limits using the
 * REQUESTED `max_tokens` rather than the tokens generated, so asking for a
 * model's full 128,000 can 429 every call on a deployment whose quota sits below
 * the model's theoretical ceiling.
 */
const DEFAULT_OUTPUT_TOKEN_BUDGET = 32_768;

/**
 * Ceiling on the share of a model's context window a DEFAULT output
 * reservation may claim.
 *
 * Anthropic requires `input + max_tokens` to fit the window, so a large default
 * eats headroom the prompt needs — at 4,000 that was unreachable, at 32,768 it
 * is not, on a small-context model carrying a long tool-calling history.
 *
 * The exact input-aware clamp the Vercel AI SDK path performs is unavailable
 * here: agents construct the model first and invoke it with messages later, so
 * the prompt size is genuinely unknown at this point. A proportional guard is
 * the honest stand-in — it bounds the reservation against the model's capacity
 * without pretending to know what the prompt will be.
 */
const MAX_CONTEXT_SHARE_FOR_OUTPUT = 0.25;

/**
 * Resolve the `max_tokens` to send, clamped to what the resolved model actually
 * allows.
 *
 * The clamp is the point: a caller asking for 32,768 against
 * `llama-3-3-70b` (catalog cap 8,192) would otherwise 400 on every request. When
 * the catalog is silent — an embedding model, a custom serving endpoint, a
 * provider we have no row for — the requested value stands, because inventing a
 * ceiling for an unknown model is how you truncate a model that could have done
 * more.
 *
 * @param requested Explicit budget from the caller, when it has a reason.
 * @param config Resolved provider config; carries the catalog caps when the
 *   task-config endpoint supplied them.
 */
export function resolveOutputTokenBudget(
	requested: number | undefined,
	config?: Pick<
		RuntimeProviderConfig,
		"maxOutputTokens" | "contextWindow"
	> | null,
): number {
	const desired = requested ?? DEFAULT_OUTPUT_TOKEN_BUDGET;

	const caps: number[] = [];
	if (config?.maxOutputTokens && config.maxOutputTokens > 0) {
		caps.push(config.maxOutputTokens);
	}
	// The context guard applies to the DEFAULT only. An explicit request is a
	// caller stating a need it understands (the document agents size their
	// budget from the document they are rewriting); silently shrinking that
	// would reintroduce truncation at a different layer.
	if (
		requested === undefined &&
		config?.contextWindow &&
		config.contextWindow > 0
	) {
		caps.push(
			Math.floor(config.contextWindow * MAX_CONTEXT_SHARE_FOR_OUTPUT),
		);
	}
	if (caps.length === 0) {
		return desired;
	}
	// No floor. A floor would raise a genuinely small catalog cap into an
	// OVER-ask, which the provider rejects outright — the same failure class
	// this helper exists to remove. Under-asking only costs output length, so
	// when the catalog and the caller disagree, the catalog wins.
	return Math.min(desired, Math.min(...caps));
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Gateway providers that use OpenAI-compatible API with a custom baseURL.
 * These route requests to underlying AI providers based on model prefix.
 *
 * NOTE: This list must match GATEWAY_PROVIDERS in @repo/database.
 * The source of truth is the database - this is just for provider type detection.
 */
const GATEWAY_PROVIDERS = [
	"VERCEL_AI_GATEWAY", // Legacy alias
	"VERCEL_GATEWAY",
	"CLOUDFLARE_AI",
	"OPENROUTER",
] as const;

/**
 * OpenAI-compatible providers (use ChatOpenAI with custom baseURL)
 * NOTE: AZURE_AI_FOUNDRY is NOT in this list - it requires special handling with AzureChatOpenAI
 */
const OPENAI_COMPATIBLE_PROVIDERS = [
	"TOGETHER_AI",
	"FIREWORKS",
	"PERPLEXITY",
	"XAI",
	"MISTRAL_AI",
	"COHERE",
	"DEEPSEEK",
	"CEREBRAS",
] as const;

/**
 * Reasoning models that require special handling:
 * 1. Use `max_completion_tokens` instead of `max_tokens`
 * 2. Only support temperature=1 (no custom temperature values)
 *
 * Per Microsoft/OpenAI documentation:
 * - o1 series models only work with max_completion_tokens and temperature=1
 * - o3 series models only work with max_completion_tokens and temperature=1
 * - gpt-5-nano (reasoning model) only works with max_completion_tokens and temperature=1
 *
 * For these models, we omit both maxTokens and temperature parameters:
 * 1. LangChain's AzureChatOpenAI doesn't have a direct maxCompletionTokens option
 * 2. These models have their own internal completion limits
 * 3. Passing max_tokens causes a 400 BadRequestError
 * 4. Passing temperature != 1 causes a 400 BadRequestError
 */
// Replaced in PR 5 by MODEL_FAMILIES below. Kept the docstring above for
// historical context — the substring-strip rationale still applies but is
// now expressed via `requiresParamStrip: true` on each MODEL_FAMILIES entry.

/**
 * Azure AI Foundry deployments for `gpt-4o*` / `gpt-4.1*` are routed through
 * the **Responses API**, which (unlike OpenAI's direct Chat Completions for
 * the same model names) rejects `max_tokens` with HTTP 400 and refuses any
 * `temperature` other than the default. This list is checked **only** on
 * the Azure branch of `createProviderModel` so we can strip those two
 * fields for Azure deployments without disturbing OPENAI_DIRECT requests,
 * which still go through Chat Completions and accept both parameters
 * normally. Splitting this from `REASONING_MODELS` prevents the strip
 * from leaking across providers (previous regression: direct OpenAI
 * gpt-4o tenants lost their token cap because the merged list applied
 * to both branches).
 */
const AZURE_RESPONSES_API_MODELS = [
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4o",
	"gpt-4o-mini",
] as const;

/**
 * Allowlist of canonical model names whose provider API natively emits
 * reasoning content blocks during inference. Distinct from the existing
 * REASONING_MODELS constant above — that list controls temperature/maxTokens
 * stripping for OpenAI o-series and gpt-5 family. THIS list controls whether
 * the model factory passes `thinking` / `reasoning` configuration to opt the
 * model into emitting reasoning content (and reasoning summary text).
 *
 * Allowlisted families (verified end-to-end emission of reasoning content):
 *   - Anthropic claude-(sonnet|opus|haiku)-4-*  — supports `thinking`
 *   - OpenAI o1-*, o3-*, o4-*                   — supports `reasoning_effort` + reasoning blocks
 *   - OpenAI gpt-5 family (excluding `gpt-5-chat*`) — Responses API: supports
 *     `reasoning_effort` + `reasoning.summary` text per OpenAI Responses API
 *     docs (verified for gpt-5, gpt-5-nano, gpt-5-mini, gpt-5-pro,
 *     gpt-5.1*, gpt-5.2*, gpt-5.4*). The regex deliberately excludes
 *     `gpt-5-chat-latest`, the non-reasoning flagship chat variant.
 *
 * NOT in this list (intentionally):
 *   - gpt-4o, gpt-4.1                          — catalog flag is editorial; do not accept reasoning_effort
 *   - gpt-5-chat*                              — chat-tuned variant, no reasoning_effort
 *   - Gemini, Groq, Mistral                    — not in v1 scope
 *
 * Scope note (vs reverted PR #1038): this list intentionally affects the
 * OPENAI_DIRECT branch only. Azure AI Foundry routing through Responses API
 * requires per-tenant deployment configuration; that path is deferred to a
 * follow-up. Gateway providers (Vercel AI Gateway etc.) are tracked under a
 * separate ticket.
 */
// =============================================================================
// MODEL_FAMILIES — single source of truth for reasoning capability
// =============================================================================
//
// Consolidates the three v1 regex lists (REASONING_MODELS substring list,
// REASONING_CAPABLE_PATTERNS anchored regex list, GATEWAY_REASONING_CAPABLE_PATTERNS
// regex list) into ONE exported table. Every downstream capability check —
// Direct branch reasoning enrolment, Direct branch temperature/maxTokens
// stripping, Gateway branch reasoning enrolment — reads from this table via
// `findFamily()`. Adding a new model family requires editing exactly one
// place.
//
// **Scope of "single source of truth":** this table covers LangChain
// send-side reasoning kwargs ONLY. Other layers have their own model lists
// for different purposes:
//   - `packages/database/prisma/queries/model-resolution.ts` (database
//     resolution heuristic) — separate concern: which model to use for a
//     given task/user preference.
//   - `packages/database/prisma/ai-model-catalog.ts` (UI capability flags
//     + provider mappings) — separate concern: which models show up where
//     in the Reasoning task picker UI.
// A cross-layer audit is documented as Q4-style follow-up — out of scope
// for PR 5.
//
// **Defense-in-depth posture (Codex pass #3 B2):** when MODEL_FAMILIES
// matches a name that the catalog does NOT flag with REASONING capability
// (e.g. `gpt-5-mini` / `gpt-5-nano`), runtime is permissive (it enrols
// reasoning kwargs if the regex matches) while the UI is restrictive (the
// catalog flag governs picker visibility). Both directions are safer than
// the alternatives: restrictive runtime would fail silently on API
// overrides; permissive UI would make product claims the team may not
// want to make for smaller variants.

/**
 * Reasoning capability descriptor for a single model family. The fields
 * map to the three downstream enrolment paths:
 *
 * - `directBranchReasoning`: kwargs spread into the OPENAI_DIRECT /
 *   ANTHROPIC_DIRECT branch's ChatOpenAI / ChatAnthropic constructor.
 *   Null means the family is not reasoning-capable on the Direct branch.
 * - `gatewayReasoning`: kwargs spread into the Vercel Gateway branch's
 *   ChatOpenAI constructor's `modelKwargs` (the field is forwarded to the
 *   wire body root). Different shape from `directBranchReasoning`:
 *   Anthropic via gateway uses `reasoning: { enabled, max_tokens }` (Vercel
 *   extension that maps to Anthropic's thinking budget), while OpenAI via
 *   gateway uses `reasoning: { effort }` (OpenAI's Chat Completions native
 *   shape that Vercel forwards intact).
 * - `requiresParamStrip`: when true, OPENAI_DIRECT temperature + maxTokens
 *   are stripped from the wire body. Mirrors the v1 `REASONING_MODELS`
 *   substring list. Most reasoning-capable families need this; Anthropic
 *   is handled separately via `applyReasoningConfig`.
 */
export interface ModelFamily {
	readonly id: string;
	readonly matches: (model: string) => boolean;
	readonly directBranchReasoning: Record<string, unknown> | null;
	readonly gatewayReasoning: Record<string, unknown> | null;
	readonly requiresParamStrip: boolean;
}

// Belt + suspenders immutability:
//   - `readonly` on every ModelFamily field gives TypeScript compile-time
//     enforcement against `MODEL_FAMILIES[0].requiresParamStrip = false`.
//   - `Object.freeze` adds runtime enforcement on the outer array (cannot
//     push / splice / replace entries). Per ECMAScript spec the freeze is
//     SHALLOW — inner ModelFamily objects are not deep-frozen at runtime —
//     but the readonly types above close the gap by rejecting field
//     assignments at compile time. A renegade `as any` cast at runtime
//     could still mutate inner fields; that's out of scope.
export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze([
	{
		id: "anthropic-claude-4",
		// Matches both `anthropic/claude-...` (gateway routing notation) and
		// `claude-...` (Direct branch canonical names). Same family — same
		// kwargs apply regardless of routing prefix; the prefix is purely a
		// gateway hint, not a different model.
		matches: (m: string) =>
			/^(anthropic\/)?claude-(sonnet|opus|haiku)-4[-.]/i.test(m),
		directBranchReasoning: {
			thinking: { type: "enabled", budget_tokens: 5000 },
		},
		gatewayReasoning: { reasoning: { enabled: true, max_tokens: 5000 } },
		// Anthropic's thinking-incompatible-kwarg strip happens via
		// applyReasoningConfig on the Direct branch and via the Gateway
		// branch's explicit temperature/maxTokens omission. Substring strip
		// for OpenAI is not applicable here.
		requiresParamStrip: false,
	},
	{
		id: "openai-o-series",
		// o1 / o3 / o4 series. Gateway notation `openai/o3` and bare `o3`
		// both match. Anchored to prevent matching e.g. "o-other-thing".
		matches: (m: string) => /^(openai\/)?o[134](-|$)/i.test(m),
		directBranchReasoning: {
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		},
		gatewayReasoning: { reasoning: { effort: "medium" } },
		requiresParamStrip: true,
	},
	{
		id: "openai-gpt-5",
		// gpt-5 family — excludes `gpt-5-chat*` (non-reasoning chat-tuned
		// variant). Negative lookahead prevents `gpt-5-chat-latest` while
		// still covering bare `gpt-5`, dashed variants (`gpt-5-nano`,
		// `-mini`, `-pro`), and dotted versions (`gpt-5.1`, `gpt-5.1-codex`,
		// `gpt-5.2`, `gpt-5.4`, `gpt-5.5`).
		matches: (m: string) => /^(openai\/)?gpt-5(?!-chat)(-|\.|$)/i.test(m),
		directBranchReasoning: {
			reasoning: { effort: "medium", summary: "detailed" },
			useResponsesApi: true,
		},
		gatewayReasoning: { reasoning: { effort: "medium" } },
		requiresParamStrip: true,
	},
	{
		id: "openai-codex-mini",
		// codex-mini doesn't emit reasoning content text but still requires
		// the OpenAI param strip (uses `max_completion_tokens`, rejects
		// `temperature != 1`). Direct branch: null reasoning + param strip.
		// Gateway branch: null reasoning (not in scope for v1 gateway
		// enrolment).
		matches: (m: string) => /^(openai\/)?codex-mini$/i.test(m),
		directBranchReasoning: null,
		gatewayReasoning: null,
		requiresParamStrip: true,
	},
] as const);

/**
 * Internal helper: find the family that matches a model name, or undefined.
 * Match is first-wins by definition order in MODEL_FAMILIES.
 */
function findFamily(model: string): ModelFamily | undefined {
	if (!model) {
		return undefined;
	}
	return MODEL_FAMILIES.find((f) => f.matches(model));
}

/**
 * Extra output-token budget for reasoning-capable models, sized from
 * measured production spend on a Databricks-served Claude Sonnet 5 endpoint
 * (issue #2781): a turn against that same endpoint spent roughly
 * 9,000-10,000 tokens on invisible thinking alone before emitting any
 * visible output, because thinking tokens count against the same
 * `max_tokens` cap as the visible response. 12,000 leaves headroom above
 * that measurement without being an open-ended reservation — asking for
 * more output tokens than a call will use doesn't cost anything toward
 * truncation, but it DOES trade truncation risk for provider TPM 429s on
 * providers that admit requests against their rate limit using the
 * requested `max_tokens` rather than tokens actually generated (same
 * tradeoff documented on `DEFAULT_OUTPUT_TOKEN_BUDGET` above).
 */
export const REASONING_OUTPUT_TOKEN_ALLOWANCE = 12_000;

/**
 * Matches an Anthropic reasoning-capable model name, tolerant of arbitrary
 * catalog prefixes (`system.ai.`, `anthropic/`, `databricks-`, a bare name,
 * ...) and both Anthropic naming eras:
 *   - newer, role before version — `claude-sonnet-5`, `claude-opus-4-1`
 *   - older, version before role — `claude-3-7-sonnet`
 *
 * Deliberately NOT derived from `MODEL_FAMILIES`'s `anthropic-claude-4`
 * matcher: that regex is anchored to the `anthropic/`/bare-`claude-` prefix
 * only and stops at the 4.x family, because widening it would also widen
 * what Direct/Gateway-branch reasoning-kwarg enrolment matches — a
 * different, narrower concern than this allowance. This pattern instead
 * needs to match whatever a real catalog serving-endpoint name carries, and
 * every reasoning-capable Anthropic version (3.7 and up).
 */
// Trailing lookahead `(?=$|[^a-z0-9])` requires the version to end the
// string or be followed by a non-alphanumeric — without it,
// `claude-sonnet-4o` (a real, non-reasoning-in-this-context OpenAI-flavored
// suffix pattern) or `claude-opus-3.7beta` would match on their leading
// digits alone and falsely report reasoning capability (Codex review,
// issue #2781 follow-up).
const ANTHROPIC_ROLE_FIRST_VERSION_RE =
	/(?:^|[^a-z])claude-(?:sonnet|opus|haiku)-(\d+)(?:[.-](\d+))?(?=$|[^a-z0-9])/i;
// Role-final `\b` already gives this pattern an equivalent boundary.
const ANTHROPIC_VERSION_FIRST_ROLE_RE =
	/(?:^|[^a-z])claude-(\d+)[.-](\d+)-(?:sonnet|opus|haiku)\b/i;

/**
 * Anthropic versions below this don't reason (3.5 and earlier, and a bare
 * `claude-3-<role>` with no minor — treated as having no matchable version
 * at all, since neither regex above matches it). 3.7 and every 4.x/5.x
 * release do.
 *
 * Compared as separate integer major/minor components, NOT as a decimal —
 * `Number("3.10")` collapses to `3.1`, which would wrongly reject a
 * hypothetical `claude-3-10-sonnet` as below the 3.7 threshold (Codex
 * review, issue #2781 follow-up).
 */
const MIN_ANTHROPIC_REASONING_MAJOR = 3;
const MIN_ANTHROPIC_REASONING_MINOR = 7;

function isAnthropicReasoningVersion(model: string): boolean {
	const match =
		ANTHROPIC_ROLE_FIRST_VERSION_RE.exec(model) ??
		ANTHROPIC_VERSION_FIRST_ROLE_RE.exec(model);
	if (!match) {
		return false;
	}
	const major = Number(match[1]);
	const minor = match[2] !== undefined ? Number(match[2]) : 0;
	return (
		major > MIN_ANTHROPIC_REASONING_MAJOR ||
		(major === MIN_ANTHROPIC_REASONING_MAJOR &&
			minor >= MIN_ANTHROPIC_REASONING_MINOR)
	);
}

/**
 * Returns {@link REASONING_OUTPUT_TOKEN_ALLOWANCE} for a model name whose
 * provider charges invisible thinking tokens against the same `max_tokens`
 * budget as the visible output — reasoning-capable Anthropic Claude
 * releases, OpenAI's o-series, and the gpt-5 family — else 0.
 *
 * The Anthropic branch is self-contained (see
 * {@link ANTHROPIC_ROLE_FIRST_VERSION_RE} doc for why it can't reuse
 * `MODEL_FAMILIES`). The OpenAI branch delegates to the existing
 * `findFamily` lookup in this same module — no export change needed, and
 * `MODEL_FAMILIES` already anchors correctly for OpenAI's o-series/gpt-5
 * naming.
 *
 * Name-based only — does not know a resolved config's `isReasoningModel`
 * flag. Use {@link reasoningOutputAllowanceForConfig} when a
 * `RuntimeProviderConfig` is available; see that function's doc for why
 * `isReasoningModel` can only ADD to what this name check finds, never
 * subtract from it.
 */
export function reasoningOutputAllowance(
	model: string | null | undefined,
): number {
	if (!model) {
		return 0;
	}
	if (isAnthropicReasoningVersion(model)) {
		return REASONING_OUTPUT_TOKEN_ALLOWANCE;
	}
	if (findFamily(model)?.directBranchReasoning != null) {
		return REASONING_OUTPUT_TOKEN_ALLOWANCE;
	}
	return 0;
}

/**
 * Config-aware variant of {@link reasoningOutputAllowance}.
 *
 * `RuntimeProviderConfig.isReasoningModel` does NOT mean "this is a
 * reasoning model" in general — its established semantics are narrower:
 * "this model emits DeepSeek-R1-style `<think>` reasoning tags" (see
 * `isReasoningModelName` in `./databricks-compat.ts`, which only matches
 * `deepseek-r1`/`deepseek-reasoner`/`r1-distill` patterns, and the identical
 * doc-comment on `@repo/ai`'s `model-factory.ts`). The producers of this
 * field (`apps/web/app/api/agents/ai-config/route.ts` and its `/task`
 * sibling) set `isReasoningModel: isReasoningModelName(canonicalName)`
 * unconditionally — every non-R1 model, INCLUDING Anthropic's own
 * thinking-capable Claude releases, resolves to `isReasoningModel: false`.
 * So `false` is not evidence that a model doesn't spend output budget on
 * invisible reasoning — it only means "not R1-shaped" — and must not
 * suppress the name-based check below it: `system.ai.claude-sonnet-5` (the
 * issue #2781 incident model) resolves to `isReasoningModel: false` on
 * every path that populates the flag, and is exactly the model this
 * allowance exists to cover. Only `isReasoningModel: true` is used;
 * `false`/`undefined` both fall through to the name check.
 */
export function reasoningOutputAllowanceForConfig(
	config: Pick<RuntimeProviderConfig, "model" | "isReasoningModel">,
): number {
	if (config.isReasoningModel === true) {
		// R1-style <think> reasoning also spends output budget.
		return REASONING_OUTPUT_TOKEN_ALLOWANCE;
	}
	return reasoningOutputAllowance(config.model);
}

export function isReasoningCapableModel(
	canonicalName: string,
	provider: RuntimeProviderConfig["provider"],
): boolean {
	if (!canonicalName) {
		return false;
	}
	// Only meaningful for providers whose LangChain wrapper exposes a
	// reasoning/thinking kwarg.
	if (provider !== "ANTHROPIC_DIRECT" && provider !== "OPENAI_DIRECT") {
		return false;
	}
	const family = findFamily(canonicalName);
	return family?.directBranchReasoning != null;
}

/**
 * Providers whose request bodies accept the Vercel AI Gateway reasoning
 * extension (`reasoning: { enabled: true, max_tokens: <n> }` at the top
 * level of an OpenAI Chat Completions body). This is a Vercel-specific
 * extension — `CLOUDFLARE_AI` and `OPENROUTER` (also in GATEWAY_PROVIDERS)
 * do NOT honor it and may 4xx on unknown top-level fields, so they are
 * deliberately excluded.
 *
 * Reference: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions/advanced
 */
const VERCEL_GATEWAY_PROVIDERS = [
	"VERCEL_AI_GATEWAY",
	"VERCEL_GATEWAY",
] as const;

/**
 * Back-compat shim from PR #1049 (F-1171). Some existing tests and call
 * sites narrow on "is this specifically the Claude 4.x family". Reads
 * MODEL_FAMILIES so it stays consistent with the consolidated table.
 *
 * For the generalized check (any reasoning-capable family that goes
 * through Vercel Gateway), use {@link isGatewayReasoningCapableModel}.
 */
export function isGatewayClaudeReasoningModel(model: string): boolean {
	return findFamily(model)?.id === "anthropic-claude-4";
}

/**
 * Generalized check: does this model belong to any family that the Vercel
 * Gateway can enroll for reasoning? Returns true for Anthropic Claude 4.x,
 * OpenAI o-series, and OpenAI gpt-5 family (codex-mini excluded — no
 * reasoning emission). Returns false for chat-tuned variants like
 * `gpt-5-chat-latest`, non-reasoning families (gpt-4o, claude 3.x), and
 * any model not in MODEL_FAMILIES.
 */
export function isGatewayReasoningCapableModel(model: string): boolean {
	return findFamily(model)?.gatewayReasoning != null;
}

/**
 * Returns the kwarg payload that opts a Vercel-Gateway-routed model into
 * reasoning emission, or null when (a) the provider is not a Vercel
 * gateway, or (b) the model's family does not have gateway reasoning
 * kwargs declared. The dual gate is critical: other gateway providers
 * (CLOUDFLARE_AI, OPENROUTER) share the GATEWAY_PROVIDERS list but do NOT
 * accept the Vercel `reasoning` extension on their request bodies; the
 * helper returns null for them so they pass through unchanged.
 *
 * Body shape varies per family (PR 5 multi-family extension):
 *   - Anthropic Claude 4.x: `reasoning: { enabled: true, max_tokens: 5000 }`
 *     — Vercel Chat Completions extension that maps `max_tokens` to
 *     Anthropic's thinking budget. Matches the ANTHROPIC_DIRECT branch's
 *     5000-token budget for consistency. Verified shipping in PR #1049.
 *   - OpenAI o-series + gpt-5: `reasoning: { effort: "medium" }` —
 *     OpenAI's native Chat Completions shape that Vercel forwards intact
 *     to the OpenAI Responses API. `"medium"` matches the default effort
 *     used by `getReasoningConfig()` for the OPENAI_DIRECT branch. PR 5
 *     v1 omits `summary: "detailed"` to keep the gateway path narrowly
 *     scoped to what Vercel's docs document. Adding the summary field is
 *     a known-safe future extension if direct-vs-gateway parity becomes
 *     a complaint.
 */
export function getGatewayReasoningConfig(
	model: string,
	provider: RuntimeProviderConfig["provider"],
): Record<string, unknown> | null {
	if (!provider) {
		return null;
	}
	if (!(VERCEL_GATEWAY_PROVIDERS as readonly string[]).includes(provider)) {
		return null;
	}
	return findFamily(model)?.gatewayReasoning ?? null;
}

/**
 * Returns provider-specific kwargs that opt the model into emitting
 * reasoning/thinking content. Returns null if the model is not
 * reasoning-capable per isReasoningCapableModel.
 *
 * Anthropic: `{ thinking: { type: "enabled", budget_tokens: 5000 } }`.
 *   Note: the @langchain/anthropic runtime throws if `temperature !== 1` or
 *   `topK`/`topP` are set alongside thinking (verified at
 *   node_modules/@langchain/anthropic/dist/chat_models.cjs:756-758).
 *   The caller MUST run applyReasoningConfig to strip those fields.
 *
 * OpenAI: `{ reasoning: { effort: "medium", summary: "detailed" }, useResponsesApi: true }`
 *   — both top-level parameters on ChatOpenAI (per
 *   @langchain/openai/dist/chat_models/base.d.ts:109 and the inherited
 *   `useResponsesApi` field at chat_models/index.cjs:553).
 *
 *   `reasoning.summary` requires the Responses API (Chat Completions silently
 *   drops the summary text). Setting `summary != null` auto-routes ChatOpenAI
 *   to Responses via `hasResponsesOnlyKwargs` at chat_models/index.cjs:571,
 *   but we also set `useResponsesApi: true` explicitly so the routing intent
 *   is self-documenting and survives future changes to that predicate.
 *
 *   OpenAI's public Responses API supports gpt-5 family + o-series natively;
 *   this opt-in is the difference between getting a `reasoning_tokens` count
 *   only (Chat Completions) vs human-readable reasoning summary content
 *   blocks consumed by chat-node-reasoning::extractReasoningFromContent.
 */
export function getReasoningConfig(
	canonicalName: string,
	provider: RuntimeProviderConfig["provider"],
): Record<string, unknown> | null {
	if (!isReasoningCapableModel(canonicalName, provider)) {
		return null;
	}
	// PR 5: directBranchReasoning kwargs live on the matched family. The
	// branch dispatch (ANTHROPIC_DIRECT vs OPENAI_DIRECT) is encoded
	// implicitly in the kwargs shape — Anthropic families return
	// `{ thinking: ... }`, OpenAI families return `{ reasoning: ..., useResponsesApi: ... }`.
	return findFamily(canonicalName)?.directBranchReasoning ?? null;
}

/**
 * Merges reasoning config into model kwargs, stripping any kwargs that
 * conflict with the provider's reasoning mode. For Anthropic with thinking
 * enabled, this means removing `temperature`, `topP`, `topK`. For OpenAI,
 * no strip is needed (the o-series temperature handling is owned by the
 * existing isReasoningModel branch in createProviderModel).
 *
 * Does NOT mutate the input. Returns a new object.
 */
export function applyReasoningConfig(
	modelKwargs: Record<string, unknown>,
	reasoningConfig: Record<string, unknown> | null,
	provider: RuntimeProviderConfig["provider"],
): Record<string, unknown> {
	if (!reasoningConfig) {
		return modelKwargs;
	}

	if (provider === "ANTHROPIC_DIRECT" && "thinking" in reasoningConfig) {
		// Strip the three params @langchain/anthropic rejects when
		// thinking is enabled (chat_models.cjs:756-758).
		const { temperature, topP, topK, ...rest } = modelKwargs;
		return { ...rest, ...reasoningConfig };
	}
	return { ...modelKwargs, ...reasoningConfig };
}

/**
 * Default max retries for rate limit errors (429).
 *
 * OpenAI/Azure return Retry-After headers with 429 responses.
 * The SDK respects these headers and waits appropriately.
 * Setting to 10 provides resilience for high-traffic scenarios.
 *
 * Note: This is separate from Temporal's activity retry policy.
 * SDK retries handle transient rate limits within a single activity execution.
 */
const DEFAULT_MAX_RETRIES = 10;

/**
 * Extended timeout for long-running OpenAI-compatible HTTP requests (15 minutes).
 *
 * Node.js's built-in fetch (via undici) has a default headersTimeout of
 * 5 minutes. Some long-running LLM calls routed through AI gateways or other
 * OpenAI-compatible providers/baseUrl endpoints can exceed this, causing a
 * "Headers Timeout Error" / GatewayTimeoutError.
 *
 * Originally introduced for gateway traffic, this timeout is also used for
 * non-gateway OpenAI-compatible providers and the generic baseUrl fallback.
 *
 * @see https://vercel.com/docs/ai-gateway/capabilities/video-generation#extending-timeouts-for-node.js
 */
const GATEWAY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Shared undici Agent with extended timeouts. Reused across all requests
 * to preserve connection pooling and avoid socket/resource leaks.
 */
const extendedTimeoutAgent = new UndiciAgent({
	headersTimeout: GATEWAY_TIMEOUT_MS,
	bodyTimeout: GATEWAY_TIMEOUT_MS,
});

/**
 * Custom fetch with extended undici timeouts for long-running
 * OpenAI-compatible requests. Uses a shared agent for connection pooling.
 *
 * Calls undici's OWN fetch, not Node's built-in fetch: an undici@8 Agent passed
 * as a dispatcher to the built-in fetch is rejected at request time (`invalid
 * onRequestStart method`), because the built-in fetch is powered by Node's
 * internal (older) undici. undici's fetch accepts its own Agent. The Agent
 * applies the extended transport timeout.
 *
 * undici's fetch is a distinct implementation, so it can't consume a global
 * `Request` object (it throws "Failed to parse URL from [object Request]"). When
 * one is passed, forward its URL and fold its full request state into init —
 * matching `fetch(request, init)` semantics, with explicit `init` winning.
 * Strings and URL objects pass straight through.
 */
function gatewayFetch(
	url: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
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
 * `fetch` for Databricks serving endpoints. Composes the Databricks compat shim
 * (`createDatabricksFetch` — strips the 400-triggering `stream_options` request
 * field AND flattens Claude's array-shaped response `delta.content` so
 * `@langchain/openai`'s stream loop doesn't drop every chunk as "non-string
 * content") over `gatewayFetch`, so the extended-timeout dispatcher still applies
 * to these (often long-running) inference calls.
 *
 * The shim lives in `./databricks-compat` (a mirror of `@repo/ai`'s copy — the
 * agent bundle deliberately can't import `@repo/ai`).
 *
 * `<think>` reasoning stripping is NOT enabled here — it's decided per model in
 * the DATABRICKS branch of `createProviderModel` (which knows the resolved
 * `isReasoningModel` signal), since a module singleton can't tell an R1 endpoint
 * from a Claude/Llama one (Bug #1942 review). This base fetch handles the
 * request-field strip + content-array flatten that ALL Databricks models need.
 */
const databricksFetch: typeof fetch = createDatabricksFetch(gatewayFetch);

/**
 * Databricks fetch WITH `<think>` reasoning stripping, for R1 endpoints. Built
 * lazily+cached so the common (non-reasoning) path keeps using `databricksFetch`.
 */
let databricksFetchStripReasoningInstance: typeof fetch | undefined;
function databricksReasoningFetch(): typeof fetch {
	if (!databricksFetchStripReasoningInstance) {
		databricksFetchStripReasoningInstance = createDatabricksFetch(
			gatewayFetch,
			{ stripReasoning: true },
		);
	}
	return databricksFetchStripReasoningInstance;
}

/**
 * Check if a model is a reasoning model that requires the OpenAI-style
 * param strip (temperature + maxTokens omitted; uses max_completion_tokens
 * on the wire). Now reads `requiresParamStrip` from MODEL_FAMILIES.
 *
 * PR 5 behavior parity vs the v1 substring list: the v1 list matched
 * canonical name substrings (so e.g. `gpt-5-mini-20251015` matched
 * `gpt-5-mini`). MODEL_FAMILIES regexes are prefix-anchored, so
 * variant-with-date-suffix matches automatically without a substring
 * fallback. Verified against the existing test cases in
 * `__tests__/langchain-models.test.ts`.
 */
function isReasoningModel(model: string): boolean {
	return findFamily(model)?.requiresParamStrip ?? false;
}

/**
 * Check whether an Azure deployment name corresponds to a chat model that
 * Azure AI Foundry serves through the Responses API. Same matching logic
 * as `isReasoningModel`. Caller is responsible for only invoking this on
 * the Azure provider branch.
 */
function isAzureResponsesApiModel(model: string): boolean {
	const normalizedModel = model.toLowerCase();
	return AZURE_RESPONSES_API_MODELS.some(
		(name) =>
			normalizedModel === name.toLowerCase() ||
			normalizedModel.includes(name.toLowerCase()),
	);
}

// ============================================================================
// Provider-Aware Model Factory (NEW)
// ============================================================================

/**
 * Create a LangChain chat model from runtime provider configuration.
 *
 * This is the primary entry point for creating models in LangGraph agents.
 * It routes to the appropriate SDK based on the provider type:
 * - Gateways (Vercel, OpenRouter, Cloudflare) → ChatOpenAI with baseURL
 * - Direct providers (Groq, OpenAI, Anthropic) → Native SDKs
 *
 * @param config - Provider configuration from runtime
 * @param options - Model creation options
 * @returns A LangChain BaseChatModel instance
 */
export function createProviderModel(
	config: RuntimeProviderConfig,
	options: ModelOptions = {},
): BaseChatModel {
	// Debug logging to trace provider detection
	console.log("[LangChainModels] createProviderModel called with:", {
		provider: config.provider,
		model: config.model,
		hasBaseUrl: !!config.baseUrl,
		baseUrl: config.baseUrl,
		deploymentName: config.deploymentName,
		isAzure: config.provider === "AZURE_AI_FOUNDRY",
	});

	// Use config as-is - do NOT convert gateway providers
	// Gateway API keys only work with their respective gateway URLs
	const { provider, apiKey, model, baseUrl } = config;

	// Calculate temperature with retry reduction
	let temperature = options.temperature ?? 0.7;
	if (options.retryCount !== undefined && options.retryCount > 0) {
		temperature = Math.max(0.1, temperature - options.retryCount * 0.1);
	}

	// Single choke point for `maxTokensForConfig` (issue #2781 review): every
	// `createProviderModel` call inside `getAgentModelAsync` — the runtime
	// config path, the task-specific-preference override path, and the
	// API-fallback path — lands here with the FINAL resolved `config`, so a
	// caller-supplied budget function computed against the pre-resolution
	// model (which may differ, e.g. a task override substituting a different
	// model) always sees the model that is actually about to be used.
	//
	// The logged value below is what was REQUESTED, not necessarily what the
	// wire request ends up carrying: the OPENAI_DIRECT reasoning branch, the
	// Vercel-gateway reasoning branch, and the legacy Azure Responses-API
	// branch all drop `maxTokens`/`temperature` from the constructor entirely
	// (those providers 400 on the param; the strips below are deliberate, not
	// a bug), so on those branches this requested value is advisory only —
	// see each branch's own `stripParams`/`stripChatCompletionsParams`
	// handling for the actual behavior.
	const requestedMaxTokens = options.maxTokensForConfig
		? options.maxTokensForConfig(config)
		: options.maxTokens;
	if (options.maxTokensForConfig) {
		console.log("[LangChainModels] maxTokensForConfig applied", {
			model: config.model,
			requestedMaxTokens,
		});
	}
	const maxTokens = resolveOutputTokenBudget(requestedMaxTokens, config);
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	// Extract model name without provider prefix if present
	const modelName = model.includes("/") ? model.split("/")[1] : model;

	// Gateways use OpenAI-compatible API
	if (provider && GATEWAY_PROVIDERS.includes(provider as any)) {
		if (!baseUrl) {
			throw new Error(
				`[LangChainModels] Gateway provider ${provider} requires a base URL. ` +
					"The base URL should be provided via runtime headers or API config.",
			);
		}

		// Detect reasoning eligibility from the FULL model string (gateway
		// routes by `provider/model` notation — strip would lose the prefix
		// that distinguishes "anthropic/claude-..." from a routing alias).
		// The helper double-gates on provider: only Vercel gateways accept
		// the `reasoning: { ... }` body extension — CLOUDFLARE_AI and
		// OPENROUTER would 4xx on it (helper returns null in those cases).
		//
		// PR 5: getGatewayReasoningConfig now returns per-family kwargs.
		// The shape on the wire differs by family (Anthropic gets
		// `{ enabled, max_tokens }`, OpenAI o-series + gpt-5 get
		// `{ effort }`). The log line surfaces which family was enrolled
		// so production debugging can distinguish drift.
		// Look the family up once and derive every gateway-branch decision
		// from it. Both `enrollReasoning` (drives reasoning kwargs +
		// `__includeRawResponse`) and `stripParams` (drives the
		// temperature/maxTokens omission) read from the same family record.
		// They DIFFER for `openai-codex-mini`: that family has
		// `gatewayReasoning: null` (no reasoning emission) but
		// `requiresParamStrip: true` (OpenAI Responses API rejects
		// `temperature != 1` and `max_tokens` regardless of routing path).
		// Without this split, codex-mini routed via gateway would HTTP 400
		// on every call. Catalog has no codex-mini entry today, so this is
		// a latent guard rather than an active code path — but the table
		// is the contract and we honor it.
		const family = findFamily(model);
		const gatewayReasoning = family?.gatewayReasoning ?? null;
		const enrollReasoning =
			gatewayReasoning !== null &&
			(VERCEL_GATEWAY_PROVIDERS as readonly string[]).includes(provider);
		const stripParams =
			enrollReasoning || family?.requiresParamStrip === true;
		const reasoningFamily = enrollReasoning
			? (family?.id ?? "(unknown)")
			: "(none)";

		console.log(
			`[LangChainModels] Creating gateway model: ${model} via ${baseUrl}${
				enrollReasoning
					? ` (reasoning enabled, family=${reasoningFamily})`
					: ""
			}${
				stripParams && !enrollReasoning
					? ` (param strip only, family=${family?.id ?? "(unknown)"})`
					: ""
			}`,
		);

		return new ChatOpenAI({
			model: model, // Keep full model string for gateway routing
			apiKey,
			// Drop temperature when EITHER reasoning is enrolled OR the family
			// requires param strip (e.g. codex-mini). Anthropic's extended
			// thinking requires `temperature === 1` (its default) and rejects
			// any other explicit value; OpenAI reasoning models likewise reject
			// `temperature != 1`. Omitting the field on the LangChain side lets
			// the OpenAI client strip it from the wire body so the Gateway
			// forwards a request with no temperature override.
			...(stripParams ? {} : { temperature }),
			// Drop maxTokens when EITHER reasoning is enrolled OR the family
			// requires param strip. Anthropic enforces
			// `thinking.budget_tokens < max_tokens` strictly; OpenAI reasoning
			// models reject `max_tokens` (require `max_completion_tokens`).
			// Either way, omit the field and let the upstream apply its default.
			...(stripParams ? {} : { maxTokens }),
			maxRetries,
			timeout: GATEWAY_TIMEOUT_MS,
			configuration: {
				baseURL: baseUrl,
				fetch: gatewayFetch,
			},
			// reasoning lives in modelKwargs so it spreads at the body root
			// (verified at @langchain/openai@1.2.7
			// /dist/chat_models/completions.cjs:47).
			...(enrollReasoning ? { modelKwargs: gatewayReasoning } : {}),
			// __includeRawResponse preserves the gateway's `choices[].message.reasoning`
			// text in `additional_kwargs.__raw_response` — without this flag, LangChain's
			// converter (converters/completions.cjs:163-199) drops it. The agent
			// extractReasoningFromMessage helper reads it back from there.
			...(enrollReasoning ? { __includeRawResponse: true } : {}),
		});
	}

	// ============================================================================
	// Cloud Providers - Require special handling with deployment-specific URLs
	// ============================================================================

	// Azure AI Foundry requires special handling with AzureChatOpenAI
	// Each Azure deployment has a unique URL that includes the resource name
	if (provider === "AZURE_AI_FOUNDRY") {
		if (!baseUrl) {
			throw new Error(
				"[LangChainModels] Azure AI Foundry requires a base URL (endpoint). " +
					"Please configure your Azure OpenAI endpoint in Settings → AI Providers. " +
					"Example format: https://{resource-name}.openai.azure.com",
			);
		}

		// Use user-configured deployment name if provided, otherwise fall back to model name
		// The deploymentName is what the user named their deployment in Azure (e.g., "my-gpt4-deployment")
		// This may differ from the model name in the catalog (e.g., "gpt-4o")
		const effectiveDeploymentName =
			config.deploymentName || modelName || model;

		// Azure AI Foundry exposes TWO endpoint shapes:
		//   1. Legacy Azure OpenAI: https://{resource}.openai.azure.com
		//      - Requires `?api-version=...` query parameter
		//      - Uses AzureChatOpenAI client (path: /openai/deployments/{name}/...)
		//   2. Project-scoped v1 Responses API: https://{resource}.services.ai.azure.com/api/projects/{project}/openai/v1
		//      - REJECTS `api-version` query parameter
		//      - OpenAI-compatible (path: /v1/chat/completions or /v1/responses)
		//      - Use plain ChatOpenAI with the URL as a custom baseURL
		// Detect shape (2) by the `/openai/v1` path marker and route to the
		// OpenAI-compatible client instead of AzureChatOpenAI.
		const isFoundryV1Endpoint = /\/openai\/v1(?:\/|$)/.test(baseUrl);
		if (isFoundryV1Endpoint) {
			console.log(
				`[LangChainModels] Creating Azure AI Foundry v1 (OpenAI-compatible) model: deployment=${effectiveDeploymentName} via ${baseUrl}`,
			);
			return new ChatOpenAI({
				model: effectiveDeploymentName,
				apiKey,
				temperature,
				maxTokens,
				maxRetries,
				timeout: GATEWAY_TIMEOUT_MS,
				configuration: {
					baseURL: baseUrl,
					// Azure AI Foundry's v1 endpoint expects the API key in
					// `api-key` header rather than `Authorization: Bearer`.
					defaultHeaders: { "api-key": apiKey },
					fetch: gatewayFetch,
				},
			});
		}

		// Check if this is a reasoning model (o1, o3, gpt-5-nano, etc.) OR
		// an Azure-only Responses API chat model (gpt-4o, gpt-4.1, ...).
		// Both classes require max_completion_tokens / default temperature on
		// the Azure-side endpoint. The Azure-only branch is split out from
		// REASONING_MODELS because direct OpenAI gpt-4o/gpt-4.1 still go
		// through Chat Completions and accept max_tokens normally — strip
		// must NOT apply there.
		//
		// IMPORTANT: capability detection runs against the canonical model
		// name (`modelName || model`), NOT `effectiveDeploymentName`.
		// `config.deploymentName` is user-defined and often differs from the
		// catalog name in production setups (e.g. `prod-chat` deployment
		// serving a `gpt-4o` model for multi-env routing). Detecting against
		// the deployment name would silently miss the strip for those
		// tenants and HTTP 400 would return. We also probe `deploymentName`
		// as a defensive fallback for installations where the deployment
		// name happens to encode the model (local dev pattern), so neither
		// configuration shape regresses.
		const canonicalNames = [modelName, model, config.deploymentName].filter(
			(n): n is string => Boolean(n),
		);
		const isReasoning = canonicalNames.some((n) => isReasoningModel(n));
		const isAzureResponsesApi = canonicalNames.some((n) =>
			isAzureResponsesApiModel(n),
		);
		const stripMaxTokensAndTemp = isReasoning || isAzureResponsesApi;

		console.log(
			`[LangChainModels] Creating Azure model: deployment=${effectiveDeploymentName} via ${baseUrl}, canonical=[${canonicalNames.join(",")}], isReasoningModel=${isReasoning}, isAzureResponsesApi=${isAzureResponsesApi}`,
		);

		// Do NOT pass maxTokens or temperature for reasoning models OR Azure
		// Responses-API chat models (both cause 400 errors on Azure side).
		// Reasoning models only support max_completion_tokens and temperature=1.
		if (stripMaxTokensAndTemp) {
			return new AzureChatOpenAI({
				azureOpenAIApiKey: apiKey,
				azureOpenAIApiDeploymentName: effectiveDeploymentName,
				azureOpenAIEndpoint: baseUrl,
				azureOpenAIApiVersion: "2024-10-21",
				maxRetries,
				// NOTE: maxTokens and temperature intentionally omitted for reasoning models
				// - maxTokens: These models use max_completion_tokens which LangChain doesn't directly support
				// - temperature: These models only support temperature=1 (the default)
			});
		}

		return new AzureChatOpenAI({
			azureOpenAIApiKey: apiKey,
			azureOpenAIApiDeploymentName: effectiveDeploymentName,
			azureOpenAIEndpoint: baseUrl,
			// Default API version - Azure requires this
			azureOpenAIApiVersion: "2024-10-21",
			temperature,
			maxTokens,
			maxRetries,
		});
	}

	// AWS Bedrock and Google Vertex AI also require special handling
	// These would need @langchain/aws or @langchain/google-gauth packages
	// For now, provide a clear error message
	if (provider === "AWS_BEDROCK") {
		throw new Error(
			"[LangChainModels] AWS Bedrock is not yet supported for LangGraph agents. " +
				"Please use a different AI provider (e.g., Vercel Gateway, OpenRouter, or a direct provider). " +
				"AWS Bedrock requires special authentication with AWS credentials.",
		);
	}

	if (provider === "GOOGLE_VERTEX_AI") {
		throw new Error(
			"[LangChainModels] Google Vertex AI is not yet supported for LangGraph agents. " +
				"Please use a different AI provider (e.g., Vercel Gateway, OpenRouter, or a direct provider). " +
				"Google Vertex AI requires special authentication with Google Cloud credentials.",
		);
	}

	// Databricks: OpenAI-compatible inference under the workspace host. A bare
	// host defaults to the GA classic path <host>/serving-endpoints; a URL that
	// already carries a path (e.g. the Unity AI Gateway <host>/ai-gateway/mlflow/v1)
	// is used verbatim. Handled before the generic OpenAI-compatible block because
	// that block uses baseUrl verbatim (never adds the serving-endpoints default).
	if (provider === "DATABRICKS") {
		if (!baseUrl) {
			throw new Error(
				"[LangChainModels] Databricks requires a base URL (workspace host). " +
					"Please configure it in Settings → AI Providers. " +
					"Example: https://xyz.cloud.databricks.com",
			);
		}
		const trimmedHost = baseUrl.trim().replace(/\/+$/, "");
		let hasPath = false;
		try {
			const { pathname } = new URL(trimmedHost);
			hasPath = pathname !== "" && pathname !== "/";
		} catch {
			hasPath = trimmedHost.endsWith("/serving-endpoints");
		}
		const servingBaseUrl = hasPath
			? trimmedHost
			: `${trimmedHost}/serving-endpoints`;
		// Omit `temperature` for ALL Databricks requests. Databricks-served
		// Anthropic Claude models reject it outright (`400 BAD_REQUEST: Model
		// us.anthropic.claude-... does not support the temperature parameter`),
		// and we CAN'T tell which endpoint serves Claude: custom per-workspace
		// serving endpoints have arbitrary names (e.g. `prod-chat`) and Databricks
		// endpoint discovery returns only `{ endpoints: [{ name }] }` — the name
		// reveals nothing about the underlying model family. Matching a name like
		// `/claude/` would still send `temperature` to a Claude-backed custom
		// endpoint and hit the same 400. This mirrors the working `@ai-sdk`/Vercel
		// path, which never injects a temperature for Databricks (each model just
		// uses its own default). Unlike `@ai-sdk`, `@langchain/openai`'s ChatOpenAI
		// always sends its default temperature unless the field is omitted here.
		//
		// `<think>` reasoning stripping: enable ONLY for a DeepSeek-R1 endpoint.
		// Prefer the explicit `config.isReasoningModel` signal (resolved from the
		// CANONICAL identity upstream — the alias reveals nothing, Bug #1942
		// review); fall back to a name check on the alias when it wasn't
		// propagated. A non-R1 model (Claude/Llama) keeps its literal `<think>`.
		const stripReasoning =
			config.isReasoningModel ?? isReasoningModelName(model);
		return new ChatOpenAI({
			// Serving-endpoint name (Databricks endpoint names contain no "/").
			model,
			apiKey,
			maxTokens,
			maxRetries,
			timeout: GATEWAY_TIMEOUT_MS,
			configuration: {
				baseURL: servingBaseUrl,
				// Databricks compat: strip `stream_options` + `parallel_tool_calls`
				// (rejected with HTTP 400) from the request and flatten Claude's
				// array-shaped response content so the stream loop doesn't drop
				// every chunk. Both fetch variants route through gatewayFetch's
				// extended timeout dispatcher. See ./databricks-compat.
				fetch: stripReasoning
					? databricksReasoningFetch()
					: databricksFetch,
			},
			// Required so `hoistRawStopReason` (output-truncation.ts) can recover
			// `choices[0].stop_reason` (with defensive fallback support for
			// `finish_reason`) from `additional_kwargs.__raw_response` — the
			// Databricks gateway omits stop/finish reasons from
			// `response_metadata` entirely (only `model_provider`/`usage` are
			// populated), so without this flag LangChain's converter drops the raw
			// envelope and there is nothing left to hoist from (issue #2781
			// follow-up; this branch previously left the flag unset, silently
			// making the hoist dead code on every Databricks-served model).
			// Retention is transient: agents using the reasoning-trace protocol
			// (e.g. project-document-generator) strip the envelope again via
			// `stripRawResponseEnvelope` right after `hoistRawStopReason` reads it.
			__includeRawResponse: true,
		});
	}

	// OpenAI-compatible providers
	if (provider && OPENAI_COMPATIBLE_PROVIDERS.includes(provider as any)) {
		if (!baseUrl) {
			throw new Error(
				`[LangChainModels] Provider ${provider} requires a base URL. ` +
					"Please configure the base URL in Settings → AI Providers.",
			);
		}
		return new ChatOpenAI({
			model: modelName || model,
			apiKey,
			temperature,
			maxTokens,
			maxRetries,
			timeout: GATEWAY_TIMEOUT_MS,
			configuration: {
				baseURL: baseUrl,
				fetch: gatewayFetch,
			},
		});
	}

	// Direct provider SDKs
	switch (provider) {
		case "OPENAI_DIRECT": {
			const rawName = modelName || model;
			const isReasoning = isReasoningModel(rawName);
			const reasoningConfig = getReasoningConfig(
				rawName,
				"OPENAI_DIRECT",
			);
			// Lowercase ONLY when we're going to opt into reasoning. Upstream
			// `@langchain/openai`'s wire-level isReasoningModel (misc.cjs:6-11)
			// is case-SENSITIVE: `model.startsWith("gpt-5")` and
			// `/^o\d/.test(model)`. Our REASONING_CAPABLE_PATTERNS uses the `/i`
			// flag, so we'd accept "GPT-5-Nano" or "O1-Mini" as reasoning-capable
			// while the wire gate silently rejects them — exactly the same class
			// of silent fall-through this PR is trying to close. For non-
			// reasoning paths preserve user case to avoid changing behaviour
			// for OpenAI-compatible custom endpoints that may be case-sensitive.
			const resolvedName =
				reasoningConfig !== null ? rawName.toLowerCase() : rawName;
			// Strip Chat-Completions-shaped maxTokens/temperature in TWO cases:
			//
			//   1. `isReasoning` — model is in REASONING_MODELS (substring
			//      match: o1/o3/o4 + most gpt-5 SKUs). These reject `max_tokens`
			//      because they require `max_completion_tokens`.
			//
			//   2. `reasoningConfig !== null` — getReasoningConfig returned
			//      kwargs that include `useResponsesApi: true`. We route through
			//      the Responses API, which uses `max_output_tokens` and won't
			//      accept Chat-Completions-shaped `max_tokens` cleanly. We MUST
			//      strip in this case even when `isReasoning === false` (e.g.
			//      bare `model: "gpt-5"` is matched by REASONING_CAPABLE_PATTERNS
			//      anchored regex but absent from REASONING_MODELS substring list).
			//
			// Without this trigger the two lists could drift: anything matched
			// by REASONING_CAPABLE_PATTERNS but missed by REASONING_MODELS would
			// build a Chat-Completions kwarg shape and then route via Responses
			// API at invoke time, producing a wire mismatch.
			const stripChatCompletionsParams =
				isReasoning || reasoningConfig !== null;

			if (stripChatCompletionsParams) {
				console.log(
					`[LangChainModels] Creating OpenAI reasoning model: ${resolvedName} (maxTokens and temperature omitted, isReasoningModel=${isReasoning}, reasoningConfig=${reasoningConfig !== null})`,
				);
				const baseKwargs: Record<string, unknown> = {
					model: resolvedName,
					apiKey,
					maxRetries,
					// NOTE: maxTokens and temperature intentionally omitted for reasoning models
				};
				const finalKwargs = applyReasoningConfig(
					baseKwargs,
					reasoningConfig,
					"OPENAI_DIRECT",
				);
				return new ChatOpenAI(
					finalKwargs as ConstructorParameters<typeof ChatOpenAI>[0],
				);
			}
			const baseKwargs: Record<string, unknown> = {
				model: resolvedName,
				apiKey,
				temperature,
				maxTokens,
				maxRetries,
			};
			const finalKwargs = applyReasoningConfig(
				baseKwargs,
				reasoningConfig,
				"OPENAI_DIRECT",
			);
			return new ChatOpenAI(
				finalKwargs as ConstructorParameters<typeof ChatOpenAI>[0],
			);
		}

		case "ANTHROPIC_DIRECT": {
			const resolvedName = modelName || model;
			const reasoningConfig = getReasoningConfig(
				resolvedName,
				"ANTHROPIC_DIRECT",
			);
			const baseKwargs: Record<string, unknown> = {
				modelName: resolvedName,
				anthropicApiKey: apiKey,
				temperature,
				maxTokens,
				maxRetries,
			};
			const finalKwargs = applyReasoningConfig(
				baseKwargs,
				reasoningConfig,
				"ANTHROPIC_DIRECT",
			);
			return new ChatAnthropic(
				finalKwargs as ConstructorParameters<typeof ChatAnthropic>[0],
			);
		}

		case "GROQ":
			return new ChatGroq({
				model: modelName || model,
				apiKey,
				temperature,
				maxTokens,
				maxRetries,
			});

		default:
			// Default to gateway pattern if provider is unknown but we have baseUrl
			if (baseUrl) {
				return new ChatOpenAI({
					model,
					apiKey,
					temperature,
					maxTokens,
					maxRetries,
					timeout: GATEWAY_TIMEOUT_MS,
					configuration: {
						baseURL: baseUrl,
						fetch: gatewayFetch,
					},
				});
			}

			// A NAMED provider that reaches this fallback with no base URL is a
			// misconfiguration — e.g. CUSTOM / AZURE_OPENAI, both of which
			// require a base URL but have no dedicated branch above. Fail loudly
			// instead of silently building a ChatOpenAI (api.openai.com) or
			// ChatGroq client with the tenant's key — a wrong-host request, the
			// same class of misroute the ai-config route's null gatewayUrl exists
			// to surface clearly. The Groq/OpenAI heuristics below stay reserved
			// for the genuinely provider-less case (no provider specified).
			if (provider) {
				throw new Error(
					`[LangChainModels] Provider ${provider} requires a base URL. ` +
						"Please configure the base URL in Settings → AI Providers.",
				);
			}

			// Last resort: Try Groq if model looks like a Groq model
			if (
				model.startsWith("llama") ||
				model.startsWith("mixtral") ||
				model.startsWith("gemma")
			) {
				console.warn(
					`[LangChainModels] Unknown provider "${provider}", falling back to Groq for model "${model}"`,
				);
				return new ChatGroq({
					model: modelName || model,
					apiKey,
					temperature,
					maxTokens,
					maxRetries,
				});
			}

			// Default to OpenAI
			console.warn(
				`[LangChainModels] Unknown provider "${provider}", falling back to OpenAI for model "${model}"`,
			);
			return new ChatOpenAI({
				model: modelName || model,
				apiKey,
				temperature,
				maxTokens,
				maxRetries,
			});
	}
}

/**
 * Extract provider config from RunnableConfig (CopilotKit properties)
 *
 * @param config - RunnableConfig from LangGraph
 * @returns Provider config if available
 */
export function extractProviderConfig(
	config?: { configurable?: Record<string, unknown> } | null,
): RuntimeProviderConfig | undefined {
	if (!config?.configurable) {
		return undefined;
	}

	const configurable = config.configurable;
	const aiApiKey = configurable.ai_api_key;
	const aiModel = configurable.ai_model;
	const aiGatewayUrl = configurable.ai_gateway_url;
	const aiProvider = configurable.ai_provider;
	const aiDeploymentName = configurable.ai_deployment_name;
	// Canonical-derived "emits <think>" signal from the CopilotKit route (Bug
	// #1942 review). Present as a real boolean; absent for older callers (then
	// the Databricks branch falls back to a name check on the alias).
	const aiIsReasoning = configurable.ai_is_reasoning;

	if (aiApiKey && aiModel) {
		return {
			provider: aiProvider ? String(aiProvider) : undefined,
			apiKey: String(aiApiKey),
			model: String(aiModel),
			baseUrl: aiGatewayUrl ? String(aiGatewayUrl) : undefined,
			deploymentName: aiDeploymentName
				? String(aiDeploymentName)
				: undefined,
			isReasoningModel:
				typeof aiIsReasoning === "boolean" ? aiIsReasoning : undefined,
		};
	}

	return undefined;
}

/**
 * Get a model for agent execution with provider config support
 *
 * This is the recommended function for agent nodes to use.
 * First tries to use provider config passed from CopilotKit runtime,
 * then falls back to fetching from the API using tenant context.
 *
 * @param config - RunnableConfig from LangGraph
 * @param options - Model creation options
 * @returns A LangChain BaseChatModel instance
 * @throws Error if no provider config is found
 */
export function getAgentModelFromConfig(
	config?: { configurable?: Record<string, unknown> } | null,
	options: ModelOptions = {},
): BaseChatModel {
	// Try to extract provider config from runtime
	const providerConfig = extractProviderConfig(config);

	if (providerConfig) {
		console.log(
			`[LangChainModels] Using provider config: ${providerConfig.provider || "gateway"} / ${providerConfig.model}`,
		);
		return createProviderModel(providerConfig, options);
	}

	// No provider config found - throw an error with helpful message
	throw new Error(
		"[LangChainModels] No AI provider configured. " +
			"Please configure an AI provider in Settings > AI Providers. " +
			"The agent requires API credentials to be passed from the CopilotKit runtime. " +
			"Use getAgentModelAsync() to fetch config from the API using tenant context.",
	);
}

/**
 * Get a model for agent execution with API fallback support (async version)
 *
 * This function:
 * 1. Checks for task-specific model preferences (model override scoped to user's default provider)
 * 2. Falls back to provider config passed from CopilotKit runtime
 * 3. Falls back to fetching from the API using tenant context
 *
 * @param config - RunnableConfig from LangGraph
 * @param options - Model creation options (including taskType for preference lookup)
 * @returns Promise resolving to a LangChain BaseChatModel instance
 * @throws Error if no provider config is found and API fetch fails
 */
export async function getAgentModelAsync(
	config?: { configurable?: Record<string, unknown> } | null,
	options: ModelOptions = {},
): Promise<BaseChatModel> {
	const configurable = config?.configurable;
	const tenantUserId = configurable?.tenant_user_id as string | undefined;
	const tenantOrgId = configurable?.tenant_organization_id as
		| string
		| undefined;

	// Try to extract provider config from runtime (direct pass-through)
	let providerConfig = extractProviderConfig(config);

	// Debug logging for task-specific preference lookup
	console.log("[LangChainModels] getAgentModelAsync called:", {
		taskType: options.taskType,
		tenantUserId: tenantUserId ? "set" : "NOT SET",
		hasProviderConfig: !!providerConfig,
		providerFromConfig: providerConfig?.provider || "none",
	});

	// If we have a task type and tenant context, check for task-specific model preferences
	// In the simplified design: user has ONE default provider, model overrides are scoped to that provider
	if (options.taskType && tenantUserId && providerConfig) {
		console.log(
			`[LangChainModels] Checking task-specific preferences for ${options.taskType}...`,
		);

		const taskConfig = await fetchTaskSpecificConfig(
			tenantUserId,
			tenantOrgId,
			options.taskType,
		);

		console.log("[LangChainModels] Task config result:", {
			found: !!taskConfig,
			provider: taskConfig?.provider,
			model: taskConfig?.model,
			source: taskConfig?.source,
			hasApiKey: !!taskConfig?.apiKey,
		});

		if (taskConfig) {
			console.log(
				`[LangChainModels] Using task config for ${options.taskType}: ${taskConfig.provider}/${taskConfig.model} (source: ${taskConfig.source}, hasApiKey: ${!!taskConfig.apiKey})`,
			);

			// Use the task-specific config, falling back to the token-exchanged API key
			// if the task config doesn't include one (e.g. decryption mismatch in dev).
			providerConfig = {
				provider: taskConfig.provider,
				apiKey: taskConfig.apiKey || providerConfig.apiKey,
				model: taskConfig.model,
				baseUrl:
					taskConfig.gatewayUrl ||
					providerConfig.baseUrl ||
					undefined,
				deploymentName: taskConfig.deploymentName || undefined,
				// Canonical-derived reasoning signal (Bug #1942 review); fall back
				// to the runtime config's when the task endpoint doesn't supply it.
				isReasoningModel:
					taskConfig.isReasoningModel ??
					providerConfig.isReasoningModel,
				// Catalog caps for the model the endpoint actually resolved, so
				// the output budget is clamped to this model rather than to a
				// literal. Absent (older endpoint, unknown model) leaves them
				// undefined and the requested budget stands.
				maxOutputTokens:
					taskConfig.maxOutputTokens ??
					providerConfig.maxOutputTokens,
				contextWindow:
					taskConfig.contextWindow ?? providerConfig.contextWindow,
			};
		} else {
			console.log(
				`[LangChainModels] No task config found for ${options.taskType}, using runtime provider config`,
			);
		}
	} else {
		console.log(
			`[LangChainModels] Skipping task-specific lookup: taskType=${options.taskType}, tenantUserId=${!!tenantUserId}, providerConfig=${!!providerConfig}`,
		);
	}

	if (providerConfig) {
		console.log(
			`[LangChainModels] Using provider config: ${providerConfig.provider || "gateway"} / ${providerConfig.model}`,
		);
		return createProviderModel(providerConfig, options);
	}

	// Fallback: Try to fetch config from API using tenant context
	if (tenantUserId) {
		console.log(
			`[LangChainModels] Fetching AI config from API for user: ${tenantUserId}`,
		);
		const apiFetchedConfig = await fetchAiConfigFromApi(
			tenantUserId,
			tenantOrgId,
		);

		if (apiFetchedConfig) {
			console.log(
				`[LangChainModels] Using API-fetched config: ${apiFetchedConfig.provider || "gateway"} / ${apiFetchedConfig.model}`,
			);
			return createProviderModel(apiFetchedConfig, options);
		}
	}

	// No provider config found - throw an error
	throw new Error(
		"[LangChainModels] No AI provider configured. " +
			"Please configure an AI provider in Settings > AI Providers. " +
			`Tenant context: userId=${tenantUserId || "none"}, orgId=${tenantOrgId || "none"}`,
	);
}
