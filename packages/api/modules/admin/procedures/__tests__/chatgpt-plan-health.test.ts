/**
 * admin.chatgptPlanHealth.list (Fizzy #2770 D6): every organization's shared
 * ChatGPT plan account, with its window, reset, last refusal and calibrated
 * budget; addresses masked, no tokens; behind the deployment-admin gate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	accounts: vi.fn(),
	windows: vi.fn(),
	budgets: vi.fn(),
	states: vi.fn(),
	observed: vi.fn(),
	backfill: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listChatGptPlanOrgAccountsForAdmin: mocks.accounts,
		getChatGptPlanOrgAccountWindows: mocks.windows,
		getChatGptPlanWindowBudgets: mocks.budgets,
		getChatGptPlanSourceStates: mocks.states,
		getChatGptPlanLastObservations: mocks.observed,
	};
});

vi.mock("@repo/ai/lib/chatgpt-plan/subscription-backfill", () => ({
	backfillChatGptPlanSubscriptions: mocks.backfill,
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { listChatGptPlanHealthProcedure } from "../chatgpt-plan-health";

const HOUR = 60 * 60_000;

const row = (id: string, organizationId: string, name: string) => ({
	id,
	organizationId,
	organization: { name },
	label: `Plan ${id}`,
	email: `${id}@example.com`,
	status: "ACTIVE",
	enabled: true,
	tier: "PLUS",
	serveInteractive: false,
	serveBackground: true,
	maxMemberSharePct: null,
	connectedByUserId: "user_1",
	lastUsedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.backfill.mockImplementation(async (rows: unknown[]) => rows);
});

describe("admin.chatgptPlanHealth.list", () => {
	it("lists each organization's accounts with window, reset, last refusal and budget", async () => {
		const resetsAt = new Date(Date.now() + 2 * HOUR);
		const coolingUntil = new Date(Date.now() + HOUR);
		const refusedAt = new Date(Date.now() - 3 * HOUR);
		mocks.accounts.mockResolvedValue([
			row("acc_1", "org_a", "Example A"),
			row("acc_2", "org_b", "Example B"),
		]);
		mocks.windows.mockImplementation(
			async (params: { organizationId: string; accountIds: string[] }) =>
				new Map(
					params.accountIds.map((id) => [
						id,
						{ inputTokens: id === "acc_1" ? 600_000 : 0, resetsAt },
					]),
				),
		);
		mocks.budgets.mockResolvedValue(
			new Map([
				["acc_1", 1_200_000],
				["acc_2", 2_000_000],
			]),
		);
		mocks.states.mockResolvedValue([
			{
				sourceId: "acc_2",
				openUntil: coolingUntil,
				resetAt: coolingUntil,
				lastExhaustedAt: new Date(Date.now() - 10 * 60_000),
			},
		]);
		mocks.observed.mockResolvedValue(new Map([["acc_1", refusedAt]]));

		const result = (await listChatGptPlanHealthProcedure["~orpc"].handler({
			input: undefined,
			context: {},
			errors: {},
		} as never)) as { accounts: Array<Record<string, unknown>> };

		expect(mocks.windows).toHaveBeenCalledTimes(2);
		expect(mocks.windows).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org_a",
				accountIds: ["acc_1"],
			}),
		);
		expect(result.accounts).toEqual([
			expect.objectContaining({
				id: "acc_1",
				organizationName: "Example A",
				maskedEmail: "ac***@example.com",
				windowPercent: 50,
				resetsAt,
				coolingUntil: null,
				lastExhaustedAt: refusedAt,
				budget: 1_200_000,
				budgetCalibrated: true,
			}),
			expect.objectContaining({
				id: "acc_2",
				organizationName: "Example B",
				windowPercent: 0,
				resetsAt: coolingUntil,
				coolingUntil,
				budget: 2_000_000,
				budgetCalibrated: false,
			}),
		]);
		expect(JSON.stringify(result)).not.toContain("encrypted");
	});

	it("fills each account's tier from its stored ID token within that account's own organization", async () => {
		mocks.accounts.mockResolvedValue([
			{ ...row("acc_1", "org_a", "Example A"), tier: "UNKNOWN" },
			{ ...row("acc_2", "org_b", "Example B"), tier: "UNKNOWN" },
		]);
		mocks.windows.mockResolvedValue(new Map());
		mocks.budgets.mockResolvedValue(new Map());
		mocks.states.mockResolvedValue([]);
		mocks.observed.mockResolvedValue(new Map());
		mocks.backfill.mockImplementation(
			async (
				rows: Array<Record<string, unknown>>,
				refOf: (row: unknown) => unknown,
			) => {
				expect(rows.map(refOf)).toEqual([
					{
						kind: "org",
						organizationId: "org_a",
						accountId: "acc_1",
					},
					{
						kind: "org",
						organizationId: "org_b",
						accountId: "acc_2",
					},
				]);
				return rows.map((account) => ({ ...account, tier: "TEAM" }));
			},
		);

		const result = (await listChatGptPlanHealthProcedure["~orpc"].handler({
			input: undefined,
			context: {},
			errors: {},
		} as never)) as { accounts: Array<{ tier: string }> };
		expect(result.accounts.map((account) => account.tier)).toEqual([
			"TEAM",
			"TEAM",
		]);
	});

	it("is a deployment-admin procedure", () => {
		const source = readFileSync(
			join(__dirname, "..", "chatgpt-plan-health.ts"),
			"utf8",
		);
		expect(source).toMatch(/=\s*adminProcedure\b/);
	});
});
