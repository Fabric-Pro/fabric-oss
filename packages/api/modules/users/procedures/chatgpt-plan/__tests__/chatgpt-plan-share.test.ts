/**
 * Sharing an own ChatGPT plan with the session's organization, and taking a
 * shared one back (Fizzy #2770 I1): the session's user and organization
 * only, never while impersonating, sharing only where pooling is on and its
 * terms accepted, and taking back only by the member who connected it.
 */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	flags: { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true } as Record<
		string,
		boolean
	>,
	terms: new Date("2026-10-01T00:00:00Z") as Date | null,
	role: "member" as string | null,
	accounts: vi.fn(),
	share: vi.fn(),
	takeBack: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: async (flag: string) => mocks.flags[flag] === true,
	getChatGptPlanOrgPolicy: async () => ({
		termsAcknowledgedAt: mocks.terms,
	}),
	listChatGptPlanOrgAccounts: mocks.accounts,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-move", async () => {
	class ChatGptPlanMoveError extends Error {
		constructor(readonly reason: string) {
			super(reason);
		}
	}
	return {
		ChatGptPlanMoveError,
		shareOwnChatGptPlan: mocks.share,
		takeBackSharedChatGptPlan: mocks.takeBack,
	};
});

vi.mock("../../../../organizations/lib/membership", () => ({
	requireOrgMembership: async (
		_userId: string,
		organizationId: string,
		roles: string[],
	) =>
		mocks.role && roles.includes(mocks.role)
			? { role: mocks.role, organization: { id: organizationId } }
			: null,
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
		Permissions: { USER_UPDATE_SELF: "USER_UPDATE_SELF" },
		requirePermission: () => ({}),
		tenantProtectedProcedure: make(),
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import { ChatGptPlanMoveError } from "@repo/ai/lib/chatgpt-plan/plan-move";
import {
	chatGptPlanShareState,
	shareChatGptPlanProcedure,
	takeBackChatGptPlanProcedure,
} from "../share";

type Handler = (args: {
	context: unknown;
	input?: unknown;
}) => Promise<unknown>;
const handler = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;

const context = (
	overrides: { impersonatedBy?: string; organizationId?: string | null } = {},
) => ({
	user: { id: "user-1", name: "Example Member" },
	session: {
		activeOrganizationId:
			overrides.organizationId === undefined
				? "org-a"
				: overrides.organizationId,
		impersonatedBy: overrides.impersonatedBy ?? null,
	},
});

const rejection = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(ORPCError);
	return error as ORPCError<string, unknown>;
};

const ACCOUNT = {
	id: "acc-1",
	label: "Example Member's ChatGPT plan",
	email: "plan@example.com",
	status: "ACTIVE",
	tier: "PLUS",
	enabled: true,
	connectedByUserId: "user-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flags = { CHATGPT_PLAN: true, CHATGPT_PLAN_POOLING: true };
	mocks.terms = new Date("2026-10-01T00:00:00Z");
	mocks.role = "member";
	mocks.accounts.mockResolvedValue([]);
	mocks.share.mockResolvedValue({ accountId: "acc-new" });
	mocks.takeBack.mockResolvedValue(undefined);
});

describe("share", () => {
	it("shares the member's own plan with the session's organization, labelled with their name, and audits it", async () => {
		await expect(
			handler(shareChatGptPlanProcedure)({ context: context() }),
		).resolves.toEqual({ accountId: "acc-new" });
		expect(mocks.share).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
			label: "Example Member's ChatGPT plan",
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.account_shared_from_personal",
				organizationId: "org-a",
				resource: expect.objectContaining({ id: "acc-new" }),
			}),
		);
	});

	it.each([
		["a flag is off", () => (mocks.flags.CHATGPT_PLAN_POOLING = false)],
		["the terms are not accepted", () => (mocks.terms = null)],
	])("refuses when %s", async (_case, arrange) => {
		arrange();
		const error = await rejection(
			handler(shareChatGptPlanProcedure)({ context: context() }),
		);
		expect(error.code).toBe("PRECONDITION_FAILED");
		expect(mocks.share).not.toHaveBeenCalled();
	});

	it("refuses while impersonating, before anything else", async () => {
		const error = await rejection(
			handler(shareChatGptPlanProcedure)({
				context: context({ impersonatedBy: "admin-1" }),
			}),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.share).not.toHaveBeenCalled();
	});

	it("refuses outside an organization the user belongs to", async () => {
		mocks.role = null;
		const error = await rejection(
			handler(shareChatGptPlanProcedure)({ context: context() }),
		);
		expect(error.code).toBe("NOT_FOUND");
		expect(mocks.share).not.toHaveBeenCalled();
	});

	it("says an account already shared must be taken back first", async () => {
		mocks.share.mockRejectedValue(
			new ChatGptPlanMoveError("already_shared"),
		);
		const error = await rejection(
			handler(shareChatGptPlanProcedure)({ context: context() }),
		);
		expect(error.code).toBe("CONFLICT");
		expect(error.message).toMatch(/take it back/);
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});

