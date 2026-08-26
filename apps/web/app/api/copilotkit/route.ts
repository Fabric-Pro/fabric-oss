/**
 * CopilotKit Runtime API Route
 * Routes through Vercel AI Gateway like the AI Chatbot
 * Using OpenAI-compatible API: https://vercel.com/docs/ai-gateway/openai-compat
 *
 * DO NOT MODIFY this route's proxy semantics.
 * See fabric/specs/2026-05-19-ai-assistant-document-chat-history/spec.md §6.7
 * and §3.10 FR-26. Persistence of document-assistant chat turns lives in
 * `apps/web/modules/saas/projects/components/copilot/CopilotPersistenceHook.tsx`
 * (Group H), NOT here. The existing tenant cache, AI-token issuance, and
 * rate-limit semantics must remain the sole authority for who-can-write-what
 * at the runtime level.
 */

import {
	CopilotRuntime,
	copilotRuntimeNextJSAppRouterEndpoint,
	OpenAIAdapter,
} from "@copilotkit/runtime";
import { LangGraphHttpAgent } from "@copilotkit/runtime/langgraph";
import {
	AgentRegistry,
	LangGraphAgentAdapter,
	type LangGraphAgentConfig,
} from "@repo/agent-core";
import {
	ENHANCE_PROMPT_TOOL,
	REQUEST_HUMAN_APPROVAL_TOOL,
	WRITE_DOCUMENT_TOOL,
	WRITE_TASK_PLAN_TOOL,
} from "@repo/agent-tools";
import type { BaseAgentState } from "@repo/agent-types";
import {
	buildEffectiveBaseUrl,
	createDatabricksFetch,
	getAIModelWithMetadata,
	getCurrentDateContext,
	getRAGProviderConfig,
	isReasoningModelName,
	toDatabricksServingBaseUrl,
} from "@repo/ai";
import { AI_TOKEN_HEADER, issueAIToken } from "@repo/ai-token";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import { auth } from "@repo/auth";
import { getBoundPromptVersion } from "@repo/database";
import { logger } from "@repo/logs";
import { AiUsageLimitExceededError } from "@repo/payments";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import OpenAI from "openai";
import { AI_TOKEN_TTL_SECONDS } from "./config";

// Note: `./default-mcp-tools` (PR #892 / #897) is no longer imported
// here. See the comment near the `CopilotRuntime` constructor below for
// why backend `actions` are incompatible with external LangGraph agents
// and how the equivalent surface now lives in
// `useDefaultMcpInlineRender.tsx` as frontend `useCopilotAction`s.

const DOCUMENT_GENERATOR_DOC_TYPE = "GENERAL";
const PROJECT_DOCUMENT_GENERATOR_DOC_TYPE = "PRD";

// AG-UI makes several polls per agent connection. A short cache window
// collapses repeated AI-provider/bound-prompt lookups for the same tenant
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

// Databricks Model Serving is the fourth inference path (outside @ai-sdk and the
// LangChain agents). Its serving endpoints diverge from the strict OpenAI schema,
// so the built-in `OpenAIAdapter` client below needs the same compat shim the
// @ai-sdk model factory uses: strip `stream_options` / `parallel_tool_calls`
// (Databricks 400s) + `temperature` (Claude serving rejects it), and flatten
// Claude's array-shaped `delta.content` back to a plain string. (The shim's
// json_schema-strict relaxation is inert here: `OpenAIAdapter` never sends
// `response_format.json_schema`.)
//
// The compat fetch is built PER TENANT inside `getTenantConfig` (not module-
// scoped) because its `stripReasoning` flag depends on the resolved model:
// `stripReasoning` removes raw `<think>…</think>` spans a DeepSeek-R1 endpoint
// served over Databricks emits in `delta.content` (no native `reasoning_content`),
// which `OpenAIAdapter` would otherwise stream verbatim into the chat answer
// (Bug #1942). It's gated on the CANONICAL model identity — not the serving-
// endpoint alias — so an R1 endpoint mapped to an opaque alias (`prod-chat`) is
// still stripped, and a non-R1 model's literal `<think>` markup is preserved.

