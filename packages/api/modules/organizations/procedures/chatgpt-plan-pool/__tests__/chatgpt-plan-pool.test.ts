/**
 * The organization's shared ChatGPT plan procedures (Fizzy #2770): they act
 * only on the session's organization, only for its admins and owners, only
 * with both flags on; only an owner accepts the terms, pooling stays off
 * until one has, and no token or full email address leaves the server.
 */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flags: { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true } as Record<
		string,
		boolean
	>,
	role: "admin" as string | null,
	membershipCalls: [] as unknown[],
	accounts: vi.fn(),
	policy: vi.fn(),
	usage: vi.fn(),
	states: vi.fn(),
	updateAccount: vi.fn(),
	updatePolicy: vi.fn(),
	acknowledge: vi.fn(),
	disconnect: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async (key: string) => mocks.flags[key] === true,
	listChatGptPlanOrgAccounts: mocks.accounts,
	getChatGptPlanOrgPolicy: mocks.policy,
	getChatGptPlanPoolUsageSince: mocks.usage,
	getChatGptPlanSourceStates: mocks.states,
	updateChatGptPlanOrgAccount: mocks.updateAccount,
	updateChatGptPlanOrgPolicy: mocks.updatePolicy,
	acknowledgeChatGptPlanOrgTerms: mocks.acknowledge,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	disconnectChatGptPlanOrgAccount: mocks.disconnect,
}));

vi.mock("../../../lib/membership", () => ({
	requireOrgMembership: async (
		userId: string,
		organizationId: string,
		allowedRoles: string[],
	) => {
		mocks.membershipCalls.push({ userId, organizationId, allowedRoles });
		return mocks.role && allowedRoles.includes(mocks.role)
			? { role: mocks.role, organization: { id: organizationId } }
			: null;
	},
}));

vi.mock("../../../../../orpc/procedures", () => {
	const make = () => {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: (...args: unknown[]) => unknown) => ({
				_handler: fn,
			}),
		});
		return chainable;
	};
	return {
		Permissions: { ORG_READ: "ORG_READ", ORG_UPDATE: "ORG_UPDATE" },
		requirePermission: () => ({}),
		tenantProtectedProcedure: make(),
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import {
	acknowledgeChatGptPlanPoolTermsProcedure,
	disconnectChatGptPlanPoolAccountProcedure,
	getChatGptPlanPoolProcedure,
	updateChatGptPlanPoolAccountProcedure,
	updateChatGptPlanPoolPolicyProcedure,
} from "../index";

type Handler = (args: {
	context: unknown;
	input?: unknown;
}) => Promise<unknown>;
const handler = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;

const context = (activeOrganizationId: string | null = "org_a") => ({
	user: { id: "user_1" },
	session: { activeOrganizationId },
});

const NOW = Date.now();

const ACCOUNT = {
	id: "acc_1",
	label: "Shared plan",
	email: "shared-plan@example.com",
	status: "ACTIVE",
	tier: "PLUS",
	enabled: true,
	serveInteractive: false,
	serveBackground: true,
	connectedByUserId: "user_1",
	lastUsedAt: null,
	createdAt: new Date(NOW - 86_400_000),
	updatedAt: new Date(NOW - 86_400_000),
};

const POLICY = {
	poolingEnabled: false,
	apiFallbackInteractive: "ASK",
	apiFallbackBackground: "NEVER",
	headroomPct: 40,
	termsAcknowledgedById: null,
	termsAcknowledgedAt: null,
};

const rejection = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flags = { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true };
	mocks.role = "admin";
	mocks.membershipCalls = [];
	mocks.accounts.mockResolvedValue([ACCOUNT]);
	mocks.policy.mockResolvedValue(POLICY);
	mocks.usage.mockResolvedValue(
		new Map([
			["acc_1", { requests: 4, inputTokens: 375_000, outputTokens: 10 }],
		]),
	);
	mocks.states.mockResolvedValue([]);
});

