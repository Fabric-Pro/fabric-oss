/**
 * Integration test for the `chat-agent-selection.get` oRPC procedure.
 *
 * Mocks at the boundary (per `fabric/standards/testing/test-writing.md`):
 *   - `@repo/database` queries (`getChatAgentSelection`, `deleteChatAgentSelection`)
 *   - the validator (`validatePersistedAgents`)
 *   - the orpc procedure builder (so the test can call the handler directly
 *     without spinning up the oRPC runtime)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getChatAgentSelection: vi.fn(),
	deleteChatAgentSelection: vi.fn(),
	validatePersistedAgents: vi.fn(),
	getOrganizationIdFromContext: vi.fn(),
	captured: {
		handler: null as
			| ((args: { context: any; input: any }) => Promise<any>)
			| null,
	},
}));

vi.mock("@repo/database", async () => {
	const real =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...real,
		getChatAgentSelection: mocks.getChatAgentSelection,
		deleteChatAgentSelection: mocks.deleteChatAgentSelection,
	};
});

// The default-agent resolver asks the AI-config layer what providers the
// tenant can reach, which is a different contract from the one under test
// here. Stubbed to null so these cases stay about read / validate / cleanup.
vi.mock("../default-agent", () => ({
	resolveDefaultChatAgent: vi.fn(async () => null),
}));

vi.mock("../validator", () => ({
	validatePersistedAgents: mocks.validatePersistedAgents,
}));

vi.mock("../../../../../orpc/middleware/tenant-context-middleware", () => ({
	getOrganizationIdFromContext: mocks.getOrganizationIdFromContext,
}));

// Stub the procedure builder so we can extract the raw handler.
vi.mock("../../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: any) => {
			mocks.captured.handler = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
	};
});

import "../get";

const callHandler = (args: { context: any; input: any }) =>
	mocks.captured.handler!(args);

const USER_ID = "user_a";
const ORG_ID = "org_x";

beforeEach(() => {
	mocks.getChatAgentSelection.mockReset();
	mocks.deleteChatAgentSelection.mockReset();
	mocks.validatePersistedAgents.mockReset();
	mocks.getOrganizationIdFromContext.mockReset();
});

function makeContext(organizationId: string | null) {
	mocks.getOrganizationIdFromContext.mockReturnValue(organizationId);
	return {
		user: { id: USER_ID },
		tenantContext: { type: organizationId ? "organization" : "personal" },
	};
}

describe("getChatAgentSelectionProcedure", () => {
	it("returns the empty first-run shape when no row exists", async () => {
		mocks.getChatAgentSelection.mockResolvedValue(null);
		const result = await callHandler({
			context: makeContext(null),
			input: undefined,
		});

		expect(result).toEqual({
			exists: false,
			version: 1,
			selectedAgents: [],
			droppedCount: 0,
			defaultAgent: null,
		});
		expect(mocks.validatePersistedAgents).not.toHaveBeenCalled();
		expect(mocks.deleteChatAgentSelection).not.toHaveBeenCalled();
	});

	it("returns kept entries with droppedCount reflecting drops", async () => {
		mocks.getChatAgentSelection.mockResolvedValue({
			version: 1,
			selectedAgents: [
				{ agentId: "agent_a", name: "A" },
				{ agentId: "agent_dropped", name: "D" },
			],
		});
		mocks.validatePersistedAgents.mockResolvedValue({
			kept: [{ agentId: "agent_a", name: "A" }],
			droppedCount: 1,
			defaultAgent: null,
		});

		const result = await callHandler({
			context: makeContext(null),
			input: undefined,
		});

		expect(result).toEqual({
			exists: true,
			version: 1,
			selectedAgents: [{ agentId: "agent_a", name: "A" }],
			droppedCount: 1,
			defaultAgent: null,
		});
		expect(mocks.deleteChatAgentSelection).not.toHaveBeenCalled();
	});

	it("when validator empties the array, returns first-run shape AND clears the row", async () => {
		mocks.getChatAgentSelection.mockResolvedValue({
			version: 1,
			selectedAgents: [{ agentId: "agent_a", name: "A" }],
		});
		mocks.validatePersistedAgents.mockResolvedValue({
			kept: [],
			droppedCount: 1,
			defaultAgent: null,
		});

		const result = await callHandler({
			context: makeContext(null),
			input: undefined,
		});

		expect(result).toEqual({
			exists: false,
			version: 1,
			selectedAgents: [],
			droppedCount: 1,
			defaultAgent: null,
		});
		expect(mocks.deleteChatAgentSelection).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
			null,
		);
	});

	it("passes the organization id through to query + validator + delete", async () => {
		mocks.getChatAgentSelection.mockResolvedValue({
			version: 1,
			selectedAgents: [{ agentId: "agent_a", name: "A" }],
		});
		mocks.validatePersistedAgents.mockResolvedValue({
			kept: [],
			droppedCount: 1,
			defaultAgent: null,
		});

		await callHandler({
			context: makeContext(ORG_ID),
			input: undefined,
		});

		expect(mocks.getChatAgentSelection).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
			ORG_ID,
		);
		expect(mocks.validatePersistedAgents).toHaveBeenCalledExactlyOnceWith({
			entries: [{ agentId: "agent_a", name: "A" }],
			userId: USER_ID,
			organizationId: ORG_ID,
		});
		expect(mocks.deleteChatAgentSelection).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
			ORG_ID,
		);
	});
});
