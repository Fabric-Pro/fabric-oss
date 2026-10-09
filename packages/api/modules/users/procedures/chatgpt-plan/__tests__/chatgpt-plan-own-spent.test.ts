/**
 * The status the shell reads to warn a member whose own plan window is spent
 * (Fizzy #2770): it says when the plan resets and whether the organization's
 * shared plan is serving their work meanwhile.
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	exhausted: vi.fn(),
	pick: vi.fn(),
	servesBackground: vi.fn(async (_organizationId: string) => false),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getChatGptPlanCredentialStatus: async () => ({
		email: "dev@example.com",
		status: "ACTIVE",
	}),
	listChatGptPlanOrganizations: async () => [
		{
			id: "org-1",
			slug: "example-org",
			name: "Example Org",
			enabled: true,
			answered: true,
			includeBackgroundJobs: false,
		},
	],
	setChatGptPlanOrgUse: vi.fn(),
	getChatGptPlanUserWindow: async () => ({
		windowStart: null,
		resetsAt: null,
		lastRequestAt: null,
		requests: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		topConsumers: [],
	}),
	getChatGptPlanWindowBudget: async () => 2_000_000,
	CHATGPT_PLAN_WINDOW_MS: 5 * 60 * 60_000,
	CHATGPT_PLAN_NO_WINDOW_INPUT_TOKENS: 1_000_000_000,
	chatGptPlanWindowPercent: () => 0,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/subscription-backfill", () => ({
	backfillChatGptPlanSubscription: async (_ref: unknown, row: unknown) => row,
}));

vi.mock("../share", async () => {
	const { z } = await import("zod");
	return {
		chatGptPlanSharedHereSchema: z.object({}).passthrough(),
		chatGptPlanShareState: async () => ({
			canShare: false,
			sharedHere: [],
		}),
	};
});

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	disconnectChatGptPlan: vi.fn(),
}));
vi.mock("@repo/ai/lib/chatgpt-plan/exhaustion-breaker", () => ({
	chatGptPlanSourceExhaustedError: mocks.exhausted,
}));
vi.mock("@repo/ai/lib/chatgpt-plan/pool", () => ({
	sharedPlanServesMember: mocks.pick,
	sharedPlansServeBackgroundWork: mocks.servesBackground,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		Permissions: { USER_READ_SELF: "", USER_UPDATE_SELF: "" },
		requirePermission: () => ({}),
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import { getChatGptPlanStatusProcedure } from "../index";

const status = () =>
	(
		getChatGptPlanStatusProcedure as unknown as {
			_handler: (args: { context: unknown }) => Promise<{
				ownPlanSpent: unknown;
			}>;
		}
	)._handler({
		context: {
			user: { id: "user-1" },
			session: { activeOrganizationId: "org-1" },
		},
	});

const RESET = new Date("2026-10-07T15:00:00Z");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("users.chatgptPlan.status — own plan spent", () => {
	it("is null while the own plan has usage left", async () => {
		mocks.exhausted.mockResolvedValue(null);
		mocks.pick.mockResolvedValue(false);
		await expect(status()).resolves.toMatchObject({ ownPlanSpent: null });
		// Asked once, for whether a shared account serves the member's work.
		expect(mocks.pick).toHaveBeenCalledTimes(1);
	});

	it("says the shared plan is serving the member's work until the reset", async () => {
		mocks.exhausted.mockResolvedValue(
			new SubscriptionPlanExhaustedError("spent", RESET),
		);
		mocks.pick.mockResolvedValue(true);
		await expect(status()).resolves.toMatchObject({
			ownPlanSpent: { resetAt: RESET, servedBySharedPlan: true },
		});
		expect(mocks.pick).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("says nothing serves it when no shared plan can", async () => {
		mocks.exhausted.mockResolvedValue(
			new SubscriptionPlanExhaustedError("spent", null),
		);
		mocks.pick.mockResolvedValue(false);
		await expect(status()).resolves.toMatchObject({
			ownPlanSpent: { resetAt: null, servedBySharedPlan: false },
		});
	});

	it("stays advisory: a failing check is null, never an error", async () => {
		mocks.exhausted.mockRejectedValue(new Error("database down"));
		await expect(status()).resolves.toMatchObject({ ownPlanSpent: null });
	});

	// Fizzy #2770: the shell's "AI provider required" notice reads this.
	it("says whether a shared account serves the member's own work here", async () => {
		mocks.exhausted.mockResolvedValue(null);
		mocks.pick.mockResolvedValue(true);
		await expect(status()).resolves.toMatchObject({
			sharedPlanServesOwnWork: true,
		});
		mocks.pick.mockRejectedValue(new Error("database down"));
		await expect(status()).resolves.toMatchObject({
			sharedPlanServesOwnWork: false,
		});
	});

	// Fizzy #2770 F3: the channel and meeting link dialogs read this.
	it("says whether the organization's shared plans serve its background jobs", async () => {
		mocks.exhausted.mockResolvedValue(null);
		mocks.pick.mockResolvedValue(false);
		mocks.servesBackground.mockResolvedValue(true);
		await expect(status()).resolves.toMatchObject({
			sharedPlansServeBackground: true,
		});
		expect(mocks.servesBackground).toHaveBeenCalledWith("org-1");
		mocks.servesBackground.mockResolvedValue(false);
		await expect(status()).resolves.toMatchObject({
			sharedPlansServeBackground: false,
		});
	});
});