describe("access", () => {
	it.each([["CHATGPT_PLAN"], ["CHATGPT_PLAN_POOLING"]])(
		"answers NOT_FOUND when %s is off for the organization",
		async (flag) => {
			mocks.flags[flag] = false;
			const error = await rejection(
				handler(getChatGptPlanPoolProcedure)({ context: context() }),
			);
			expect(error.code).toBe("NOT_FOUND");
			expect(mocks.accounts).not.toHaveBeenCalled();
		},
	);

	it("answers NOT_FOUND without an active organization", async () => {
		const error = await rejection(
			handler(getChatGptPlanPoolProcedure)({ context: context(null) }),
		);
		expect(error.code).toBe("NOT_FOUND");
	});

	it("refuses a member who is neither admin nor owner", async () => {
		mocks.role = "member";
		const error = await rejection(
			handler(updateChatGptPlanPoolPolicyProcedure)({
				context: context(),
				input: { headroomPct: 10 },
			}),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.updatePolicy).not.toHaveBeenCalled();
	});

	it("checks membership in the session's organization, never one from the input", async () => {
		mocks.updateAccount.mockResolvedValue(null);
		await rejection(
			handler(updateChatGptPlanPoolAccountProcedure)({
				context: context("org_a"),
				input: {
					accountId: "acc_1",
					organizationId: "org_b",
					enabled: false,
				},
			}),
		);
		expect(mocks.membershipCalls).toEqual([
			{
				userId: "user_1",
				organizationId: "org_a",
				allowedRoles: ["admin", "owner"],
			},
		]);
		expect(mocks.updateAccount).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_a" }),
		);
	});
});

describe("getChatGptPlanPool", () => {
	it("shows a masked email, the estimate and the cooling time, never a token", async () => {
		const coolingUntil = new Date(NOW + 30 * 60_000);
		mocks.states.mockResolvedValue([
			{ sourceKind: "ORG", sourceId: "acc_1", openUntil: coolingUntil },
		]);

		const result = (await handler(getChatGptPlanPoolProcedure)({
			context: context(),
		})) as {
			accounts: Array<Record<string, unknown>>;
			viewer: { isOwner: boolean };
		};
		const [account] = result.accounts;
		expect(account.maskedEmail).toBe("sh***@example.com");
		expect(account.coolingUntil).toEqual(coolingUntil);
		expect(account.usageEstimate).toMatchObject({ estimatedPercent: 50 });
		expect(JSON.stringify(result)).not.toMatch(
			/encrypted|accessToken|refreshToken|idToken|shared-plan@/,
		);
		expect(result.viewer.isOwner).toBe(false);
		expect(mocks.states).toHaveBeenCalledWith("ORG", ["acc_1"]);
	});

	it("does not offer the interactive fallback, which nothing changes", async () => {
		const result = (await handler(getChatGptPlanPoolProcedure)({
			context: context(),
		})) as { policy: Record<string, unknown> };
		expect(result.policy).not.toHaveProperty("apiFallbackInteractive");
	});

	it("drops a cooling time that has already passed", async () => {
		mocks.states.mockResolvedValue([
			{
				sourceKind: "ORG",
				sourceId: "acc_1",
				openUntil: new Date(NOW - 60_000),
			},
		]);
		const result = (await handler(getChatGptPlanPoolProcedure)({
			context: context(),
		})) as { accounts: Array<{ coolingUntil: Date | null }> };
		expect(result.accounts[0]?.coolingUntil).toBeNull();
	});
});

describe("accounts", () => {
	it("answers NOT_FOUND for an account that is not this organization's", async () => {
		mocks.updateAccount.mockResolvedValue(null);
		const error = await rejection(
			handler(updateChatGptPlanPoolAccountProcedure)({
				context: context(),
				input: { accountId: "acc_other", enabled: false },
			}),
		);
		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("audits only the fields that changed", async () => {
		mocks.updateAccount.mockResolvedValue({
			before: ACCOUNT,
			after: { ...ACCOUNT, serveInteractive: true },
		});
		await handler(updateChatGptPlanPoolAccountProcedure)({
			context: context(),
			input: {
				accountId: "acc_1",
				serveInteractive: true,
				enabled: true,
			},
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.account_updated",
				organizationId: "org_a",
				severity: "warning",
				metadata: {
					before: { serveInteractive: false },
					after: { serveInteractive: true },
				},
			}),
		);
	});

	it("does not disconnect another organization's account", async () => {
		const error = await rejection(
			handler(disconnectChatGptPlanPoolAccountProcedure)({
				context: context(),
				input: { accountId: "acc_other" },
			}),
		);
		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.disconnect).not.toHaveBeenCalled();
	});

	it("disconnects within the organization and audits it", async () => {
		mocks.disconnect.mockResolvedValue(true);
		await handler(disconnectChatGptPlanPoolAccountProcedure)({
			context: context(),
			input: { accountId: "acc_1" },
		});
		expect(mocks.disconnect).toHaveBeenCalledWith({
			organizationId: "org_a",
			accountId: "acc_1",
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.account_disconnected",
			}),
		);
	});
});