// ─── Module-scope agent registry ─────────────────────────────────────────
// Agents are static: deploymentUrl/graphId/tools come from env + constants.
// `LangGraphHttpAgent` only transmits url+headers on the wire; per-user
// model state arrives via the `ai_model` property / `X-AI-Model` header,
// so the adapter doesn't need request-scoped data. Build once at module load.

const SHARED_AGENT_DEFAULTS = {
	temperature: 0.7,
	maxTokens: 4000,
	timeout: 30000,
	recursionLimit: 25,
} as const;

const AGENT_DEFINITIONS: LangGraphAgentConfig[] = [
	{
		name: "document_generator",
		displayName: "Document Generator",
		description: "AI-powered document generation with real-time streaming",
		deploymentUrl:
			process.env.DOCUMENT_GENERATOR_URL || "http://localhost:8124",
		graphId: "document_generator",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [WRITE_DOCUMENT_TOOL],
		language: "typescript",
		version: "1.0.0",
		tags: ["document", "generation", "markdown"],
		agentConfig: {
			...SHARED_AGENT_DEFAULTS,
			predictiveStates: [
				{
					state_key: "document",
					tool: "write_document_local",
					tool_argument: "document",
				},
				{
					state_key: "focusAnchor",
					tool: "write_document_local",
					tool_argument: "focusAnchor",
				},
			],
		},
	},
	{
		name: "project_document_generator",
		displayName: "Project Document Generator",
		description: "Project-scoped document generation with RAG context",
		deploymentUrl:
			process.env.PROJECT_DOCUMENT_GENERATOR_URL ||
			"http://localhost:8125",
		graphId: "project_document_generator",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [WRITE_DOCUMENT_TOOL],
		language: "typescript",
		version: "1.0.0",
		tags: ["document", "generation", "project", "rag"],
		agentConfig: {
			...SHARED_AGENT_DEFAULTS,
			predictiveStates: [
				{
					state_key: "document",
					tool: "write_document_local",
					tool_argument: "document",
				},
				{
					state_key: "focusAnchor",
					tool: "write_document_local",
					tool_argument: "focusAnchor",
				},
			],
		},
	},
	{
		name: "prompt_enhancer",
		displayName: "Prompt Enhancer",
		description:
			"AI-powered prompt enhancement with format-aware improvements",
		deploymentUrl:
			process.env.PROMPT_ENHANCER_URL || "http://localhost:8134",
		graphId: "prompt_enhancer",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [ENHANCE_PROMPT_TOOL],
		language: "typescript",
		version: "1.0.0",
		tags: ["prompt", "enhancement", "optimization"],
		agentConfig: {
			...SHARED_AGENT_DEFAULTS,
			predictiveStates: [
				{
					state_key: "streamingContent",
					tool: "enhance_prompt_local",
					tool_argument: "enhancedContent",
				},
				{
					state_key: "focusAnchor",
					tool: "enhance_prompt_local",
					tool_argument: "focusAnchor",
				},
			],
		},
	},
	{
		name: "story_breakdown",
		displayName: "Feature Breakdown",
		description: "Convert PRDs into actionable features with estimates",
		deploymentUrl:
			process.env.STORY_BREAKDOWN_URL || "http://localhost:8127",
		graphId: "story_breakdown",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [WRITE_DOCUMENT_TOOL],
		language: "typescript",
		version: "1.0.0",
		tags: ["planning", "stories", "requirements"],
		agentConfig: {
			...SHARED_AGENT_DEFAULTS,
			predictiveStates: [
				{
					state_key: "document",
					tool: "write_document_local",
					tool_argument: "document",
				},
				{
					state_key: "focusAnchor",
					tool: "write_document_local",
					tool_argument: "focusAnchor",
				},
			],
		},
	},
	{
		name: "task_planner",
		displayName: "Task Planner",
		description:
			"CUGA-enhanced task decomposition with risk analysis, dependency graphs, and execution planning",
		deploymentUrl: process.env.TASK_PLANNER_URL || "http://localhost:8128",
		graphId: "task_planner",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [WRITE_TASK_PLAN_TOOL, REQUEST_HUMAN_APPROVAL_TOOL],
		language: "typescript",
		version: "2.0.0",
		tags: ["planning", "tasks", "development", "risk-analysis", "cuga"],
		agentConfig: {
			...SHARED_AGENT_DEFAULTS,
			predictiveStates: [
				{
					state_key: "document",
					tool: "write_task_plan",
					tool_argument: "document",
				},
				{
					state_key: "decomposedTasks",
					tool: "write_task_plan",
					tool_argument: "decomposedTasks",
				},
				{
					state_key: "riskAnalysis",
					tool: "write_task_plan",
					tool_argument: "riskAnalysis",
				},
				{
					state_key: "dependencyGraph",
					tool: "write_task_plan",
					tool_argument: "dependencyGraph",
				},
				{
					state_key: "executionPlan",
					tool: "write_task_plan",
					tool_argument: "executionPlan",
				},
				{
					state_key: "focusAnchor",
					tool: "write_task_plan",
					tool_argument: "focusAnchor",
				},
			],
		},
	},
	{
		name: "code_executor",
		displayName: "Code Executor",
		description:
			"CUGA CodeAct pattern agent with sandboxed code execution and reflection loops",
		deploymentUrl: process.env.CODE_EXECUTOR_URL || "http://localhost:8129",
		graphId: "code_executor",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [REQUEST_HUMAN_APPROVAL_TOOL],
		language: "typescript",
		version: "1.0.0",
		tags: ["code", "execution", "sandbox", "codeact", "cuga"],
		agentConfig: {
			temperature: 0.3,
			maxTokens: 4000,
			timeout: 60000,
			recursionLimit: 10,
			predictiveStates: [
				{
					state_key: "code",
					tool: "execute_code",
					tool_argument: "code",
				},
				{
					state_key: "result",
					tool: "execute_code",
					tool_argument: "result",
				},
				{
					state_key: "error",
					tool: "execute_code",
					tool_argument: "error",
				},
			],
		},
	},
	{
		name: "api_agent",
		displayName: "API Agent",
		description:
			"Specialized agent for analyzing API-shaped tasks and orchestrating MCP/OpenAPI tools",
		deploymentUrl: process.env.API_AGENT_URL || "http://localhost:8131",
		graphId: "api_agent",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [],
		language: "typescript",
		version: "0.1.0",
		tags: ["api", "integration", "mcp", "openapi"],
		agentConfig: {
			temperature: 0.3,
			maxTokens: 4000,
			timeout: 60000,
			recursionLimit: 10,
			predictiveStates: [],
		},
	},
	{
		name: "data_analyst",
		displayName: "Data Analyst",
		description:
			"Data analysis agent that connects to MCP data sources (HubSpot, Attio, Google Sheets, databases) to analyze data, generate insights, and create visualizations",
		deploymentUrl: process.env.DATA_ANALYST_URL || "http://localhost:8130",
		graphId: "data_analyst",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [],
		language: "typescript",
		version: "1.0.0",
		tags: [
			"data",
			"analysis",
			"visualization",
			"charts",
			"business-intelligence",
		],
		agentConfig: {
			temperature: 0.3,
			maxTokens: 4000,
			timeout: 120000,
			recursionLimit: 25,
			predictiveStates: [],
		},
	},
	{
		name: "cuga_generalist",
		displayName: "CUGA Generalist Agent",
		description:
			"Configurable Universal Generalist Agent (CUGA) - A powerful multi-capability agent that handles browser automation with full Playwright support, multi-API orchestration with variable management, Python code execution with sandbox support, and intelligent task decomposition.",
		deploymentUrl: process.env.CUGA_AGENT_URL || "http://localhost:8140",
		graphId: "cuga_generalist",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [],
		language: "python",
		version: "1.0.0",
		tags: [
			"browser",
			"automation",
			"api",
			"code",
			"planning",
			"generalist",
			"cuga",
		],
		agentConfig: {
			temperature: 0.3,
			maxTokens: 4000,
			timeout: 120000,
			recursionLimit: 25,
			predictiveStates: [],
		},
	},
	{
		name: "backlog_updater",
		displayName: "Backlog Updater",
		description:
			"AI-powered backlog analysis and update from project context (Teams, meetings, Notion)",
		deploymentUrl:
			process.env.BACKLOG_UPDATER_URL || "http://localhost:8135",
		graphId: "backlog_updater",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [],
		language: "typescript",
		version: "1.0.0",
		tags: ["backlog", "kanban", "stories", "epics"],
		agentConfig: {
			temperature: 0.4,
			maxTokens: 4000,
			timeout: 30000,
			recursionLimit: 30,
			predictiveStates: [
				{
					state_key: "analysisStatus",
					tool: "analyze_backlog",
					tool_argument: "status",
				},
				{
					state_key: "lastProposalSummary",
					tool: "analyze_backlog",
					tool_argument: "summary",
				},
			],
		},
	},
	{
		name: "orchestrator",
		displayName: "Fabric AI",
		description:
			"Central orchestrator that intelligently routes tasks to specialized agents with multi-agent coordination",
		deploymentUrl: process.env.ORCHESTRATOR_URL || "http://localhost:8130",
		graphId: "orchestrator",
		langsmithApiKey: process.env.LANGSMITH_API_KEY,
		tools: [],
		language: "typescript",
		version: "1.0.0",
		tags: ["orchestrator", "routing", "multi-agent", "coordination"],
		agentConfig: {
			temperature: 0.3,
			maxTokens: 4000,
			timeout: 120000,
			recursionLimit: 25,
			predictiveStates: [
				{
					state_key: "stage",
					tool: "orchestrator_status",
					tool_argument: "stage",
				},
				{
					state_key: "output",
					tool: "orchestrator_result",
					tool_argument: "output",
				},
				{
					state_key: "plan",
					tool: "orchestrator_plan",
					tool_argument: "plan",
				},
				{
					state_key: "riskScores",
					tool: "orchestrator_plan",
					tool_argument: "riskScores",
				},
			],
		},
	},
];

