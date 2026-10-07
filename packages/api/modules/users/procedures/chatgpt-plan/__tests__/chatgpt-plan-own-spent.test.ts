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
	getChatGptPlanUsageSince: async () => ({
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
	}),
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	disconnectChatGptPlan: vi.fn(),
}));
vi.mock("@repo/ai/lib/chatgpt-plan/exhaustion-breaker", () => ({
	chatGptPlanSourceExhaustedError: mocks.exhausted,
}));
vi.mock("@repo/ai/lib/chatgpt-plan/pool", () => ({
	sharedPlanServesMember: mocks.pick,
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
		await expect(status()).resolves.toMatchObject({ ownPlanSpent: null });
		expect(mocks.pick).not.toHaveBeenCalled();
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
});
