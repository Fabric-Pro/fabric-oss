import { servingChatGptPlanSource } from "./chatgpt-plan-reexchange";
import { servedModelIdentity } from "./served-model";
import { AI_TOKEN_HEADER } from "./token-exchange";

function getDefaultFabricBaseUrl(): string {
	return (
		process.env.FABRIC_API_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		"http://localhost:3000"
	);
}

/** Logger-only A2A metadata; graph consumers read their existing top-level fields. */
export function agentUsageConfigFromInput(input: Record<string, unknown>): {
	fabric_usage: Record<string, string>;
} {
	const fields = [
		"ai_token",
		"ai_provider",
		"ai_model",
		"ai_billing_mode",
		"ai_billing_customer_id",
		"ai_plan_source",
		"project_id",
		"usage_conversation_id",
		"usage_project_id",
		"usage_frame_id",
		"usage_feature_key",
	];
	const result: Record<string, string> = {};
	for (const field of fields) {
		if (typeof input[field] === "string") {
			result[field] = input[field];
		}
	}
	return { fabric_usage: result };
}

export interface AgentUsageLoggerConfig {
	configurable?: Record<string, unknown>;
}

export interface AgentUsageLogOptions {
	/**
	 * Pass the instance returned by getAgentModelAsync/createProviderModel, not
	 * a bindTools result. Required so a new call site cannot silently fall back
	 * to the exchanged model (Fizzy #3121); pass `undefined` only when no such
	 * instance produced the response.
	 */
	model: object | undefined;
	taskType: string;
	agentId?: string;
	conversationId?: string;
	projectId?: string;
	/** Set only by reply-producing chat calls, excluding summaries. */
	outputMessageId?: string;
	latencyMs?: number;
}

interface ExtractedTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
	/** Vercel-gateway generation id, when the response exposed it. */
	gatewayGenerationId?: string;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function extractUsageFromLangChainResponse(
	response: unknown,
): ExtractedTokenUsage | null {
	if (!response || typeof response !== "object") {
		return null;
	}

	const candidate = response as {
		usage_metadata?: Record<string, unknown>;
		response_metadata?: Record<string, unknown>;
	};

	const usageMetadata = candidate.usage_metadata;
	const responseMetadata = candidate.response_metadata;
	// Kept separate from the `tokenUsage` selector chain below (rather than
	// read through it) so a future `tokenUsage`-shaped field on
	// `response_metadata` can never shadow this specific raw-usage read — see
	// the cacheCreationInputTokens fallback.
	const rawUsage = responseMetadata?.usage as
		| Record<string, unknown>
		| undefined;
	const tokenUsage =
		(responseMetadata?.tokenUsage as Record<string, unknown> | undefined) ??
		rawUsage ??
		(responseMetadata?.usage_metadata as
			| Record<string, unknown>
			| undefined);

	const reportedInputTokens =
		readNumber(usageMetadata?.input_tokens) ??
		readNumber(usageMetadata?.inputTokens) ??
		readNumber(tokenUsage?.promptTokens) ??
		readNumber(tokenUsage?.inputTokens) ??
		readNumber(tokenUsage?.input_tokens) ??
		0;

	const outputTokens =
		readNumber(usageMetadata?.output_tokens) ??
		readNumber(usageMetadata?.outputTokens) ??
		readNumber(tokenUsage?.completionTokens) ??
		readNumber(tokenUsage?.outputTokens) ??
		readNumber(tokenUsage?.output_tokens) ??
		0;

	const reportedTotalTokens =
		readNumber(usageMetadata?.total_tokens) ??
		readNumber(usageMetadata?.totalTokens) ??
		readNumber(tokenUsage?.totalTokens) ??
		readNumber(tokenUsage?.total_tokens) ??
		reportedInputTokens + outputTokens;

	// Cache + reasoning breakdown (LangChain surfaces these under *_token_details).
	const inputDetails = usageMetadata?.input_token_details as
		| Record<string, unknown>
		| undefined;
	const outputDetails = usageMetadata?.output_token_details as
		| Record<string, unknown>
		| undefined;
	const cachedInputTokens =
		readNumber(inputDetails?.cache_read) ??
		readNumber(usageMetadata?.cache_read_input_tokens);
	// `rawUsage` (above) is `response_metadata.usage` — for Databricks-served
	// Claude, `@langchain/openai`'s completions parser spreads the raw wire
	// usage object there verbatim (`response_metadata: { usage: { ...usage } }`,
	// gated only on the response carrying `system_fingerprint`, which Databricks
	// does — see the `__includeRawResponse` comment in langchain-models.ts).
	// That raw object still carries Anthropic's `cache_creation_input_tokens`;
	// `@langchain/openai` has no OpenAI-shape field to map a cache-WRITE count
	// into (`usage_metadata.input_token_details.cache_creation` is never set),
	// so this is the only place it survives to this extractor. Safe against
	// the streaming multiplication bug (chunk `.concat()` sums colliding
	// numeric fields): the compat layer (`applyChunkCacheUsageHandling` in
	// `@repo/agent-types`' `databricks-compat.ts`) already deletes this field
	// from every choices-bearing SSE chunk before `@langchain/openai` ever sees
	// it, so it survives on the wire exactly once, on the choices-less usage
	// event.
	const cacheCreationInputTokens =
		readNumber(inputDetails?.cache_creation) ??
		readNumber(usageMetadata?.cache_creation_input_tokens) ??
		readNumber(rawUsage?.cache_creation_input_tokens);
	// Recorded as reported: `inputTokens`/`totalTokens` are the provider's
	// TOTAL counts, INCLUDING prompt-cache reads and writes, and the two cache
	// columns are breakdowns of them — the contract every AiUsageLog writer
	// shares (see `estimateAiUsageCostUsd` in @repo/database's ai-credits.ts,
	// which subtracts the buckets back out before pricing). @langchain/anthropic
	// 1.5.x already builds usage_metadata.input_tokens as input + cache read +
	// cache write (`buildUsageMetadata`), the Databricks ChatOpenAI path reports
	// an inclusive `prompt_tokens`, and the AI SDK path records the same.
	const inputTokens = Math.max(0, reportedInputTokens);
	const totalTokens = Math.max(0, reportedTotalTokens);
	const reasoningTokens = readNumber(outputDetails?.reasoning);

	// The gateway generation id, if present, lets the row reconcile to actual cost.
	const gateway = responseMetadata?.gateway as
		| Record<string, unknown>
		| undefined;
	const generationId =
		gateway?.generationId ?? responseMetadata?.generationId;
	const gatewayGenerationId =
		typeof generationId === "string" ? generationId : undefined;

	return {
		inputTokens,
		outputTokens,
		totalTokens,
		cachedInputTokens,
		cacheCreationInputTokens,
		reasoningTokens,
		gatewayGenerationId,
	};
}