const agentRegistry = buildAgentRegistry();

function buildAgentRegistry(): AgentRegistry {
	const registry = new AgentRegistry();
	for (const def of AGENT_DEFINITIONS) {
		registry.register(new LangGraphAgentAdapter(def));
	}
	return registry;
}

// ─── Per-tenant config cache ─────────────────────────────────────────────
// Caches the per-request DB lookups (AI provider config, model resolution,
// bound prompts) plus the constructed OpenAI client / service adapter per
// (userId, organizationId). Stores the Promise so that concurrent first-
// misses dedupe into a single fetch. Rejected promises evict so the next
// request retries cleanly.

type AIModelResult = Awaited<ReturnType<typeof getAIModelWithMetadata>>;
type ProviderConfig = Awaited<ReturnType<typeof getRAGProviderConfig>>;
type BoundPrompt = Awaited<ReturnType<typeof getBoundPromptVersion>>;

interface TenantConfig {
	aiGatewayUrl: string;
	providerConfig: ProviderConfig;
	boundDocPrompt: BoundPrompt;
	boundProjectDocPrompt: BoundPrompt;
	metadata: AIModelResult["metadata"];
	trackUsage: AIModelResult["trackUsage"];
	openaiClient: OpenAI;
	serviceAdapter: OpenAIAdapter;
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
		const [
			aiModelResult,
			providerConfig,
			boundDocPrompt,
			boundProjectDocPrompt,
		] = await Promise.all([
			getAIModelWithMetadata(
				{ taskType: "TOOL_CALLING" },
				{ userId, organizationId },
			),
			getRAGProviderConfig({ userId, organizationId }),
			getBoundPromptVersion({
				targetType: "AGENT",
				targetKey: "document_generator",
				documentType: DOCUMENT_GENERATOR_DOC_TYPE,
				userId,
				organizationId,
			}),
			getBoundPromptVersion({
				targetType: "AGENT",
				targetKey: "project_document_generator",
				documentType: PROJECT_DOCUMENT_GENERATOR_DOC_TYPE,
				userId,
				organizationId,
			}),
		]);

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

