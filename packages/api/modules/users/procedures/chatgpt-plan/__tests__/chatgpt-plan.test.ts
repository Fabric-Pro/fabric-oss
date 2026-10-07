/**
 * The signed-in person's ChatGPT plan procedures (Fizzy #2939): a choice
 * lands only on the session's own organization, and only where the person is
 * a member with the flag on; status never carries a token.
 */
import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	status: vi.fn(),
	organizations: vi.fn(),
	setUse: vi.fn(),
	usage: vi.fn(),
	disconnect: vi.fn(),
	audit: vi.fn(),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.audit,
}));

vi.mock("@repo/database", () => ({
	getChatGptPlanCredentialStatus: mocks.status,
	listChatGptPlanOrganizations: mocks.organizations,
	setChatGptPlanOrgUse: mocks.setUse,
	getChatGptPlanUsageSince: mocks.usage,
}));

vi.mock("@repo/ai/lib/chatgpt-plan/plan-credentials", () => ({
	disconnectChatGptPlan: mocks.disconnect,
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
		Permissions: {
			USER_READ_SELF: "USER_READ_SELF",
			USER_UPDATE_SELF: "USER_UPDATE_SELF",
		},
		requirePermission: () => ({}),
		tenantProtectedProcedure: make(),
		resolveOrganizationId: (
			_input: unknown,
			session: { activeOrganizationId?: string | null },
		) => session.activeOrganizationId ?? undefined,
	};
});

import {
	disconnectChatGptPlanProcedure,
	getChatGptPlanStatusProcedure,
	setChatGptPlanOrganizationUseProcedure,
} from "../index";

type Handler = (args: {
	context: unknown;
	input?: unknown;
}) => Promise<unknown>;
const handler = (procedure: unknown) =>
	(procedure as { _handler: Handler })._handler;

const context = (activeOrganizationId: string | null = "org-1") => ({
	user: { id: "user-1" },
	session: { activeOrganizationId },
});

const ORG = {
	id: "org-1",
	slug: "example-org",
	name: "Example Org",
	enabled: false,
	answered: false,
	includeBackgroundJobs: false,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("users.chatgptPlan.setOrganizationUse", () => {
	it("records the choice for the session's organization", async () => {
		mocks.organizations.mockResolvedValue([ORG]);
		await expect(
			handler(setChatGptPlanOrganizationUseProcedure)({
				context: context(),
				input: { enabled: true },
			}),
		).resolves.toEqual({ enabled: true, includeBackgroundJobs: false });
		expect(mocks.organizations).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.setUse).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
			enabled: true,
			includeBackgroundJobs: undefined,
		});
	});

	it("audits the choice in the organization with both settings and nothing else", async () => {
		mocks.organizations.mockResolvedValue([ORG]);
		await handler(setChatGptPlanOrganizationUseProcedure)({
			context: context(),
			input: { enabled: true, includeBackgroundJobs: true },
		});
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "account.chatgpt_plan.organization_use_changed",
				organizationId: "org-1",
				metadata: { enabled: true, includeBackgroundJobs: true },
			}),
		);
	});

	it("records an explicit choice to include background jobs and agents", async () => {
		mocks.organizations.mockResolvedValue([{ ...ORG, enabled: true }]);
		await expect(
			handler(setChatGptPlanOrganizationUseProcedure)({
				context: context(),
				input: { enabled: true, includeBackgroundJobs: true },
			}),
		).resolves.toEqual({ enabled: true, includeBackgroundJobs: true });
		expect(mocks.setUse).toHaveBeenCalledWith(
			expect.objectContaining({ includeBackgroundJobs: true }),
		);
	});

	it("reports background jobs off once the plan is turned off here", async () => {
		mocks.organizations.mockResolvedValue([
			{ ...ORG, enabled: true, includeBackgroundJobs: true },
		]);
		await expect(
			handler(setChatGptPlanOrganizationUseProcedure)({
				context: context(),
				input: { enabled: false },
			}),
		).resolves.toEqual({ enabled: false, includeBackgroundJobs: false });
	});

	it("refuses an organization where the flag is off or the person is not a member", async () => {
		mocks.organizations.mockResolvedValue([]);
		await expect(
			handler(setChatGptPlanOrganizationUseProcedure)({
				context: context("org-elsewhere"),
				input: { enabled: true },
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.setUse).not.toHaveBeenCalled();
	});

	it("refuses when the session has no organization", async () => {
		await expect(
			handler(setChatGptPlanOrganizationUseProcedure)({
				context: context(null),
				input: { enabled: true },
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.organizations).not.toHaveBeenCalled();
	});
});

describe("users.chatgptPlan.status", () => {
	it("reports the connection and this organization's choice, without tokens", async () => {
		mocks.status.mockResolvedValue({
			email: "dev@example.com",
			status: "ACTIVE",
		});
		mocks.organizations.mockResolvedValue([
			ORG,
			{ ...ORG, id: "org-2", slug: "example-two", enabled: true },
		]);
		mocks.usage.mockResolvedValue({
			requests: 4,
			inputTokens: 75_000,
			outputTokens: 2_000,
		});
		const result = (await handler(getChatGptPlanStatusProcedure)({
			context: context(),
		})) as Record<string, unknown>;
		expect(result).toMatchObject({
			connected: true,
			email: "dev@example.com",
			status: "ACTIVE",
			currentOrganization: { slug: "example-org", answered: false },
			usageEstimate: { requests: 4, estimatedPercent: 10 },
		});
		expect(result.organizations).toHaveLength(2);
	});

	it("reports no connection and no estimate for a person who never connected", async () => {
		mocks.status.mockResolvedValue(null);
		mocks.organizations.mockResolvedValue([]);
		const result = await handler(getChatGptPlanStatusProcedure)({
			context: context(),
		});
		expect(result).toMatchObject({
			connected: false,
			currentOrganization: null,
			usageEstimate: null,
		});
		expect(mocks.usage).not.toHaveBeenCalled();
	});
});

describe("users.chatgptPlan.disconnect", () => {
	it("disconnects the session's own user", async () => {
		mocks.disconnect.mockResolvedValue(true);
		await expect(
			handler(disconnectChatGptPlanProcedure)({ context: context() }),
		).resolves.toEqual({ disconnected: true });
		expect(mocks.disconnect).toHaveBeenCalledWith("user-1");
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "account.chatgpt_plan.disconnected",
			}),
		);
	});

	it("audits nothing when there was no connection to remove", async () => {
		mocks.disconnect.mockResolvedValue(false);
		await handler(disconnectChatGptPlanProcedure)({ context: context() });
		expect(mocks.audit).not.toHaveBeenCalled();
	});
});
