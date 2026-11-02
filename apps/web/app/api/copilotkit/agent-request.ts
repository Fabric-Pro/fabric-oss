import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	SubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import {
	buildEffectiveBaseUrl,
	type getAIModelWithMetadata,
	getRAGProviderConfig,
	isReasoningModelName,
	resolveModelWithProvider,
} from "@repo/ai";
import { chatGptPlanReconnectRefusal } from "@repo/ai/lib/chatgpt-plan/agent-config";
import { isAiImpersonatedRequest } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { resolveChatGptPlanModel } from "@repo/ai/lib/chatgpt-plan/models";
import {
	chatGptPlanApiBillingOption,
	chatGptPlanSpentError,
} from "@repo/ai/lib/chatgpt-plan/plan-spent-response";
import {
	chatGptPlanInteractiveApiFallback,
	chatGptPlanPersonalKeyFallback,
	pickChatGptPlanSource,
} from "@repo/ai/lib/chatgpt-plan/pool";
import { issueAIToken } from "@repo/ai-token";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments";
import { buildAgUiAgentHeaders } from "@repo/temporal/agui-run-stream";
import type { AgUiRunSettings } from "@saas/agents/runtime/ag-ui-agent-engine";
import { AI_TOKEN_TTL_SECONDS } from "./config";
import { resolveCopilotOrgModel } from "./org-model";

// AG-UI makes several polls per agent connection. A short cache window
// collapses repeated AI-provider lookups for the same tenant
// without making provider switches feel sticky. Tunable for tests/incidents.
const TENANT_CACHE_TTL_MS = Number.parseInt(
	process.env.COPILOTKIT_TENANT_CACHE_TTL_MS ?? "60000",
	10,
);

// Cap unbounded growth: a large tenant with sparse usage would otherwise
// accumulate one entry per (user, org) forever. Insertion-order Map +
// oldest-first eviction is enough — TTL still handles freshness.
const TENANT_CACHE_MAX_ENTRIES = Number.parseInt(
	process.env.COPILOTKIT_TENANT_CACHE_MAX_ENTRIES ?? "500",
	10,
);

type AIModelResult = Awaited<ReturnType<typeof getAIModelWithMetadata>>;
type ProviderConfig = Awaited<ReturnType<typeof getRAGProviderConfig>>;

interface TenantConfig {
	/** Null for an organization with no provider whose member runs on their own plan. */
	aiGatewayUrl: string | null;
	providerConfig: ProviderConfig | null;
	metadata: AIModelResult["metadata"];
	trackUsage: AIModelResult["trackUsage"];
}

