/**
 * ChatGPT plan usage per subscription (Fizzy #2972 FR4/AC5): the session's
 * organization only, owners and admins only, over the selected range; one
 * row per shared account (label, masked address) and per member's own plan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	usage: vi.fn(),
	accounts: vi.fn(),
	users: vi.fn(),
	flag: vi.fn(),
	requireAdmin: vi.fn(),
	estimate: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { user: { findMany: mocks.users } },
	getChatGptPlanUsageBySource: mocks.usage,
	listChatGptPlanOrgAccounts: mocks.accounts,
	isFeatureEnabled: mocks.flag,
}));

vi.mock("../../../../lib/chatgpt-plan-cost", () => ({
	estimateChatGptPlanApiCost: mocks.estimate,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requireOrganizationAdmin: mocks.requireAdmin,
		resolveOrganizationId: (
			organizationId: string | undefined,
			session: { activeOrganizationId?: string | null },
		) => organizationId ?? session.activeOrganizationId ?? undefined,
	};
});

import { getChatGptPlanUsage } from "../get-chatgpt-plan-usage";

const procedure = getChatGptPlanUsage as unknown as {
	_handler: (args: {
		input: Record<string, unknown>;
		context: {
			user: { id: string };
			session: { activeOrganizationId?: string | null };
		};
	}) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

const call = (
	input: Record<string, unknown> = {},
	activeOrganizationId: string | null = "org-a",
) =>
	procedure._handler({
		input,
		context: { user: { id: "admin-1" }, session: { activeOrganizationId } },
	});

const group = (overrides: Record<string, unknown>) => ({
	accountId: null,
	userId: null,
	providerModelId: "gpt-6.1-sol",
	requests: 1,
	inputTokens: 0,
	cachedInputTokens: 0,
	outputTokens: 0,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flag.mockResolvedValue(true);
	mocks.requireAdmin.mockResolvedValue(undefined);
	mocks.estimate.mockImplementation(
		async (usage: Array<{ outputTokens: number }>) => ({
			estimatedApiCostMicroUsd: usage.reduce(
				(total, item) => total + item.outputTokens,
				0,
			),
			referenceModels: [],
		}),
	);
	mocks.accounts.mockResolvedValue([
		{ id: "acc-1", label: "Design team", email: "plans@example.com" },
	]);
	mocks.users.mockResolvedValue([
		{ id: "user-1", name: "Avery Example", email: "avery@example.com" },
	]);
	mocks.usage.mockResolvedValue([
		group({
			accountId: "acc-1",
			userId: "user-2",
			requests: 4,
			inputTokens: 1000,
			cachedInputTokens: 250,
			outputTokens: 40,
		}),
		group({
			accountId: "acc-gone",
			userId: "user-1",
			requests: 1,
			inputTokens: 100,
			outputTokens: 5,
		}),
		group({
			userId: "user-1",
			requests: 2,
			inputTokens: 200,
			outputTokens: 10,
		}),
	]);
});

describe("payments.getChatGptPlanUsage", () => {
	it("reads the session's organization, never one named in the input", async () => {
		await call({ organizationId: "org-b" });
		expect(mocks.requireAdmin).toHaveBeenCalledWith("org-a", "admin-1");
		expect(mocks.usage).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-a" }),
		);
		expect(mocks.accounts).toHaveBeenCalledWith("org-a");
	});

	it("refuses a member who is not an owner or admin, and a session with no organization", async () => {
		mocks.requireAdmin.mockRejectedValueOnce(new Error("not an admin"));
		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(call({}, null)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.usage).not.toHaveBeenCalled();
	});

	it("reads the selected range", async () => {
		const from = new Date("2026-10-01T00:00:00Z");
		const to = new Date("2026-10-08T00:00:00Z");
		await call({ from, to });
		expect(mocks.usage).toHaveBeenCalledWith({
			organizationId: "org-a",
			from,
			to,
		});
		await call({ periodHours: 24 });
		const range = mocks.usage.mock.calls.at(-1)?.[0] as {
			from: Date;
			to: Date;
		};
		expect(range.to.getTime() - range.from.getTime()).toBe(24 * 3_600_000);
	});

	it("bounds the range: at most a year, reversed bounds swapped, `to` alone reaching back a year", async () => {
		const DAY = 86_400_000;
		const lastRange = () =>
			mocks.usage.mock.calls.at(-1)?.[0] as { from: Date; to: Date };

		const to = new Date("2026-10-08T00:00:00Z");
		await call({ from: new Date("2020-01-01T00:00:00Z"), to });
		expect(lastRange().to.getTime() - lastRange().from.getTime()).toBe(
			365 * DAY,
		);

		const early = new Date("2026-10-01T00:00:00Z");
		await call({ from: to, to: early });
		expect(lastRange()).toMatchObject({ from: early, to });

		await call({ to });
		expect(lastRange()).toMatchObject({
			from: new Date(to.getTime() - 365 * DAY),
			to,
		});

		await call({});
		expect(lastRange().to.getTime() - lastRange().from.getTime()).toBe(
			30 * DAY,
		);
	});

	it("gives a row per shared account and per member's own plan", async () => {
		const { rows } = await call();
		expect(rows).toEqual([
			expect.objectContaining({
				kind: "shared",
				label: "Design team",
				detail: "pl***@example.com",
				requests: 4,
				uncachedInputTokens: 750,
				cachedInputTokens: 250,
				outputTokens: 40,
				apiEquivalentCostMicroUsd: 40,
				sharePercent: 71.4,
			}),
			expect.objectContaining({
				kind: "shared",
				label: "Removed shared account",
				detail: null,
				uncachedInputTokens: 100,
			}),
			expect.objectContaining({
				kind: "member",
				label: "Avery Example",
				requests: 2,
				uncachedInputTokens: 200,
				sharePercent: 19,
			}),
		]);
	});

	it("is empty while ChatGPT plans are off for the organization", async () => {
		mocks.flag.mockResolvedValue(false);
		await expect(call()).resolves.toEqual({ rows: [] });
		expect(mocks.usage).not.toHaveBeenCalled();
	});
});