describe("take back", () => {
	it("takes the account back in the session's organization and audits it", async () => {
		mocks.accounts.mockResolvedValue([ACCOUNT]);
		await expect(
			handler(takeBackChatGptPlanProcedure)({
				context: context(),
				input: { accountId: "acc-1" },
			}),
		).resolves.toEqual({ ok: true });
		expect(mocks.takeBack).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-a",
			accountId: "acc-1",
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "org.chatgpt_plan.account_returned_to_personal",
				organizationId: "org-a",
			}),
		);
	});

	// Pooling may since have been switched off: the account is still theirs.
	it("works without the pooling flag", async () => {
		mocks.flags.CHATGPT_PLAN_POOLING = false;
		await handler(takeBackChatGptPlanProcedure)({
			context: context(),
			input: { accountId: "acc-1" },
		});
		expect(mocks.takeBack).toHaveBeenCalled();
	});

	it.each([["admin"], ["owner"], ["member"]])(
		"refuses a %s who did not connect it",
		async (role) => {
			mocks.role = role;
			mocks.takeBack.mockRejectedValue(
				new ChatGptPlanMoveError("not_connector"),
			);
			const error = await rejection(
				handler(takeBackChatGptPlanProcedure)({
					context: context(),
					input: { accountId: "acc-1" },
				}),
			);
			expect(error.code).toBe("FORBIDDEN");
			expect(error.message).toMatch(/Only the member who connected/);
		},
	);

	it("says to disconnect an existing own plan first", async () => {
		mocks.takeBack.mockRejectedValue(
			new ChatGptPlanMoveError("personal_exists"),
		);
		const error = await rejection(
			handler(takeBackChatGptPlanProcedure)({
				context: context(),
				input: { accountId: "acc-1" },
			}),
		);
		expect(error.code).toBe("CONFLICT");
		expect(error.message).toMatch(
			/already have a ChatGPT plan of your own/,
		);
	});

	it("refuses while impersonating", async () => {
		const error = await rejection(
			handler(takeBackChatGptPlanProcedure)({
				context: context({ impersonatedBy: "admin-1" }),
				input: { accountId: "acc-1" },
			}),
		);
		expect(error.code).toBe("FORBIDDEN");
		expect(mocks.takeBack).not.toHaveBeenCalled();
	});
});

describe("chatGptPlanShareState", () => {
	it("offers sharing an own plan and lists only the accounts this member connected here", async () => {
		mocks.accounts.mockResolvedValue([
			ACCOUNT,
			{ ...ACCOUNT, id: "acc-2", connectedByUserId: "user-2" },
		]);
		const state = await chatGptPlanShareState({
			userId: "user-1",
			organizationId: "org-a",
			hasOwnPlan: true,
			impersonated: false,
		});
		expect(state.canShare).toBe(true);
		expect(state.sharedHere).toEqual([
			{
				accountId: "acc-1",
				label: ACCOUNT.label,
				maskedEmail: expect.not.stringContaining("plan@"),
				status: "ACTIVE",
				tier: "PLUS",
				enabled: true,
			},
		]);
	});

	it.each([
		["without an own plan", { hasOwnPlan: false }],
		["while impersonating", { impersonated: true }],
	])("offers no sharing %s", async (_case, overrides) => {
		const state = await chatGptPlanShareState({
			userId: "user-1",
			organizationId: "org-a",
			hasOwnPlan: true,
			impersonated: false,
			...overrides,
		});
		expect(state.canShare).toBe(false);
	});
});