// Tail promises are scoped to a server-minted reply id, rather than a user or
// conversation, so unrelated usage requests keep their existing send behavior.
const outputUsageSends = new Map<string, Promise<void>>();

/**
 * Report usage without rejecting: the logger catches payload failures and the
 * poster catches transport failures.
 * Callers can fire-and-forget; calls with a reply id send in invocation order.
 * A fast rating can precede the final provenance write. Re-rating reads the
 * newer snapshot, while recordAiOutcome preserves existing non-null metadata.
 */
export async function logAgentUsageFromRunnableConfig(
	config: AgentUsageLoggerConfig | null | undefined,
	response: unknown,
	options: AgentUsageLogOptions,
): Promise<void> {
	try {
		// Snapshot before queueing: plan exchanges, config and response metadata can
		// change while an earlier POST is pending. Only network work is deferred.
		const request = buildAgentUsageEvent(config, response, options);
		if (!request) {
			return;
		}
		const send = () => postAgentUsageEvent(request);
		const outputMessageId = request.outputMessageId;
		if (!outputMessageId) {
			await send();
			return;
		}
		const previous = outputUsageSends.get(outputMessageId);
		const pending = previous ? previous.then(send, send) : send();
		outputUsageSends.set(outputMessageId, pending);
		try {
			await pending;
		} finally {
			// A completed earlier send must not remove a newer pending tail.
			if (outputUsageSends.get(outputMessageId) === pending) {
				outputUsageSends.delete(outputMessageId);
			}
		}
	} catch (error) {
		console.error("[AgentUsage] Failed to send usage event", error);
	}
}

interface AgentUsagePost {
	readonly url: string;
	readonly aiToken: string;
	readonly body: string;
	readonly outputMessageId: string | undefined;
}

