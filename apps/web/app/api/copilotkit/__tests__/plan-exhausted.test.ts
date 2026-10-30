/**
 * CopilotKit when every ChatGPT plan serving the member's interactive work is
 * spent (Fizzy #2770): a turn is refused up front with the plan's own 429,
 * which the fetch interceptor shows as "spent until HH:MM" — never a generic
 * error from inside a 200 stream. Mount-time calls still go through.
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RESET = new Date("2026-10-08T16:37:00.000Z");

const mocks = vi.hoisted(() => ({
	pickChatGptPlanSource: vi.fn(),
	interactiveApiFallback: vi.fn(),
	personalKeyFallback: vi.fn(),
	resolveModelWithProvider: vi.fn(),
	resolvePlanModel: vi.fn(),
	resolveCopilotOrgModel: vi.fn(),
	handleRequest: vi.fn(),
	providerConfig: vi.fn(),
	runtime: vi.fn(),
	handler: vi.fn(),
	agent: vi.fn(),
	session: { user: { id: "user-1" }, session: {} as Record<string, unknown> },
	copilotDurableRuntime: vi.fn(),
	/** What `copilotDurableRuntime` answers: null while the org flag is off. */
	durable: {
		current: null as {
			runner: { durable: true };
			onBeforeHandler: () => Promise<void>;
		} | null,
	},
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@ag-ui/langgraph", () => ({
	LangGraphHttpAgent: class {
		constructor(options: unknown) {
			mocks.agent(options);
		}
	},
}));

vi.mock("@copilotkit/runtime/v2", () => ({
	CopilotRuntime: class {
		constructor(options: unknown) {
			mocks.runtime(options);
		}
	},
	createCopilotRuntimeHandler: mocks.handler,
	InMemoryAgentRunner: class {},
}));

vi.mock("@repo/agent-core", () => ({
	AgentRegistry: class {
		register() {}
		getAll() {
			return [
				{
					id: "task_planner",
					getDeploymentUrl: () => "http://localhost:8126",
					name: "task_planner",
				},
			];
		}
	},
	LangGraphAgentAdapter: class {},
}));

vi.mock("@repo/agent-tools", () => ({
	ENHANCE_PROMPT_TOOL: {},
	REQUEST_HUMAN_APPROVAL_TOOL: {},
	WRITE_DOCUMENT_TOOL: {},
	WRITE_TASK_PLAN_TOOL: {},
}));

vi.mock("@repo/ai", () => ({
	buildEffectiveBaseUrl: (_provider: string, baseUrl: string) => baseUrl,
	getRAGProviderConfig: mocks.providerConfig,
	isReasoningModelName: (name: string) =>
		name.toLowerCase().includes("deepseek-r1"),
	resolveModelWithProvider: mocks.resolveModelWithProvider,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/agent-config", () => ({
	// As the real one maps a model the plan does not serve.
	chatGptPlanReconnectRefusal: (error: unknown) =>
		error instanceof Error &&
		error.name === "ChatGptPlanModelNotServedError"
			? {
					status: 409,
					body: {
						error: error.message,
						code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
					},
				}
			: null,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	enterAiInteractiveContext: () => {},
	isAiImpersonatedRequest: () => false,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/models", () => ({
	resolveChatGptPlanModel: mocks.resolvePlanModel,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/pool", () => ({
	pickChatGptPlanSource: mocks.pickChatGptPlanSource,
	chatGptPlanInteractiveApiFallback: mocks.interactiveApiFallback,
	chatGptPlanPersonalKeyFallback: mocks.personalKeyFallback,
	chatGptPlanPoolExhaustedMessage: () =>
		"Every ChatGPT plan this work may use has no usage left in this window.",
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	issueAIToken: async () => "ai-token",
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
}));

vi.mock("@repo/api/lib/requested-organization", () => ({
	resolveRequestedOrganization: async (params: {
		requestedOrganizationId?: string;
	}) => ({ ok: true, organizationId: params.requestedOrganizationId }),
	forbiddenOrganizationResponse: () => new Response(null, { status: 403 }),
}));

vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: async () => mocks.session } },
}));

vi.mock("@repo/database", () => ({}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));

vi.mock("../org-model", () => ({
	resolveCopilotOrgModel: mocks.resolveCopilotOrgModel,
}));

vi.mock("@saas/agents/runtime/thread", () => ({
	readThreadAccess: async () => ({ kind: "absent" }),
}));

