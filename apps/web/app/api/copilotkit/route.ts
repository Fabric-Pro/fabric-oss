/**
 * CopilotKit Runtime API Route
 * Routes through Vercel AI Gateway like the AI Chatbot
 *
 * DO NOT MODIFY this route's proxy semantics.
 * See fabric/specs/2026-05-19-ai-assistant-document-chat-history/spec.md §6.7
 * and §3.10 FR-26. Persistence of document-assistant chat turns lives in
 * `apps/web/modules/saas/projects/components/copilot/CopilotPersistenceHook.tsx`
 * (Group H), NOT here. The existing tenant cache, AI-token issuance, and
 * rate-limit semantics must remain the sole authority for who-can-write-what
 * at the runtime level.
 *
 * The one rewrite of what reaches the agents: every `agent/run` and
 * `agent/suggest` carries the server-resolved Proposal chat config in its
 * `forwardedProps`, and client values for those keys are dropped (Fizzy
 * #2946, `./proposal-client-run`). A thread is run and replayed only for the
 * user who started it, and only for its conversation's owner when it names
 * one (`./proposal-run-runner`).
 */

// `LangGraphHttpAgent` must come from `@ag-ui/langgraph` (bundled by Turbopack),
// not from the `@copilotkit/runtime/langgraph` re-export of the same class. The
// runtime is a server-external package, so Node would load that subpath itself and
// reach `@langchain/langgraph-sdk`'s vendored ESM helpers, which sit under a
// `dist/node_modules/` directory with no package.json. Node cannot classify those
// files on runtimes that disable module-syntax detection (AWS Lambda, i.e. Vercel
// functions) and fails the whole route at module load with ERR_REQUIRE_CYCLE_MODULE.
import { LangGraphHttpAgent } from "@ag-ui/langgraph";
import {
	CopilotRuntime,
	createCopilotRuntimeHandler,
	InMemoryAgentRunner,
} from "@copilotkit/runtime/v2";
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
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { checkRateLimit } from "@repo/api/lib/rate-limit";
import {
	forbiddenOrganizationResponse,
	resolveRequestedOrganization,
} from "@repo/api/lib/requested-organization";
import { auth } from "@repo/auth";
import { logger } from "@repo/logs";
import { withBoundedAgentRequestBody } from "@saas/agents/runtime/request-body";
import { readThreadAccess } from "@saas/agents/runtime/thread";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import {
	dataAnalystUrl,
	issueCopilotAgentRequest,
	resolveCopilotTenant,
} from "./agent-request";
import { copilotDurableRuntime } from "./durable-runs";
import {
	readDocumentIdParam,
	readSingleRouteEnvelope,
	resolveProposalRunConfig,
	rewriteAgentRunBody,
	withEnvelope,
	withoutClientProposalProps,
} from "./proposal-client-run";
import { ProposalPropsRedactingRunner } from "./proposal-run-runner";

// Note: `./default-mcp-tools` (PR #892 / #897) is no longer imported
// here. See the comment near the `CopilotRuntime` constructor below for
// why backend `actions` are incompatible with external LangGraph agents
// and how the equivalent surface now lives in
// `useDefaultMcpInlineRender.tsx` as frontend `useCopilotAction`s.

// ─── Module-scope agent registry ─────────────────────────────────────────
// Agents are static: deploymentUrl/graphId/tools come from env + constants.
// `LangGraphHttpAgent` only transmits url+headers on the wire; per-user
// model state arrives via the `X-AI-*` headers, so the adapter doesn't
// need request-scoped data. Build once at module load.

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
		deploymentUrl: dataAnalystUrl(),
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
// Caches the per-request DB lookups (AI provider config, model resolution)
// per (userId, organizationId). Stores the Promise so that concurrent first-
// misses dedupe into a single fetch. Rejected promises evict so the next
// request retries cleanly.