		// providerConfig.apiKey is already decrypted by getRAGProviderConfig.
		// Both client and adapter are stateless beyond construction args, so
		// caching them shaves the per-request allocation on the AG-UI poll path.
		//
		// Databricks: `buildEffectiveBaseUrl` returns the raw workspace host, so a
		// bare host needs `/serving-endpoints` appended (idempotent for a URL that
		// already carries a path, e.g. the Unity AI Gateway). The compat fetch
		// corrects the OpenAI-schema divergences the serving endpoints reject.
		// Other providers are unaffected — same base URL, default fetch.
		const isDatabricks = metadata.provider === "DATABRICKS";
		// Gate <think> stripping on the resolved CANONICAL identity (Bug #1942
		// review) — the alias in `metadata.modelString` may be opaque (`prod-chat`).
		const isReasoning = isReasoningModelName(metadata.canonicalName);
		const databricksFetch =
			isDatabricks && isReasoning
				? createDatabricksFetch(undefined, { stripReasoning: true })
				: createDatabricksFetch();
		const openaiClient = new OpenAI({
			apiKey: providerConfig.apiKey,
			baseURL: isDatabricks
				? toDatabricksServingBaseUrl(aiGatewayUrl)
				: aiGatewayUrl,
			...(isDatabricks && { fetch: databricksFetch }),
		});
		const serviceAdapter = new OpenAIAdapter({
			model: metadata.modelString,
			openai: openaiClient,
		} as never);

