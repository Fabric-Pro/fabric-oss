import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	byAgentId: vi.fn(),
	byId: vi.fn(),
	membership: vi.fn(),
	resolveOrganizationId: vi.fn(),
	captured: null as
		| null
		| ((args: {
				input: { id: string };
				context: { user: { id: string }; session: object };
		  }) => Promise<unknown>),
}));
vi.mock("@repo/database", () => ({
	getRegisteredAgentByAgentId: mocks.byAgentId,
	getRegisteredAgentById: mocks.byId,
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: any = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: typeof mocks.captured) => {
			mocks.captured = fn;
			return {};
		},
	};
	return {
		protectedProcedure: chain,
		Permissions: { AGENT_READ: "read" },
		requireInputOrgPermission: vi.fn(),
		resolveOrganizationId: mocks.resolveOrganizationId,
	};
});
import "../get-registered-agent";

const invoke = (id = "example-agent") => {
	const handler = mocks.captured;
	if (!handler) {
		throw new Error("getRegisteredAgent handler was not captured");
	}
	return handler({
		input: { id },
		context: { user: { id: "example-user" }, session: {} },
	});
};
const own = {
	scope: "USER",
	userId: "example-user",
	organizationId: "example-org",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.resolveOrganizationId.mockReturnValue("example-org");
	mocks.membership.mockResolvedValue({ role: "member" });
});
describe("getRegisteredAgent compatibility", () => {
	it.each([
		[
			{ ...own, scope: "ORGANIZATION", organizationId: null },
			true,
			"Invalid organization agent configuration",
		],
		[
			{ ...own, scope: "ORGANIZATION" },
			false,
			"You do not have access to this agent",
		],
		[
			{ ...own, scope: "ORGANIZATION", organizationId: "other-org" },
			true,
			"Agent does not belong to the specified organization",
		],
		[
			{ ...own, userId: "other-user" },
			true,
			"You do not have access to this agent",
		],
		[
			{ ...own, organizationId: null },
			true,
			"Personal agent not accessible in organization context",
		],
		[{ ...own, scope: "UNKNOWN" }, true, "Invalid agent scope"],
	])("preserves FORBIDDEN message %s", async (agent, member, message) => {
		mocks.byAgentId.mockResolvedValue(agent);
		mocks.membership.mockResolvedValue(member ? { role: "member" } : null);
		await expect(invoke()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message,
		});
	});
	it("preserves NOT_FOUND after exhausting lookup fallbacks", async () => {
		mocks.byAgentId.mockResolvedValue(null);
		mocks.byId.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Agent not found",
		});
		expect(mocks.byAgentId.mock.calls).toEqual([
			["example-agent"],
			["example_agent"],
		]);
		expect(mocks.byId).toHaveBeenCalledExactlyOnceWith("example-agent");
	});
	it.each(["SYSTEM", "ORGANIZATION", "USER"])(
		"returns the loaded %s row unchanged",
		async (scope) => {
			const agent = { ...own, scope };
			mocks.byAgentId.mockResolvedValue(agent);
			await expect(invoke()).resolves.toBe(agent);
			expect(mocks.byId).not.toHaveBeenCalled();
		},
	);
	it("preserves normalized slug lookup", async () => {
		const agent = { ...own, scope: "SYSTEM" };
		mocks.byAgentId
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(agent);
		await expect(invoke()).resolves.toBe(agent);
		expect(mocks.byAgentId).toHaveBeenNthCalledWith(2, "example_agent");
	});
	it("preserves database id fallback", async () => {
		mocks.byAgentId.mockResolvedValue(null);
		mocks.byId.mockResolvedValue(own);
		await expect(invoke("example_id")).resolves.toBe(own);
		expect(mocks.byAgentId).toHaveBeenCalledTimes(1);
		expect(mocks.byId).toHaveBeenCalledExactlyOnceWith("example_id");
	});
});