describe("policy and terms", () => {
	it("refuses pooling on before an owner accepted the terms", async () => {
		const error = await rejection(
			handler(updateChatGptPlanPoolPolicyProcedure)({
				context: context(),
				input: { poolingEnabled: true },
			}),
		);
		expect(error.code).toBe("PRECONDITION_FAILED");
		expect(mocks.updatePolicy).not.toHaveBeenCalled();
	});

	it("turns pooling on once the terms are accepted", async () => {
		const acknowledged = {
			...POLICY,
			termsAcknowledgedById: "owner_1",
			termsAcknowledgedAt: new Date(NOW - 60_000),
		};
		mocks.policy.mockResolvedValue(acknowledged);
		mocks.updatePolicy.mockResolvedValue({
			before: acknowledged,
			after: { ...acknowledged, poolingEnabled: true },
		});
		const result = (await handler(updateChatGptPlanPoolPolicyProcedure)({
			context: context(),
			input: { poolingEnabled: true },
		})) as { poolingEnabled: boolean };
		expect(result.poolingEnabled).toBe(true);
	});

	it("audits background fallback to the organization's provider as a warning", async () => {
		mocks.updatePolicy.mockResolvedValue({
			before: POLICY,
			after: { ...POLICY, apiFallbackBackground: "AUTO" },
		});
		await handler(updateChatGptPlanPoolPolicyProcedure)({
			context: context(),
			input: { apiFallbackBackground: "AUTO" },
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.policy_changed",
				severity: "warning",
				metadata: {
					before: { apiFallbackBackground: "NEVER" },
					after: { apiFallbackBackground: "AUTO" },
				},
			}),
		);
	});

	it("lets only an owner accept the terms", async () => {
		mocks.role = "admin";
		const error = await rejection(
			handler(acknowledgeChatGptPlanPoolTermsProcedure)({
				context: context(),
			}),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(error.message).toBe(
			"Only an organization owner can accept these terms.",
		);
		expect(mocks.acknowledge).not.toHaveBeenCalled();
	});

	it("records the owner's acceptance once", async () => {
		mocks.role = "owner";
		mocks.acknowledge.mockResolvedValue({
			...POLICY,
			termsAcknowledgedById: "user_1",
			termsAcknowledgedAt: new Date(NOW),
		});
		const result = (await handler(acknowledgeChatGptPlanPoolTermsProcedure)(
			{
				context: context(),
			},
		)) as { termsAcknowledged: boolean };
		expect(result.termsAcknowledged).toBe(true);
		expect(mocks.acknowledge).toHaveBeenCalledWith({
			organizationId: "org_a",
			userId: "user_1",
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.terms_acknowledged",
			}),
		);

		vi.clearAllMocks();
		mocks.policy.mockResolvedValue({
			...POLICY,
			termsAcknowledgedById: "user_1",
			termsAcknowledgedAt: new Date(NOW),
		});
		await handler(acknowledgeChatGptPlanPoolTermsProcedure)({
			context: context(),
		});
		expect(mocks.acknowledge).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("acting as another user", () => {
	const impersonated = () => ({
		user: { id: "user_1" },
		session: { activeOrganizationId: "org_a", impersonatedBy: "app_admin" },
	});

	it.each([
		[
			"acknowledgeTerms",
			acknowledgeChatGptPlanPoolTermsProcedure,
			undefined,
		],
		[
			"updatePolicy",
			updateChatGptPlanPoolPolicyProcedure,
			{ apiFallbackBackground: "AUTO" },
		],
		[
			"updateAccount",
			updateChatGptPlanPoolAccountProcedure,
			{ accountId: "acc_1", serveInteractive: true },
		],
		[
			"disconnectAccount",
			disconnectChatGptPlanPoolAccountProcedure,
			{ accountId: "acc_1" },
		],
	])("refuses %s with FORBIDDEN", async (_name, procedure, input) => {
		mocks.role = "owner";
		const error = await rejection(
			handler(procedure)({ context: impersonated(), input }),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.acknowledge).not.toHaveBeenCalled();
		expect(mocks.updatePolicy).not.toHaveBeenCalled();
		expect(mocks.disconnect).not.toHaveBeenCalled();
		expect(mocks.updateAccount).not.toHaveBeenCalled();
		expect(mocks.audit).not.toHaveBeenCalled();
	});

	it("still lets the pool be read", async () => {
		await expect(
			handler(getChatGptPlanPoolProcedure)({ context: impersonated() }),
		).resolves.toMatchObject({ accounts: [{ id: "acc_1" }] });
	});
});