		return {
			aiGatewayUrl,
			providerConfig,
			boundDocPrompt,
			boundProjectDocPrompt,
			metadata,
			trackUsage,
			openaiClient,
			serviceAdapter,
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

export async function POST(req: NextRequest) {
	try {
		// Get user session for authentication
		const headersList = await headers();
		const session = await auth.api.getSession({
			headers: headersList,
		});

		if (!session?.user) {
			return new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		// Get AI Gateway configuration (same as AI chatbot)
		const url = new URL(req.url);
		const organizationId =
			url.searchParams.get("organizationId") || undefined;

		// Rate limit: 500 requests per minute per user
		// AG-UI protocol (CopilotKit 1.50+) makes multiple requests per agent
		// connection (info, connect, stream), and code search tools add extra calls.
		// Client-side exponential backoff (CopilotFetchErrorInterceptor) prevents
		// cascading retries, so this limit is a safety net.
		const rateLimitResult = await checkRateLimit(
			`copilotkit:${session.user.id}`,
			500,
			60_000,
		);
		if (!rateLimitResult.allowed) {
			// Diagnostic: confirms when our app-side limit is the source of 429s
			// vs upstream provider/gateway. Pair with the upstream branch below
			// to disambiguate during the roadmap rate-limit investigation.
			logger.warn("[CopilotKit] App-side rate limit tripped", {
				userId: session.user.id,
				organizationId,
				limit: 500,
				windowMs: 60_000,
				remaining: rateLimitResult.remaining,
				resetInSeconds: rateLimitResult.resetInSeconds,
				path: url.pathname,
			});
			return new Response(
				JSON.stringify({
					error: "Too many requests",
					message: `Rate limit exceeded. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
					retryAfter: rateLimitResult.resetInSeconds,
					source: "app",
				}),
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After":
							rateLimitResult.resetInSeconds.toString(),
						"X-Rate-Limit-Source": "app",
					},
				},
			);
		}

		// Resolve per-tenant AI config + bound prompts (cached for TENANT_CACHE_TTL_MS)
		let tenantConfig: TenantConfig;
		try {
			tenantConfig = await getTenantConfig(
				session.user.id,
				organizationId,
			);
		} catch (error) {
			// AI usage-limit chokepoint hit a HARD limit.
			// Surface the rich payload so the client
			// fetch interceptor can render the shared destructive toast
			// instead of the generic "AI service is busy" 429 copy.
			if (error instanceof AiUsageLimitExceededError) {
				return new Response(
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
				);
			}
			if (error instanceof TenantConfigError) {
				return new Response(
					JSON.stringify({ error: error.message, code: error.code }),
					{
						status: error.httpStatus,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			logger.error("[CopilotKit] Failed to resolve tenant config", {
				error,
			});
			return new Response(
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
			);
		}

		const {
			aiGatewayUrl,
			providerConfig,
			boundDocPrompt,
			boundProjectDocPrompt,
			metadata,
			trackUsage,
			serviceAdapter,
		} = tenantConfig;

		// Track usage (fire-and-forget) — kept per-request to preserve
		// existing usage-accounting semantics.
		trackUsage();

		// Issue a short-lived AI token instead of passing the raw API key.
		// Agents will exchange this token for the actual API key via
		// /api/ai/keys/exchange. Per-request: tokens are short-lived by design.
		let aiToken: string;
		try {
			aiToken = await issueAIToken({
				userId: session.user.id,
				organizationId,
				source: "copilotkit",
				expirySeconds: AI_TOKEN_TTL_SECONDS,
			});
		} catch (error) {
			logger.error("[CopilotKit] Failed to issue AI token", { error });
			return new Response(
				JSON.stringify({
					error: "Failed to issue AI token. Please check AI_TOKEN_SECRET is configured.",
					code: "AI_TOKEN_ISSUE_FAILED",
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		logger.debug("[CopilotKit] Request config", {
			userId: session.user.id,
			organizationId: organizationId ?? "none",
			provider: metadata.provider,
			modelSource: metadata.selectionSource || "fallback",
			model: metadata.modelString,
			gatewayUrl: aiGatewayUrl,
			boundDocPromptId: boundDocPrompt?.id ?? null,
			boundProjectDocPromptId: boundProjectDocPrompt?.id ?? null,
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
		// Canonical-derived "emits <think>" signal (Bug #1942 review). Passed to
		// agents so a DeepSeek-R1 Databricks endpoint mapped to an opaque alias
		// (e.g. `prod-chat`, which the agent otherwise can't recognize as R1) still
		// gets its reasoning stripped, while a non-R1 model's literal `<think>` is
		// preserved. Resolved from the CANONICAL name, not the serving alias.
		const aiIsReasoning = isReasoningModelName(metadata.canonicalName);
		const agentHeaders = {
			// Service-to-service auth — verified by agent-core auth middleware
			// against the AGENT_API_KEY secret each agent container has.
			...(agentApiKey && {
				Authorization: `Bearer ${agentApiKey}`,
			}),
			// Tenant context for user/org identification
			"X-Tenant-User-ID": session.user.id,
			...(organizationId && {
				"X-Tenant-Organization-ID": organizationId,
			}),
			// AI token - agents exchange this for API credentials via /api/ai/keys/exchange
			// This replaces the insecure X-AI-API-Key header with a short-lived JWT
			[AI_TOKEN_HEADER]: aiToken,
			// Model/provider hints (not sensitive) - agents may use these or fetch fresh config
			...(metadata.modelString && {
				"X-AI-Model": metadata.modelString,
			}),
			...(aiGatewayUrl && { "X-AI-Base-URL": aiGatewayUrl }),
			...(metadata.provider && {
				"X-AI-Provider": metadata.provider,
			}),
			// Azure AI Foundry deployment name (user-defined in Azure portal)
			...(providerConfig.deploymentName && {
				"X-AI-Deployment-Name": providerConfig.deploymentName,
			}),
			"X-AI-Is-Reasoning": aiIsReasoning ? "true" : "false",
		};

		// Build LangGraphHttpAgent wrappers from the module-scope registry.
		// Cheap: each is just a {url, headers} container.
		const agents: Record<string, LangGraphHttpAgent> = {};
		for (const agent of agentRegistry.getAll()) {
			if ("getDeploymentUrl" in agent) {
				const adapter = agent as LangGraphAgentAdapter<BaseAgentState>;
				agents[adapter.name] = new LangGraphHttpAgent({
					url: adapter.getDeploymentUrl(),
					headers: agentHeaders,
				});
			}
		}

		// Default-MCP tools for the CopilotSidebar surfaces are now
		// registered as FRONTEND `useCopilotAction`s in
		// `apps/web/modules/saas/agents/hooks/useDefaultMcpInlineRender.tsx`,
		// not as backend `actions` on `CopilotRuntime`. Reason:
		// CopilotKit's AG-UI protocol only forwards frontend useCopilotAction
		// registrations to external LangGraph agents (like
		// `project_document_generator`). Backend `actions` flow only to the
		// built-in agent path, which the AI Feature/Document Assistants
		// don't use. Confirmed locally — when MCP tools were wired as
		// backend actions, the LangGraph agent's `boundTools` showed only
		// the agent's own [confirm_changes, write_document_local,
		// search_project_knowledge] and the LLM couldn't call create_view.
		// The frontend hook handles the call by POSTing to
		// `/api/mcp-app/invoke` with the tenant's configId, which executes
		// the MCP tool server-side. Tool result is enriched with the same
		// `__fabricMcpRender` envelope the wildcard render path expects.
		const runtime = new CopilotRuntime({
			agents,
		});

		const properties = {
			tenant_user_id: session.user.id,
			tenant_organization_id: organizationId ?? null,
			prompts_document_generator_version_id: boundDocPrompt?.id ?? null,
			prompts_document_generator_content:
				(boundDocPrompt as { content?: string } | null)?.content ??
				null,
			prompts_project_document_generator_version_id:
				boundProjectDocPrompt?.id ?? null,
			prompts_project_document_generator_content:
				(boundProjectDocPrompt as { content?: string } | null)
					?.content ?? null,
			fabric_api_url: url.origin,
			_copilotkit: { tenantId: organizationId ?? session.user.id },
			// AI model config for agents
			ai_provider: metadata.provider,
			ai_token: aiToken, // Token for secure API key exchange
			ai_model: metadata.modelString,
			ai_gateway_url: aiGatewayUrl,
			...(providerConfig.baseUrl && {
				ai_base_url: providerConfig.baseUrl,
			}),
			// Azure AI Foundry deployment name (user-defined in Azure portal)
			...(providerConfig.deploymentName && {
				ai_deployment_name: providerConfig.deploymentName,
			}),
			// Canonical-derived reasoning signal (Bug #1942 review).
			ai_is_reasoning: aiIsReasoning,
		};

		const systemPrompt = `You are Fabric AI, a helpful assistant for planning, coding, document generation, and more.\n\n${getCurrentDateContext()}`;

		// Use the Next.js App Router endpoint helper
		const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
			runtime,
			serviceAdapter,
			endpoint: "/api/copilotkit",
			properties: {
				...properties,
				// Pass system prompt to be used by the runtime
				system_prompt: systemPrompt,
			},
		});

		const upstreamResponse = await handleRequest(req);

		// Diagnostic: tag upstream 429s so the client interceptor can show the
		// correct "provider is busy" message instead of blaming the user, and
		// so logs distinguish provider/gateway throttling from our app limit.
		if (upstreamResponse.status === 429) {
			logger.warn("[CopilotKit] Upstream 429 from provider/gateway", {
				userId: session.user.id,
				organizationId,
				retryAfter: upstreamResponse.headers.get("Retry-After"),
				provider: metadata.provider,
				gatewayUrl: aiGatewayUrl,
			});
			const taggedHeaders = new Headers(upstreamResponse.headers);
			taggedHeaders.set("X-Rate-Limit-Source", "upstream");
			return new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: taggedHeaders,
			});
		}

		return upstreamResponse;
	} catch (error) {
		logger.error("[CopilotKit] Unhandled error", { error });
		const message =
			error instanceof Error ? error.message : "Internal server error";
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
}

export const runtime = "nodejs";
export const maxDuration = 800; // 13 min — agents can take 5+ min for document generation with tool calls