/**
 * POST is the ONLY method this route exports — do not add a `GET`.
 *
 * `createCopilotRuntimeHandler` runs in `single-route` mode: every client
 * call (`info`, `agent/connect`, `agent/run`, `agent/stop`) arrives as a
 * POST to this one path carrying a `{ method, params, body }` envelope.
 * Every `<CopilotKit>` mount passes `useSingleEndpoint` so the client uses
 * that transport directly and never probes for a REST runtime.
 *
 * Auth, tenancy, limits, the plan refusals and the Proposal run rewrite stay
 * here rather than in the handler's hooks: the agents are built from what
 * they resolve, and a Response thrown from a hook gets the handler's CORS
 * headers and its generic `internal_error` 500, which these answers never
 * carried. The one hook, `durable.onBeforeHandler` (only while durable runs
 * are on for the organization), needs the method, agent and thread only the
 * handler parses, and refuses a durable run, connect or stop on someone
 * else's thread with a 403 (`durable-runs.ts`).
 *
 * Keep the mounts and this route in step. Drop the prop from a mount and
 * the 1.70+ client defaults to `transport: "auto"`, probing
 * `GET <runtimeUrl>/info` first; this POST-only route answers with a 405,
 * and the app's fetch interceptor surfaces that as an error toast before
 * the client falls back to single-route transport.
 *
 * Every mount also passes `enableInspector={false}`. In local development
 * the 1.80 client otherwise mounts CopilotKit's inspector, which lists
 * threads with `GET <runtimeUrl>/threads`. The runtime URL already carries
 * `?organizationId=`, so the client cannot turn that request into a
 * single-route POST, and this route answers with a 405.
 */
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
		// This person's own request — or an admin acting as them, which no
		// ChatGPT plan may serve (Fizzy #2939).
		enterAiInteractiveContext({
			userId: session.user.id,
			impersonated: Boolean(session.session.impersonatedBy),
		});

		// The organization arrives on the query string from the mount
		// (`/api/copilotkit?organizationId=...`). It selects the tenant's
		// model, provider key, the document check below and the tenant
		// headers sent to the agents, so it is bound to the caller's
		// memberships below before anything reads it.
		const url = new URL(req.url);
		const requestedOrganizationId =
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
				organizationId: requestedOrganizationId,
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

		// Resolve per-tenant AI config (cached for TENANT_CACHE_TTL_MS)
		// An omitted id resolves to the session's active organization, tie
		// checked the same way; a session with none is refused (ADR-018).
		const organizationResolution = await resolveRequestedOrganization({
			userId: session.user.id,
			requestedOrganizationId,
			activeOrganizationId: session.session.activeOrganizationId,
		});
		if (!organizationResolution.ok) {
			logger.warn("[CopilotKit] Requested organization refused", {
				userId: session.user.id,
				organizationId: requestedOrganizationId,
			});
			return forbiddenOrganizationResponse(organizationResolution);
		}
		const organizationId = organizationResolution.organizationId;
		const boundedRequest = await withBoundedAgentRequestBody(req);
		if (boundedRequest instanceof Response) {
			return boundedRequest;
		}

		// Only a turn (`agent/run`) is refused for a spent ChatGPT plan and
		// has its run input rewritten: the mount-time `info` /
		// `agent/connect` calls must still succeed and resolve nothing.
		const envelope = await readSingleRouteEnvelope(boundedRequest);
		const isAgentRun = envelope?.method === "agent/run";
		// A suggestion runs the agent too, so it gets the same resolution.
		const invokesAgent = isAgentRun || envelope?.method === "agent/suggest";

		const resolution = await resolveCopilotTenant({
			userId: session.user.id,
			organizationId,
			isAgentRun,
		});
		if (!resolution.ok) {
			return resolution.response;
		}
		const { tenant } = resolution;

		// What the chat may do on its document (Fizzy #2946), resolved per
		// run and written into the run input the agent receives. The editor
		// adds `documentId` to the query beside `organizationId`.
		let runtimeRequest: Request = boundedRequest;
		if (
			envelope &&
			!invokesAgent &&
			typeof envelope.body === "object" &&
			envelope.body !== null &&
			!Array.isArray(envelope.body)
		) {
			// Nothing is resolved for other calls, but no client value for a
			// route-owned key ever reaches the agent either.
			const sent = envelope.body as Record<string, unknown>;
			const stripped = withoutClientProposalProps(sent);
			if (stripped !== sent) {
				runtimeRequest = withEnvelope(boundedRequest, {
					...envelope,
					body: stripped,
				});
			}
		}
		if (invokesAgent && envelope) {
			const runInput =
				typeof envelope.body === "object" &&
				envelope.body !== null &&
				!Array.isArray(envelope.body)
					? (envelope.body as Record<string, unknown>)
					: null;
			const resolution = await resolveProposalRunConfig({
				documentId: readDocumentIdParam(url),
				organizationId,
				userId: session.user.id,
				state: runInput?.state,
			});
			if (!resolution.ok) {
				return new Response(
					JSON.stringify({
						error:
							resolution.status === 403
								? "Forbidden"
								: "The assistant could not be prepared for this document. Please try again.",
						code: resolution.code,
					}),
					{
						status: resolution.status,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			// A malformed run input is left for the runtime to refuse.
			if (runInput) {
				runtimeRequest = withEnvelope(boundedRequest, {
					...envelope,
					body: rewriteAgentRunBody(runInput, resolution.config),
				});
			}
		}

		const issued = await issueCopilotAgentRequest({
			userId: session.user.id,
			organizationId,
			tenant,
		});
		if (!issued.ok) {
			return issued.response;
		}
		const { headers: agentHeaders, settings } = issued.request;

		// Build LangGraphHttpAgent wrappers from the module-scope registry.
		// Cheap: each is just a {url, headers} container.
		const agents: Record<string, LangGraphHttpAgent> = {};
		for (const agent of agentRegistry.getAll()) {
			if ("getDeploymentUrl" in agent) {
				const adapter = agent as LangGraphAgentAdapter<BaseAgentState>;
				agents[adapter.name] = new LangGraphHttpAgent({
					url: adapter.getDeploymentUrl(),
					headers: {
						...agentHeaders,
						...(adapter.name === "project_document_generator" && {
							"X-Fabric-Reply-Transport": "in-request-v1",
						}),
					},
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
		//
		// The assistants' agent runs durably on Temporal (`durable-runs.ts`).
		// The worker rebuilds `agentHeaders` from these hints, this request's
		// AI token and its own AGENT_API_KEY. The token reaches the worker only
		// inside the run's Redis input record, which the worker deletes on
		// pickup — never in the workflow's input or history — and the worker
		// holds no AI_TOKEN_SECRET to mint one itself. Its lifetime
		// (AI_TOKEN_TTL_SECONDS) bounds the durable run: the activity's
		// start-to-close is that less a pickup slack (`agui-run-contract.ts`).
		// When the durable path cannot take a run, the agent built above runs
		// in this request as before (`AgUiAgentEngine`'s fallback), on the
		// in-memory runner below, which also serves every other agent.
		// Null while COPILOTKIT_DURABLE_ASSISTANTS is off for the organization:
		// the in-memory runner then serves every agent.
		//
		// The in-memory runner keeps the Proposal chat's server-only
		// `forwardedProps` out of the events the browser receives, and runs,
		// replays and stops a thread only for the user who started it and,
		// when the thread names a saved conversation, only for that
		// conversation's owner (`./proposal-run-runner`). Built per request,
		// so it is bound to this session's user and organization. The durable
		// path never stores those keys where the browser reads
		// (`./durable-runs`).
		const caller = { userId: session.user.id, organizationId };
		const inProcessRunner = new ProposalPropsRedactingRunner(
			new InMemoryAgentRunner(),
			session.user.id,
			(threadId) => readThreadAccess(threadId, caller),
		);
		const durable = await copilotDurableRuntime(
			caller,
			settings,
			inProcessRunner,
		);
		const runtime = new CopilotRuntime({
			agents,
			runner: durable ? durable.runner : inProcessRunner,
			// The only part of the v1 endpoint's `properties` it ever used:
			// a tenant marker on CopilotKit's telemetry. The agents never saw
			// those properties; everything they get is in `agentHeaders`.
			telemetryProperties: {
				_copilotkit: { tenantId: organizationId ?? session.user.id },
			},
			// The handler forwards the browser's `x-*` headers the server did
			// not set, and agent-core falls back to `X-AI-Base-URL` and
			// `X-AI-Deployment-Name` when the token exchange has none. Tenant
			// and model context and Fabric control headers come from server config.
			forwardHeaders: {
				denyPrefixes: ["x-ai-", "x-tenant-", "x-fabric-"],
			},
		});

		// The same handler the v1 endpoint built, permissive CORS included,
		// without its Hono wrapper.
		const handleRequest = createCopilotRuntimeHandler({
			runtime,
			basePath: "/api/copilotkit",
			mode: "single-route",
			cors: true,
			...(durable && {
				hooks: { onBeforeHandler: durable.onBeforeHandler },
			}),
		});

		const upstreamResponse = await handleRequest(runtimeRequest);

		// Diagnostic: tag upstream 429s so the client interceptor can show the
		// correct "provider is busy" message instead of blaming the user, and
		// so logs distinguish provider/gateway throttling from our app limit.
		if (upstreamResponse.status === 429) {
			logger.warn("[CopilotKit] Upstream 429 from provider/gateway", {
				userId: session.user.id,
				organizationId,
				retryAfter: upstreamResponse.headers.get("Retry-After"),
				provider: tenant.config.metadata.provider,
				gatewayUrl: tenant.config.aiGatewayUrl,
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
