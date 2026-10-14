/**
 * Testing one of the organization's shared ChatGPT plan accounts
 * (Fizzy #2770): only an account of the session's organization, only for its
 * admins and owners, only with CHATGPT_PLAN on, never while acting as someone
 * else, and every outcome of the one real request reaches the row in the
 * declared shape.
 */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flags: { CHATGPT_PLAN: true } as Record<string, boolean>,
	role: "admin" as string | null,
	accounts: new Map<string, Array<{ id: string; label: string }>>(),
	probe: vi.fn(),
	rateLimit: vi.fn(),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async (key: string) => mocks.flags[key] === true,
	listChatGptPlanOrgAccounts: async (organizationId: string) =>
		mocks.accounts.get(organizationId) ?? [],
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	disconnectChatGptPlanOrgAccount: vi.fn(),
}));

vi.mock("@repo/ai/lib/chatgpt-plan/subscription-backfill", () => ({
	backfillChatGptPlanSubscriptions: vi.fn(),
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-check", () => ({
	testChatGptPlanSource: mocks.probe,
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: mocks.rateLimit,
}));

vi.mock("../../../lib/membership", () => ({
	requireOrgMembership: async (
		_userId: string,
		organizationId: string,
		allowedRoles: string[],
	) =>
		mocks.role && allowedRoles.includes(mocks.role)
			? { role: mocks.role, organization: { id: organizationId } }
			: null,
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
		Permissions: { ORG_READ: "ORG_READ", ORG_UPDATE: "ORG_UPDATE" },
		requirePermission: () => ({}),
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import { chatGptPlanTestResultSchema } from "../../../../../lib/chatgpt-plan-test";
import { testChatGptPlanPoolAccountProcedure } from "../index";

type Handler = (args: {
	context: unknown;
	input?: unknown;
}) => Promise<unknown>;
const runTest = (
	accountId: string,
	overrides: { impersonatedBy?: string; organizationId?: string | null } = {},
) =>
	(
		testChatGptPlanPoolAccountProcedure as unknown as { _handler: Handler }
	)._handler({
		context: {
			user: { id: "user_1" },
			session: {
				activeOrganizationId:
					overrides.organizationId === undefined
						? "org_a"
						: overrides.organizationId,
				impersonatedBy: overrides.impersonatedBy ?? null,
			},
		},
		input: { accountId },
	});

const rejection = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flags = { CHATGPT_PLAN: true };
	mocks.role = "admin";
	mocks.accounts = new Map([
		["org_a", [{ id: "acc_a", label: "Shared plan A" }]],
		["org_b", [{ id: "acc_b", label: "Shared plan B" }]],
	]);
	mocks.rateLimit.mockResolvedValue({
		allowed: true,
		remaining: 4,
		resetInSeconds: 60,
	});
});

describe("testChatGptPlanPoolAccountProcedure", () => {
	it.each([
		{
			outcome: "ok",
			model: "gpt-6-luna",
			modelName: "GPT-6 Luna",
			latencyMs: 900,
		},
		{
			outcome: "needs_reconnect",
			message: "Your ChatGPT connection needs to be reconnected.",
		},
		{ outcome: "spent", resetAt: new Date("2026-10-09T18:50:00Z") },
		{ outcome: "error", message: "This account cannot use plan access" },
	])(
		"returns the $outcome outcome in the declared shape",
		async (outcome) => {
			mocks.probe.mockResolvedValue(outcome);
			const result = await runTest("acc_a");
			expect(result).toEqual(outcome);
			expect(chatGptPlanTestResultSchema.parse(result)).toEqual(outcome);
		},
	);

	it("tests that account of the session's organization, as the admin", async () => {
		mocks.probe.mockResolvedValue({ outcome: "spent", resetAt: null });
		await runTest("acc_a");
		expect(mocks.probe).toHaveBeenCalledWith({
			userId: "user_1",
			organizationId: "org_a",
			source: {
				kind: "org",
				organizationId: "org_a",
				accountId: "acc_a",
			},
		});
		expect(mocks.rateLimit).toHaveBeenCalledWith(
			"chatgpt-plan-test:user_1",
			5,
			60_000,
		);
	});

	it("answers NOT_FOUND for another organization's account", async () => {
		const error = await rejection(runTest("acc_b"));
		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("refuses a member who is neither admin nor owner", async () => {
		mocks.role = "member";
		const error = await rejection(runTest("acc_a"));
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("lets an owner test", async () => {
		mocks.role = "owner";
		mocks.probe.mockResolvedValue({ outcome: "spent", resetAt: null });
		await expect(runTest("acc_a")).resolves.toEqual({
			outcome: "spent",
			resetAt: null,
		});
	});

	it("refuses while acting as another user", async () => {
		const error = await rejection(
			runTest("acc_a", { impersonatedBy: "admin_2" }),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when CHATGPT_PLAN is off for the organization", async () => {
		mocks.flags.CHATGPT_PLAN = false;
		const error = await rejection(runTest("acc_a"));
		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("refuses past the per-person rate limit without a request", async () => {
		mocks.rateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 30,
		});
		const error = await rejection(runTest("acc_a"));
		expect(error.code).toBe("TOO_MANY_REQUESTS");
		expect(mocks.probe).not.toHaveBeenCalled();
	});
});
