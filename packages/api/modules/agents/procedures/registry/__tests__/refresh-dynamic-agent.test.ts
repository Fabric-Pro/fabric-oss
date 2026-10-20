import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: { agentId: string };
	context: { user: { id: string }; session: object };
}) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
	findUnique: vi.fn(),
	transaction: vi.fn(),
	txUpdate: vi.fn(),
	mergeMetadata: vi.fn(),
	fetchAgentEndpoint: vi.fn(),
	membership: vi.fn(),
	resolveOrganizationId: vi.fn(),
	handlers: new Map<string, Handler>(),
	middlewareOptions: new Map<string, unknown>(),
}));
vi.mock("@repo/database", () => ({
	db: {
		registeredAgent: { findUnique: mocks.findUnique },
		$transaction: mocks.transaction,
	},
	mergeRegisteredAgentMetadata: mocks.mergeMetadata,
}));
vi.mock("@repo/agent-core", () => ({
	extractAgentMetadata: vi.fn(),
	validateA2AEndpoint: vi.fn(),
}));
vi.mock("../../../lib/agent-endpoint-guard", () => ({
	assertAgentEndpointAllowed: vi.fn(),
	fetchAgentEndpoint: mocks.fetchAgentEndpoint,
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.membership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const makeChain = () => {
		let path = "";
		let options: unknown;
		const chain: any = {
			use: (mw: { options?: unknown }) => {
				options = mw?.options;
				return chain;
			},
			route: (route: { path: string }) => {
				path = route.path;
				mocks.middlewareOptions.set(path, options);
				return chain;
			},
			input: () => chain,
			output: () => chain,
			handler: (fn: Handler) => {
				mocks.handlers.set(path, fn);
				return {};
			},
		};
		return chain;
	};
	return {
		get protectedProcedure() {
			return makeChain();
		},
		Permissions: { AGENT_CREATE: "create" },
		requireInputOrgPermission: (
			_permission: string,
			options?: unknown,
		) => ({
			options,
		}),
		resolveOrganizationId: mocks.resolveOrganizationId,
	};
});
import "../register-dynamic-agent";

const invoke = () => {
	const handler = mocks.handlers.get("/agents/registry/dynamic/refresh");
	if (!handler) {
		throw new Error("refreshDynamicAgent handler was not captured");
	}
	return handler({
		input: { agentId: "example-agent" },
		context: { user: { id: "example-user" }, session: {} },
	});
};
const row = {
	id: "row-1",
	agentId: "example-agent",
	scope: "USER",
	userId: "example-user",
	organizationId: "example-org",
	framework: "CUSTOM",
	deploymentUrl: "https://agent.example.com",
	config: {},
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.resolveOrganizationId.mockReturnValue("example-org");
	mocks.membership.mockResolvedValue({ role: "member" });
	mocks.fetchAgentEndpoint.mockResolvedValue({ ok: true });
	mocks.transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
		fn({ registeredAgent: { update: mocks.txUpdate } }),
	);
	mocks.txUpdate.mockResolvedValue({
		...row,
		name: "Example",
		displayName: "Example",
		description: null,
		status: "ACTIVE",
		metadata: null,
		createdAt: new Date(),
		lastHealthCheck: new Date(),
	});
});

describe("refreshDynamicAgent authorization", () => {
	it("requires an organization context in its permission middleware", () => {
		expect(
			mocks.middlewareOptions.get("/agents/registry/dynamic/refresh"),
		).toEqual({ requireOrganization: true });
	});

	it.each([
		[
			"another member's personal agent in the caller's organization",
			{ ...row, userId: "other-user" },
			"You do not have access to this agent",
		],
		[
			"a SYSTEM agent",
			{ ...row, scope: "SYSTEM", userId: null, organizationId: null },
			"System agents cannot be modified",
		],
		[
			"an organization agent for a non-admin member",
			{ ...row, scope: "ORGANIZATION", userId: null },
			"Organization agents can only be modified by administrators",
		],
	])("rejects %s before probing or writing", async (_name, agent, reason) => {
		mocks.findUnique.mockResolvedValue(agent);
		await expect(invoke()).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: reason,
		});
		expect(mocks.fetchAgentEndpoint).not.toHaveBeenCalled();
		expect(mocks.transaction).not.toHaveBeenCalled();
		expect(mocks.txUpdate).not.toHaveBeenCalled();
	});

	it("refreshes the caller's own agent", async () => {
		mocks.findUnique.mockResolvedValue(row);
		await expect(invoke()).resolves.toMatchObject({
			agentId: "example-agent",
			healthStatus: "healthy",
		});
		expect(mocks.findUnique).toHaveBeenCalledWith({
			where: { agentId: "example-agent" },
		});
		expect(mocks.mergeMetadata).toHaveBeenCalledOnce();
		expect(mocks.txUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "row-1" },
				data: expect.objectContaining({ status: "ACTIVE" }),
			}),
		);
	});

	it("returns NOT_FOUND for an unknown agent", async () => {
		mocks.findUnique.mockResolvedValue(null);
		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
