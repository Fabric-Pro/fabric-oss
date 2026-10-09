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
	resolvePlanModel: vi.fn(),
	resolveCopilotOrgModel: vi.fn(),
	handleRequest: vi.fn(),
	session: { user: { id: "user-1" }, session: {} as Record<string, unknown> },
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@ag-ui/langgraph", () => ({
	LangGraphHttpAgent: class {},
}));

vi.mock("@copilotkit/runtime", () => ({
	CopilotRuntime: class {},
	ExperimentalEmptyAdapter: class {},
	OpenAIAdapter: class {},
	copilotRuntimeNextJSAppRouterEndpoint: () => ({
		handleRequest: mocks.handleRequest,
	}),
}));

vi.mock("@repo/agent-core", () => ({
	AgentRegistry: class {
		register() {}
		getAll() {
			return [];
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
	buildEffectiveBaseUrl: () => "https://gateway.example.com/v1",
	createDatabricksFetch: () => undefined,
	getCurrentDateContext: () => "",
	getRAGProviderConfig: async () => ({
		apiKey: "sk-test",
		baseUrl: "https://gateway.example.com/v1",
	}),
	isReasoningModelName: () => false,
	toDatabricksServingBaseUrl: (url: string) => url,
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

vi.mock("@repo/database", () => ({
	getBoundPromptVersion: async () => null,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));

vi.mock("openai", () => ({ default: class {} }));

vi.mock("../org-model", () => ({
	resolveCopilotOrgModel: mocks.resolveCopilotOrgModel,
}));

const { POST } = await import("../route");

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
	mocks.resolveCopilotOrgModel.mockResolvedValue(PROVIDER_MODEL);
	mocks.resolvePlanModel.mockResolvedValue({ model: "gpt-5" });
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
		});
		expect(mocks.handleRequest).not.toHaveBeenCalled();
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