// The durable runner and its guard have their own test (durable-runs.test.ts).
vi.mock("../durable-runs", () => ({
	copilotDurableRuntime: async (...args: unknown[]) => {
		mocks.copilotDurableRuntime(...args);
		return mocks.durable.current;
	},
}));

const { POST } = await import("../route");
const { ProposalPropsRedactingRunner } = await import("../proposal-run-runner");

const PROVIDER_MODEL = {
	metadata: {
		modelString: "gpt-5",
		provider: "OPENAI",
		canonicalName: "gpt-5",
	},
	trackUsage: () => {},
};

const ownPlanSpent = new SubscriptionPlanExhaustedError(
	"Your own ChatGPT plan has no usage left.",
	RESET,
);

// Each case uses its own organization: the route caches the tenant config per
// user and organization.
let orgCounter = 0;
function call(method: string): Promise<Response> {
	orgCounter += 1;
	return POST(
		new Request(
			`http://localhost/api/copilotkit?organizationId=org-${orgCounter}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ method, params: {}, body: {} }),
			},
		) as never,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.durable.current = null;
	mocks.handler.mockReturnValue(mocks.handleRequest);
	mocks.providerConfig.mockResolvedValue({
		apiKey: "sk-test",
		baseUrl: "https://gateway.example.com/v1",
	});
	mocks.resolveCopilotOrgModel.mockResolvedValue(PROVIDER_MODEL);
	mocks.resolvePlanModel.mockResolvedValue({ model: "gpt-5" });
	mocks.interactiveApiFallback.mockResolvedValue(false);
	mocks.personalKeyFallback.mockResolvedValue(null);
	// Reading the body proves the route's peek left it unread.
	mocks.handleRequest.mockImplementation(async (req: Request) => {
		await req.text();
		return new Response("ok", { status: 200 });
	});
});

describe("/api/copilotkit — every ChatGPT plan for the member's work is spent", () => {
	it("refuses a turn with the plan's 429 and offers API billing when it would reroute", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			policy: { apiFallbackInteractive: "ASK" },
			resetAt: RESET,
			ownPlanSpent,
		});

		const response = await call("agent/run");

		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toEqual({
			error: "Every ChatGPT plan this work may use has no usage left in this window.",
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: RESET.toISOString(),
			apiBillingOption: true,
			personalKeyOption: false,
		});
		expect(mocks.handleRequest).not.toHaveBeenCalled();
	});

	// Fizzy #3085: where the organization would stop the turn, the member's
	// own opted-in key runs the agents instead.
	it("runs the agents on the member's own opted-in key instead of stopping", async () => {
		const spent = {
			exhausted: true,
			audience: "interactive",
			policy: { apiFallbackInteractive: "ASK" },
			resetAt: RESET,
			ownPlanSpent,
		};
		const personal = {
			apiKey: "encrypted:example-personal-key",
			configId: "cfg-personal",
			provider: "ANTHROPIC_DIRECT",
			source: "user",
		};
		mocks.pickChatGptPlanSource.mockResolvedValue(spent);
		mocks.personalKeyFallback.mockResolvedValue({ config: personal });
		mocks.resolveModelWithProvider.mockResolvedValue({
			modelString: "claude-example",
		});

		const response = await call("agent/run");

		expect(response.status).toBe(200);
		expect(mocks.handleRequest).toHaveBeenCalled();
		expect(mocks.personalKeyFallback).toHaveBeenCalledWith(spent, {
			userId: "user-1",
			organizationId: expect.anything(),
		});
		expect(mocks.resolveModelWithProvider).toHaveBeenCalledWith(
			"COMPLEX",
			expect.objectContaining({ userId: "user-1" }),
			{ providerConfig: personal },
		);
		expect(mocks.resolvePlanModel).not.toHaveBeenCalled();
	});

	// Fizzy #3086: the stop links to opting a key in, when that would help.
	it("offers to set up a personal key when none is opted in", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			policy: { apiFallbackInteractive: "ASK" },
			resetAt: RESET,
		});
		mocks.personalKeyFallback.mockResolvedValue({ config: null });

		const response = await call("agent/run");

		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toMatchObject({
			personalKeyOption: true,
		});
	});

	// Fizzy #3048: "Use API billing" for people's own work.
	it("runs the agents on the organization's provider under the interactive AUTO policy", async () => {
		const spent = {
			exhausted: true,
			audience: "interactive",
			policy: { apiFallbackInteractive: "AUTO" },
			resetAt: RESET,
		};
		mocks.pickChatGptPlanSource.mockResolvedValue(spent);
		mocks.interactiveApiFallback.mockResolvedValue(true);

		const response = await call("agent/run");

		expect(response.status).toBe(200);
		expect(mocks.handleRequest).toHaveBeenCalled();
		expect(mocks.resolvePlanModel).not.toHaveBeenCalled();
		expect(mocks.interactiveApiFallback).toHaveBeenCalledWith(
			spent,
			expect.anything(),
		);
	});

	it("uses the member's own plan's sentence when only it was in play", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			policy: null,
			resetAt: RESET,
			ownPlanSpent,
			ownPlanOnly: true,
		});

		const response = await call("agent/run");

		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toMatchObject({
			error: "Your own ChatGPT plan has no usage left.",
			resetAt: RESET.toISOString(),
			apiBillingOption: true,
		});
	});

	it.each([
		[
			"the member has no plan of their own (only shared accounts serve them)",
			{ policy: { apiFallbackInteractive: "ASK" } },
			PROVIDER_MODEL,
		],
		[
			"the policy never falls back to API billing",
			{ policy: { apiFallbackInteractive: "NEVER" }, ownPlanSpent },
			PROVIDER_MODEL,
		],
		[
			"the organization has no AI provider",
			{ policy: { apiFallbackInteractive: "ASK" }, ownPlanSpent },
			null,
		],
	])("offers no API billing when %s", async (_label, pick, orgModel) => {
		mocks.resolveCopilotOrgModel.mockResolvedValue(orgModel);
		mocks.pickChatGptPlanSource.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			resetAt: RESET,
			...pick,
		});

		const response = await call("agent/run");

		expect(response.status).toBe(429);
		await expect(response.json()).resolves.toMatchObject({
			code: "subscription_sharing_usage_limit_exceeded",
			apiBillingOption: false,
		});
	});

	it.each(["info", "agent/connect", "agent/stop"])(
		"never refuses a %s call",
		async (method) => {
			mocks.pickChatGptPlanSource.mockResolvedValue({
				exhausted: true,
				audience: "interactive",
				policy: null,
				resetAt: RESET,
				ownPlanSpent,
			});

			const response = await call(method);

			expect(response.status).toBe(200);
			expect(mocks.handleRequest).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		[
			"a plan with usage left",
			{ source: { kind: "user", userId: "user-1" } },
		],
		["no plan at all", null],
	])("runs the turn as before on %s", async (_label, pick) => {
		mocks.pickChatGptPlanSource.mockResolvedValue(pick);

		const response = await call("agent/run");

		expect(response.status).toBe(200);
		expect(mocks.handleRequest).toHaveBeenCalledTimes(1);
	});
});

// The agents' model hint follows the plan the pick chose, and a plan that
// serves no usable model is the 409 every other agent route answers.
describe("/api/copilotkit — the plan model hint", () => {
	it("resolves the hint on the shared account the pick chose", async () => {
		const source = {
			kind: "org",
			organizationId: "org-x",
			accountId: "acc-1",
		};
		mocks.pickChatGptPlanSource.mockResolvedValue({ source });
		const response = await call("agent/run");
		expect(response.status).toBe(200);
		expect(mocks.resolvePlanModel).toHaveBeenCalledWith(
			expect.objectContaining({ taskType: "COMPLEX", source }),
		);
	});

	it("answers 409 CHATGPT_PLAN_MODEL_NOT_SERVED, not a 500", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue({
			source: { kind: "user", userId: "user-1" },
		});
		const notServed = Object.assign(
			new Error("The ChatGPT plan does not serve gpt-5.6-luna."),
			{ name: "ChatGptPlanModelNotServedError" },
		);
		mocks.resolvePlanModel.mockRejectedValue(notServed);
		const response = await call("agent/run");
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			code: "CHATGPT_PLAN_MODEL_NOT_SERVED",
		});
		expect(mocks.handleRequest).not.toHaveBeenCalled();
	});
});

// Every `<CopilotKit useSingleEndpoint>` mount posts a `{ method, params, body }`
// envelope to this one path, so the handler must stay in single-route mode.
describe("/api/copilotkit — the runtime handler", () => {
	it("serves the single-route envelope at /api/copilotkit", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		expect((await call("info")).status).toBe(200);
		expect(mocks.handler).toHaveBeenCalledWith(
			expect.objectContaining({
				basePath: "/api/copilotkit",
				mode: "single-route",
				cors: true,
			}),
		);
		expect(mocks.handleRequest).toHaveBeenCalledTimes(1);
	});

	it("marks the tenant on CopilotKit's telemetry as the v1 endpoint did", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		await call("info");
		expect(mocks.runtime).toHaveBeenCalledWith(
			expect.objectContaining({
				telemetryProperties: {
					_copilotkit: { tenantId: `org-${orgCounter}` },
				},
			}),
		);
	});

	it("never forwards browser-sent tenant or model headers to the agents", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		await call("info");
		expect(mocks.runtime).toHaveBeenCalledWith(
			expect.objectContaining({
				forwardHeaders: { denyPrefixes: ["x-ai-", "x-tenant-"] },
			}),
		);
	});

	it("keeps its in-memory runner and no hook while durable runs are off for the organization", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		await call("info");

		const [runtimeOptions] = mocks.runtime.mock.calls[0];
		const [handlerOptions] = mocks.handler.mock.calls[0];
		// The route's own runner, which keeps the Proposal chat's server-only
		// keys out of the browser's events (`proposal-run-runner.ts`).
		expect(runtimeOptions.runner).toBeInstanceOf(
			ProposalPropsRedactingRunner,
		);
		expect(handlerOptions).not.toHaveProperty("hooks");
	});

	it("hands the durable runtime that same in-memory runner for its fallback and the other agents", async () => {
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		await call("info");

		const [runtimeOptions] = mocks.runtime.mock.calls[0];
		const [, , inProcess] = mocks.copilotDurableRuntime.mock.calls[0];
		expect(inProcess).toBe(runtimeOptions.runner);
	});

	it("runs on the durable runner, behind its guard, while durable runs are on", async () => {
		const durable = {
			runner: { durable: true as const },
			onBeforeHandler: async () => undefined,
		};
		mocks.durable.current = durable;
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		await call("info");

		expect(mocks.runtime).toHaveBeenCalledWith(
			expect.objectContaining({ runner: durable.runner }),
		);
		expect(mocks.handler).toHaveBeenCalledWith(
			expect.objectContaining({
				hooks: { onBeforeHandler: durable.onBeforeHandler },
			}),
		);
	});
});

it.each(["org", "plan", "personal", "org-nonreasoning"])(
	"forwards model hints for %s credentials",
	async (source) => {
		mocks.pickChatGptPlanSource.mockResolvedValue(null);
		mocks.resolveCopilotOrgModel.mockResolvedValue({
			metadata: {
				provider: "DATABRICKS",
				modelString: "prod-chat",
				canonicalName:
					source === "org-nonreasoning"
						? "llama-3-3-70b"
						: "deepseek-r1",
			},
			trackUsage: () => {},
		});
		if (source === "plan") {
			mocks.pickChatGptPlanSource.mockResolvedValue({
				config: { accessToken: "example-token" },
				source: "own",
				audience: "interactive",
			});
		} else if (source === "personal") {
			mocks.pickChatGptPlanSource.mockResolvedValue({
				exhausted: true,
				audience: "interactive",
				policy: { apiFallbackInteractive: "ASK" },
				resetAt: RESET,
				ownPlanSpent,
			});
			mocks.personalKeyFallback.mockResolvedValue({
				config: {
					apiKey: "example-key",
					provider: "ANTHROPIC_DIRECT",
					source: "user",
				},
			});
			mocks.resolveModelWithProvider.mockResolvedValue({
				modelString: "personal-model",
			});
		}
		expect((await call("agent/run")).status).toBe(200);
		const headers = mocks.agent.mock.calls.at(-1)?.[0].headers;
		expect(headers).toBeDefined();
		if (source.startsWith("org")) {
			expect(headers["X-AI-Model"]).toBe("prod-chat");
			expect(headers["X-AI-Is-Reasoning"]).toBe(
				source === "org" ? "true" : "false",
			);
		} else {
			expect(headers["X-AI-Model"]).toBe(
				source === "plan" ? "gpt-5" : "personal-model",
			);
			expect(headers).not.toHaveProperty("X-AI-Is-Reasoning");
		}
	},
);