class TenantConfigError extends Error {
	code: string;
	httpStatus: number;
	constructor(code: string, message: string, httpStatus = 400) {
		super(message);
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

const tenantCache = new Map<
	string,
	{ promise: Promise<TenantConfig>; expiresAt: number }
>();

function tenantCacheKey(userId: string, organizationId?: string): string {
	return `${userId}:${organizationId ?? ""}`;
}

async function getTenantConfig(
	userId: string,
	organizationId: string | undefined,
): Promise<TenantConfig> {
	const key = tenantCacheKey(userId, organizationId);
	const now = Date.now();
	const cached = tenantCache.get(key);
	if (cached && cached.expiresAt > now) {
		return cached.promise;
	}

	const promise = (async () => {
		const [aiModelResult, providerConfig] = await Promise.all([
			// The agents' plan decision is made per request below.
			resolveCopilotOrgModel({ userId, organizationId }),
			getRAGProviderConfig({ userId, organizationId }).catch(
				(error: unknown) => error as Error,
			),
		]);

		if (!aiModelResult) {
			const { model: planModel } = await resolveChatGptPlanModel({
				userId,
				organizationId,
				taskType: "COMPLEX",
			});
			return {
				aiGatewayUrl: null,
				providerConfig: null,
				metadata: {
					modelString: planModel,
					provider: "OPENAI_CHATGPT_PLAN" as const,
					configId: null,
					configSource: null,
					selectionSource: "chatgpt_plan",
					canonicalName: planModel,
					billingMode: "external_provider" as const,
					billingCustomerId: null,
				},
				trackUsage: () => {},
			};
		}
		if (providerConfig instanceof Error) {
			throw providerConfig;
		}

		const { metadata, trackUsage } = aiModelResult;
		const aiGatewayUrl = buildEffectiveBaseUrl(
			metadata.provider,
			providerConfig.baseUrl || undefined,
		);

		if (!aiGatewayUrl) {
			throw new TenantConfigError(
				"NO_AI_GATEWAY_URL",
				"No AI gateway URL configured. Please configure your AI provider's base URL in Settings → AI Providers.",
			);
		}

		return {
			aiGatewayUrl,
			providerConfig,
			metadata,
			trackUsage,
		};
	})();

	tenantCache.set(key, {
		promise,
		expiresAt: now + TENANT_CACHE_TTL_MS,
	});
	// Evict the oldest entry when over capacity. Map preserves insertion order.
	if (tenantCache.size > TENANT_CACHE_MAX_ENTRIES) {
		const firstKey = tenantCache.keys().next().value;
		if (firstKey !== undefined && firstKey !== key) {
			tenantCache.delete(firstKey);
		}
	}
	promise.catch(() => {
		// Evict failed entries so the next request retries fresh instead of
		// being stuck with a poisoned cache slot for TENANT_CACHE_TTL_MS.
		if (tenantCache.get(key)?.promise === promise) {
			tenantCache.delete(key);
		}
	});

	return promise;
}

/** A 429 the fetch interceptor shows as "every plan is spent until …". */
function planExhaustedResponse(
	error: SubscriptionPlanExhaustedError,
	apiBillingOption: boolean,
	personalKeyOption: boolean,
): Response {
	return new Response(
		JSON.stringify({
			error: error.message,
			code: CHATGPT_PLAN_EXHAUSTED_CODE,
			resetAt: error.resetAt?.toISOString() ?? null,
			apiBillingOption,
			personalKeyOption,
		}),
		{ status: 429, headers: { "Content-Type": "application/json" } },
	);
}

interface CopilotTenant {
	config: TenantConfig;
	agentOnPlan: boolean;
	planEligible: boolean;
	planModelHint: string | null;
	personalKeyHint: { provider: string; model: string } | null;
}
type CopilotTenantResolution =
	| { ok: true; tenant: CopilotTenant }
	| { ok: false; response: Response };
export async function resolveCopilotTenant({
	userId,
	organizationId,
	isAgentRun,
}: {
	userId: string;
	organizationId: string;
	isAgentRun: boolean;
}): Promise<CopilotTenantResolution> {
	let tenantConfig: TenantConfig;
	let agentOnPlan: boolean;
	let planEligible: boolean;
	let planModelHint: string | null = null;
	// The member's own key while plans are spent, with the model the key
	// exchange will resolve on it.
	let personalKeyHint: { provider: string; model: string } | null = null;
	try {
		tenantConfig = await getTenantConfig(userId, organizationId);
		// A person is driving this request, so the agents may run on their
		// own ChatGPT plan where they turned it on, or on one
		// the organization shares with members who have none.
		// The exchange makes the same decision from the token's claim; the
		// hints below only have to agree with it.
		const plan = await pickChatGptPlanSource({
			userId,
			organizationId,
			planEligible: true,
		});
		// Under "Use API billing" a spent plan hands the agents to the
		// organization's provider; the exchange, still
		// resolving the member's own work, makes the same call and audits it.
		const apiFallback =
			plan !== null &&
			"exhausted" in plan &&
			(await chatGptPlanInteractiveApiFallback(plan, organizationId));
		// Where the organization would stop the member's work instead, a
		// personal key they opted in runs it; the exchange,
		// resolving the same member's own work, makes the same call.
		const personalKey =
			plan !== null && "exhausted" in plan && !apiFallback
				? await chatGptPlanPersonalKeyFallback(plan, {
						userId,
						organizationId,
					})
				: null;
		if (personalKey?.config?.provider) {
			const resolved = await resolveModelWithProvider(
				"COMPLEX",
				{ userId, organizationId },
				{ providerConfig: personalKey.config },
			);
			personalKeyHint = {
				provider: personalKey.config.provider,
				model: resolved.modelString,
			};
		}
		planEligible = plan !== null;
		agentOnPlan = plan !== null && !apiFallback && !personalKeyHint;
		if (
			plan &&
			"exhausted" in plan &&
			!apiFallback &&
			!personalKeyHint &&
			isAgentRun
		) {
			return {
				ok: false,
				response: planExhaustedResponse(
					chatGptPlanSpentError(plan),
					chatGptPlanApiBillingOption(
						plan,
						tenantConfig.providerConfig !== null,
					),
					personalKey !== null,
				),
			};
		}
		if (plan && agentOnPlan) {
			// The task the key exchange resolves for agents, on the plan the
			// pick chose, so the hint and the model the agent finally uses
			// agree. Inside this try: a plan that serves no usable model is
			// the 409 below, not a 500.
			planModelHint = (
				await resolveChatGptPlanModel({
					userId,
					organizationId,
					taskType: "COMPLEX",
					...("source" in plan && { source: plan.source }),
				})
			).model;
		}
	} catch (error) {
		if (error instanceof SubscriptionPlanExhaustedError) {
			return {
				ok: false,
				response: planExhaustedResponse(
					error,
					false,
					error.personalKeyOption,
				),
			};
		}
		// The member's plan is on here but needs reconnecting: refuse rather
		// than run the agents on the organization's API billing.
		const reconnect = chatGptPlanReconnectRefusal(error);
		if (reconnect) {
			return {
				ok: false,
				response: new Response(JSON.stringify(reconnect.body), {
					status: reconnect.status,
					headers: { "Content-Type": "application/json" },
				}),
			};
		}
		// AI usage-limit chokepoint hit a HARD limit.
		// Surface the rich payload so the client
		// fetch interceptor can render the shared destructive toast
		// instead of the generic "AI service is busy" 429 copy.
		if (error instanceof AiUsageLimitExceededError) {
			return {
				ok: false,
				response: new Response(
					JSON.stringify({
						error: error.message,
						code: "AI_USAGE_LIMIT_EXCEEDED",
						data: {
							limitId: error.limitId,
							dimension: error.dimension,
							window: error.window,
							used: error.used.toString(),
							max: error.max.toString(),
							manageLimitsUrl: error.manageLimitsUrl,
						},
					}),
					{
						status: 429,
						headers: { "Content-Type": "application/json" },
					},
				),
			};
		}
		if (error instanceof TenantConfigError) {
			return {
				ok: false,
				response: new Response(
					JSON.stringify({ error: error.message, code: error.code }),
					{
						status: error.httpStatus,
						headers: { "Content-Type": "application/json" },
					},
				),
			};
		}
		logger.error("[CopilotKit] Failed to resolve tenant config", {
			error,
		});
		return {
			ok: false,
			response: new Response(
				JSON.stringify({
					error:
						error instanceof Error
							? error.message
							: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
					code: "AI_GATEWAY_MISSING",
				}),
				{
					status: 400,
					headers: { "Content-Type": "application/json" },
				},
			),
		};
	}

	return {
		ok: true,
		tenant: {
			config: tenantConfig,
			agentOnPlan,
			planEligible,
			planModelHint,
			personalKeyHint,
		},
	};
}
interface CopilotAgentRequest {
	headers: Record<string, string>;
	settings: AgUiRunSettings;
}
export async function issueCopilotAgentRequest({
	userId,
	organizationId,
	tenant,
}: {
	userId: string;
	organizationId: string;
	tenant: CopilotTenant;
}): Promise<
	| { ok: true; request: CopilotAgentRequest }
	| { ok: false; response: Response }
> {
	const { agentOnPlan, planEligible, planModelHint, personalKeyHint } =
		tenant;
	const { aiGatewayUrl, providerConfig, metadata, trackUsage } =
		tenant.config;

	// Track usage (fire-and-forget) — kept per-request to preserve
	// existing usage-accounting semantics.
	trackUsage();

	// The agents' hints follow the plan, or the member's own key, where
	// one serves this request. Neither may be pointed at the
	// organization's base URL or deployment: the agent would send that
	// key there.
	const agentOffOrgProvider = agentOnPlan || personalKeyHint !== null;
	const agentProvider = agentOnPlan
		? "OPENAI_CHATGPT_PLAN"
		: (personalKeyHint?.provider ?? metadata.provider);
	const agentModel =
		agentOnPlan && planModelHint
			? planModelHint
			: (personalKeyHint?.model ?? metadata.modelString);
	const agentGatewayUrl = agentOffOrgProvider ? null : aiGatewayUrl;
	const agentDeploymentName = agentOffOrgProvider
		? undefined
		: providerConfig?.deploymentName;

	// Issue a short-lived AI token instead of passing the raw API key.
	// Agents will exchange this token for the actual API key via
	// /api/ai/keys/exchange. Per-request: tokens are short-lived by design.
	let aiToken: string;
	try {
		aiToken = await issueAIToken({
			userId,
			organizationId,
			impersonated: isAiImpersonatedRequest(),
			source: "copilotkit",
			expirySeconds: AI_TOKEN_TTL_SECONDS,
			// The same decision as the hints above: never while an admin
			// acts as the member.
			planEligible,
		});
	} catch (error) {
		logger.error("[CopilotKit] Failed to issue AI token", { error });
		return {
			ok: false,
			response: new Response(
				JSON.stringify({
					error: "Failed to issue AI token. Please check AI_TOKEN_SECRET is configured.",
					code: "AI_TOKEN_ISSUE_FAILED",
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			),
		};
	}

	logger.debug("[CopilotKit] Request config", {
		userId,
		organizationId: organizationId ?? "none",
		provider: metadata.provider,
		modelSource: metadata.selectionSource || "fallback",
		model: metadata.modelString,
		gatewayUrl: aiGatewayUrl,
	});

	// Build per-request headers (carries fresh AI token + tenant context).
	// LangGraphHttpAgent only forwards url+headers on the wire, so per-user
	// state lives here rather than on the cached adapter.
	const agentApiKey = process.env.AGENT_API_KEY?.trim();
	if (!agentApiKey) {
		logger.error(
			"[CopilotKit] AGENT_API_KEY is not set — self-hosted agents will reject requests with 401",
		);
	}
	// Org metadata describes agentModel only while the org resolution supplies it.
	const agentIsReasoning =
		!agentOffOrgProvider && agentModel === metadata.modelString
			? isReasoningModelName(metadata.canonicalName)
			: null;

	const settings: AgUiRunSettings = {
		modelHints: {
			...(agentModel && { model: agentModel }),
			...(agentProvider && { provider: agentProvider }),
			...(agentGatewayUrl && { baseUrl: agentGatewayUrl }),
			...(agentDeploymentName && { deploymentName: agentDeploymentName }),
			...(agentIsReasoning !== null && { isReasoning: agentIsReasoning }),
		},
		aiToken,
	};
	return {
		ok: true,
		request: {
			settings,
			headers: buildAgUiAgentHeaders({
				userId,
				organizationId,
				aiToken,
				agentApiKey,
				modelHints: settings.modelHints,
			}),
		},
	};
}
export function dataAnalystUrl(): string {
	return process.env.DATA_ANALYST_URL || "http://localhost:8130";
}
