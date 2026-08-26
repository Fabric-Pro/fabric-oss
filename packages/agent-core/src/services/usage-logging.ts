import { AI_TOKEN_HEADER } from "./token-exchange";

function getDefaultFabricBaseUrl(): string {
	return (
		process.env.FABRIC_API_URL ||
		process.env.RUNTIME_API_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		"http://localhost:3000"
	);
}

export interface AgentUsageLoggerConfig {
	configurable?: Record<string, unknown>;
}

export interface AgentUsageLogOptions {
	taskType: string;
	agentId?: string;
	conversationId?: string;
	projectId?: string;
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

	const inputTokens =
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

	const totalTokens =
		readNumber(usageMetadata?.total_tokens) ??
		readNumber(usageMetadata?.totalTokens) ??
		readNumber(tokenUsage?.totalTokens) ??
		readNumber(tokenUsage?.total_tokens) ??
		inputTokens + outputTokens;

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
	// numeric fields): the compat layer (`suppressNonFinalCacheUsageFields` in
	// `databricks-compat.ts`) already deletes this field from every non-final
	// SSE chunk before `@langchain/openai` ever sees it, so it survives on the
	// wire exactly once, on the final chunk.
	const cacheCreationInputTokens =
		readNumber(inputDetails?.cache_creation) ??
		readNumber(usageMetadata?.cache_creation_input_tokens) ??
		readNumber(rawUsage?.cache_creation_input_tokens);
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

export async function logAgentUsageFromRunnableConfig(
	config: AgentUsageLoggerConfig | null | undefined,
	response: unknown,
	options: AgentUsageLogOptions,
): Promise<void> {
	const configurable = config?.configurable;
	const aiToken = configurable?.ai_token;
	const provider = configurable?.ai_provider;
	const model = configurable?.ai_model;
	const billingMode = configurable?.ai_billing_mode;
	const billingCustomerId = configurable?.ai_billing_customer_id;
	const configProjectId = configurable?.project_id;

	if (
		typeof aiToken !== "string" ||
		typeof provider !== "string" ||
		typeof model !== "string"
	) {
		return;
	}

	const usage = extractUsageFromLangChainResponse(response);
	if (!usage) {
		return;
	}

	const fabricBaseUrl = getDefaultFabricBaseUrl();

	try {
		const response = await fetch(`${fabricBaseUrl}/api/internal/ai-usage`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				[AI_TOKEN_HEADER]: aiToken,
			},
			body: JSON.stringify({
				provider,
				model,
				taskType: options.taskType,
				agentId: options.agentId,
				conversationId: options.conversationId,
				projectId:
					options.projectId ??
					(typeof configProjectId === "string"
						? configProjectId
						: undefined),
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
			}),
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
