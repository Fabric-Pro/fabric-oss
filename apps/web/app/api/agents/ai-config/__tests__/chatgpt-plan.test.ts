/**
 * The agents' ai-config routes and a member's own ChatGPT plan (Fizzy #2939).
 *
 * These routes authenticate with signed tenant headers, which carry no sign
 * that a person is present, so they resolve to the plan only when the member
 * chose "also use it for background jobs and agents" in an organization with
 * the flag on. The real routing gate runs; the database is the seam.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	activeUse: vi.fn(),
	getPlanToken: vi.fn(),
	impersonated: false,
}));

const ORG_KEY = "sk-org-key-example";

vi.mock("@repo/agent-runtime", () => ({
	verifySignedTenantRequest: () => ({
		ok: true,
		userId: "user-1",
		organizationId: "org-1",
		impersonated: mocks.impersonated,
	}),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
	getActiveChatGptPlanOrgUse: mocks.activeUse,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: mocks.getPlanToken,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/exhaustion-breaker", () => ({
	chatGptPlanExhaustedError: () => null,
	chatGptPlanSourceExhaustedError: async () => null,
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));

vi.mock("@repo/ai", async () => {
	const { shouldUseChatGptPlan } = await vi.importActual<
		typeof import("@repo/ai/lib/chatgpt-plan/routing")
	>("@repo/ai/lib/chatgpt-plan/routing");
	return {
		buildEffectiveBaseUrl: () => "https://gateway.example.com/v1",
		requiresBaseUrl: () => false,
		isReasoningModelName: () => false,
		getRAGProviderConfig: async () => ({
			apiKey: ORG_KEY,
			baseUrl: "https://gateway.example.com/v1",
			deploymentName: null,
		}),
		getAIModelWithMetadata: async (
			_options: unknown,
			context: { userId: string; organizationId?: string },
		) => {
			const onPlan = await shouldUseChatGptPlan(context);
			return {
				metadata: onPlan
					? {
							provider: "OPENAI_CHATGPT_PLAN",
							modelString: "gpt-6-astra",
							canonicalName: "gpt-6-astra",
							selectionSource: "chatgpt_plan",
						}
					: {
							provider: "OPENROUTER",
							modelString: "openai/gpt-4o-mini",
							canonicalName: "gpt-4o-mini",
							selectionSource: "org_override",
						},
				trackUsage: vi.fn(),
			};
		},
	};
});

const { GET: getConfig } = await import("../route");
const { GET: getTaskConfig } = await import("../task/route");

const request = (path: string) =>
	new Request(`http://localhost${path}`) as unknown as Parameters<
		typeof getConfig
	>[0];

const ROUTES = [
	["ai-config", () => getConfig(request("/api/agents/ai-config"))],
	[
		"ai-config/task",
		() =>
			getTaskConfig(
				request("/api/agents/ai-config/task?taskType=TOOL_CALLING"),
			),
	],
] as const;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.impersonated = false;
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.getPlanToken.mockResolvedValue({
		accessToken: "plan-access-token",
		expiresAt: new Date(Date.now() + 30 * 60_000),
	});
});

describe.each(ROUTES)("GET /api/agents/%s — ChatGPT plan", (_name, call) => {
	it("stays on the organization provider when background jobs are off", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: false,
			credentialStatus: "ACTIVE",
		});
		const body = await (await call()).json();
		expect(body.provider).toBe("OPENROUTER");
		expect(body.apiKey).toBe(ORG_KEY);
		expect(JSON.stringify(body)).not.toContain("plan-access-token");
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});

	it("hands over the plan when the member included background jobs and agents", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const body = await (await call()).json();
		expect(body).toMatchObject({
			provider: "OPENAI_CHATGPT_PLAN",
			apiKey: "plan-access-token",
			model: "gpt-6-astra",
			gatewayUrl: null,
		});
		expect(JSON.stringify(body)).not.toContain(ORG_KEY);
		expect(mocks.getPlanToken).toHaveBeenCalledWith("user-1");
	});

	it("refuses with the reconnect error, never the organization key, when the plan needs reconnecting", async () => {
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "NEEDS_RECONNECT",
		});
		const response = await call();
		const text = await response.text();
		expect(response.status).toBe(409);
		expect(JSON.parse(text)).toMatchObject({
			code: "CHATGPT_PLAN_UNAVAILABLE",
		});
		expect(text).not.toContain(ORG_KEY);
	});

	// Fizzy #2770 D7: the signed headers say an admin was acting as the
	// member, exactly as an AI token's `imp` claim would.
	it("never hands over the plan for work signed as impersonated", async () => {
		mocks.impersonated = true;
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const body = await (await call()).json();
		expect(body.provider).toBe("OPENROUTER");
		expect(JSON.stringify(body)).not.toContain("plan-access-token");
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});

	it("stays on the organization provider when the flag is off, even with background jobs on", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.activeUse.mockResolvedValue({
			includeBackgroundJobs: true,
			credentialStatus: "ACTIVE",
		});
		const body = await (await call()).json();
		expect(body.provider).toBe("OPENROUTER");
		expect(mocks.getPlanToken).not.toHaveBeenCalled();
	});
});
