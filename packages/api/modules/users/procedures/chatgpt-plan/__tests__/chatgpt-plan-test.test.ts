/**
 * Testing the member's own ChatGPT plan (Fizzy #2770): the session's user and
 * organization only, only with CHATGPT_PLAN on there, never while acting as
 * someone else, rate-limited per person, and every outcome of the one real
 * request reaches the card in the declared shape.
 */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flags: { CHATGPT_PLAN: true } as Record<string, boolean>,
	credential: { status: "ACTIVE" } as { status: string } | null,
	probe: vi.fn(),
	rateLimit: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async (flag: string, organizationId: string) =>
		organizationId === "org-a" && mocks.flags[flag] === true,
	getChatGptPlanCredentialStatus: async () => mocks.credential,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-check", () => ({
	testChatGptPlanSource: mocks.probe,
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: mocks.rateLimit,
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
		Permissions: { USER_UPDATE_SELF: "USER_UPDATE_SELF" },
		requirePermission: () => ({}),
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import { chatGptPlanTestResultSchema } from "../../../../../lib/chatgpt-plan-test";
import { testChatGptPlanProcedure } from "../test-plan";

type Handler = (args: {
	context: unknown;
	input?: unknown;
}) => Promise<unknown>;
const runTest = (
	overrides: { impersonatedBy?: string; organizationId?: string | null } = {},
) =>
	(testChatGptPlanProcedure as unknown as { _handler: Handler })._handler({
		context: {
			user: { id: "user-1" },
			session: {
				activeOrganizationId:
					overrides.organizationId === undefined
						? "org-a"
						: overrides.organizationId,
				impersonatedBy: overrides.impersonatedBy ?? null,
			},
		},
		input: {},
	});

const rejection = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flags = { CHATGPT_PLAN: true };
	mocks.credential = { status: "ACTIVE" };
	mocks.rateLimit.mockResolvedValue({
		allowed: true,
		remaining: 4,
		resetInSeconds: 60,
	});
});

describe("testChatGptPlanProcedure", () => {
	it.each([
		{
			outcome: "ok",
			model: "gpt-6-luna",
			modelName: "GPT-6 Luna",
			latencyMs: 1200,
		},
		{
			outcome: "needs_reconnect",
			message: "Your ChatGPT connection needs to be reconnected.",
		},
		{ outcome: "spent", resetAt: new Date("2026-10-09T18:50:00Z") },
		{ outcome: "spent", resetAt: null },
		{
			outcome: "error",
			message: "The ChatGPT plan did not answer in time.",
		},
	])(
		"returns the $outcome outcome in the declared shape",
		async (outcome) => {
			mocks.probe.mockResolvedValue(outcome);
			const result = await runTest();
			expect(result).toEqual(outcome);
			expect(chatGptPlanTestResultSchema.parse(result)).toEqual(outcome);
		},
	);

	it("tests the caller's own plan in the session's organization", async () => {
		mocks.probe.mockResolvedValue({ outcome: "spent", resetAt: null });
		await runTest();
		expect(mocks.probe).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
			source: { kind: "user", userId: "user-1" },
		});
		expect(mocks.rateLimit).toHaveBeenCalledWith(
			"chatgpt-plan-test:user-1",
			5,
			60_000,
		);
	});

	it("answers NOT_FOUND when CHATGPT_PLAN is off for the organization", async () => {
		mocks.flags.CHATGPT_PLAN = false;
		expect((await rejection(runTest())).code).toBe("NOT_FOUND");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND without an active organization", async () => {
		expect((await rejection(runTest({ organizationId: null }))).code).toBe(
			"NOT_FOUND",
		);
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when no plan is connected", async () => {
		mocks.credential = null;
		expect((await rejection(runTest())).code).toBe("NOT_FOUND");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("refuses while an admin acts as the member", async () => {
		mocks.probe.mockResolvedValue({ outcome: "spent", resetAt: null });
		const error = await rejection(runTest({ impersonatedBy: "admin-1" }));
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.probe).not.toHaveBeenCalled();
	});

	it("refuses past the per-person rate limit without a request", async () => {
		mocks.rateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 42,
		});
		const error = await rejection(runTest());
		expect(error.code).toBe("TOO_MANY_REQUESTS");
		expect(error.message).toContain("42 seconds");
		expect(mocks.probe).not.toHaveBeenCalled();
	});
});