function buildAgentUsageEvent(
	config: AgentUsageLoggerConfig | null | undefined,
	response: unknown,
	options: AgentUsageLogOptions,
): AgentUsagePost | null {
	const configurable = config?.configurable;
	const nestedUsage = configurable?.fabric_usage;
	// Flat fields are the graph's current config and win over the initial A2A
	// copy; the nested record supplies logger fields the graph's config lacks.
	const usageConfig =
		nestedUsage &&
		typeof nestedUsage === "object" &&
		!Array.isArray(nestedUsage)
			? { ...(nestedUsage as Record<string, unknown>), ...configurable }
			: configurable;
	const aiToken = usageConfig?.ai_token;
	const served = servedModelIdentity(options.model);
	const provider = served?.provider ?? usageConfig?.ai_provider;
	const model = served?.model ?? usageConfig?.ai_model;
	const billingMode = usageConfig?.ai_billing_mode;
	const billingCustomerId = usageConfig?.ai_billing_customer_id;
	// After a re-exchange the run's model answered on another plan; the row
	// names the plan that served it (Fizzy #2770 D2).
	const planAccessToken = usageConfig?.ai_api_key;
	const planSource =
		(provider === "OPENAI_CHATGPT_PLAN" &&
		typeof planAccessToken === "string"
			? servingChatGptPlanSource(planAccessToken)
			: null) ?? usageConfig?.ai_plan_source;
	const configProjectId = usageConfig?.project_id;

	if (
		typeof aiToken !== "string" ||
		typeof provider !== "string" ||
		typeof model !== "string"
	) {
		return null;
	}

	const usage = extractUsageFromLangChainResponse(response);
	if (!usage) {
		return null;
	}

	const fabricBaseUrl = getDefaultFabricBaseUrl();

	const outputMessageId = options.outputMessageId;
	return {
		url: `${fabricBaseUrl}/api/internal/ai-usage`,
		aiToken,
		outputMessageId,
		body: JSON.stringify({
			provider,
			model,
			taskType: options.taskType,
			outputMessageId,
			agentId: options.agentId,
			conversationId:
				options.conversationId ??
				(typeof usageConfig?.usage_conversation_id === "string"
					? usageConfig.usage_conversation_id
					: undefined),
			projectId:
				(typeof usageConfig?.usage_project_id === "string"
					? usageConfig.usage_project_id
					: options.projectId) ??
				(typeof configProjectId === "string"
					? configProjectId
					: undefined),
			frameId:
				typeof usageConfig?.usage_frame_id === "string"
					? usageConfig.usage_frame_id
					: undefined,
			featureKey:
				typeof usageConfig?.usage_feature_key === "string"
					? usageConfig.usage_feature_key
					: undefined,
			latencyMs: options.latencyMs ?? 0,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			totalTokens: usage.totalTokens,
			cachedInputTokens: usage.cachedInputTokens,
			cacheCreationInputTokens: usage.cacheCreationInputTokens,
			reasoningTokens: usage.reasoningTokens,
			gatewayGenerationId: usage.gatewayGenerationId,
			billingMode:
				typeof billingMode === "string" ? billingMode : undefined,
			billingCustomerId:
				typeof billingCustomerId === "string"
					? billingCustomerId
					: undefined,
			// Which ChatGPT plan served the call (Fizzy #2770); Fabric
			// records a shared account only when it is the token's own
			// organization's.
			planSource: typeof planSource === "string" ? planSource : undefined,
		}),
	};
}

async function postAgentUsageEvent(request: AgentUsagePost): Promise<void> {
	try {
		const response = await fetch(request.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[AI_TOKEN_HEADER]: request.aiToken,
			},
			body: request.body,
			// Start the network timeout when this POST starts, after any queue wait.
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			const hint =
				response.status === 401
					? " — AI token expired or invalid; usage row lost"
					: "";
			const body = await response.text().catch(() => "");
			console.error(
				`[AgentUsage] Usage event rejected (${response.status})${hint}`,
				{ status: response.status, body: body.slice(0, 500) },
			);
		}
	} catch (error) {
		// A timed-out request may still have been written server-side —
		// report it as unknown, not as a failed write.
		if (
			error instanceof Error &&
			(error.name === "TimeoutError" || error.name === "AbortError")
		) {
			console.error(
				"[AgentUsage] Usage event outcome unknown (timed out after 10s)",
				error,
			);
		} else {
			console.error("[AgentUsage] Failed to send usage event", error);
		}
	}
}
