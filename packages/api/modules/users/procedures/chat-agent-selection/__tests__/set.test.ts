/**
 * Integration test for the `chat-agent-selection.set` oRPC procedure.
 *
 * Mocks at the boundary: `@repo/database`'s `upsertChatAgentSelection`
 * + the orpc procedure builder. The Zod input validation is exercised
 * through the *real* `ApiPersistedSelectedAgentSchema` so the 50-entry
 * cap and shape-validation tests bite on actual schema behavior.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	upsertChatAgentSelection: vi.fn(),
	getOrganizationIdFromContext: vi.fn(),
	captured: {
		handler: null as
			| ((args: { context: any; input: any }) => Promise<any>)
			| null,
		input: null as any,
	},
}));

vi.mock("@repo/database", async () => {
	const real =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...real,
		upsertChatAgentSelection: mocks.upsertChatAgentSelection,
	};
});

vi.mock("../../../../../orpc/middleware/tenant-context-middleware", () => ({
	getOrganizationIdFromContext: mocks.getOrganizationIdFromContext,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: (schema: any) => {
			mocks.captured.input = schema;
			return chainable;
		},
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

import "../set";

const callHandler = (args: { context: any; input: any }) =>
	mocks.captured.handler!(args);
const inputSchema = () => mocks.captured.input;

const USER_ID = "user_a";
const ORG_ID = "org_x";

beforeEach(() => {
	mocks.upsertChatAgentSelection.mockReset();
	mocks.getOrganizationIdFromContext.mockReset();
	mocks.upsertChatAgentSelection.mockResolvedValue(undefined);
});

function makeContext(organizationId: string | null) {
	mocks.getOrganizationIdFromContext.mockReturnValue(organizationId);
	return {
		user: { id: USER_ID },
		tenantContext: { type: organizationId ? "organization" : "personal" },
	};
}

describe("setChatAgentSelectionProcedure", () => {
	it("returns success and writes through to upsertChatAgentSelection", async () => {
		const result = await callHandler({
			context: makeContext(null),
			input: {
				selectedAgents: [{ agentId: "agent_a", name: "A" }],
			},
		});

		expect(result).toEqual({ success: true });
		expect(mocks.upsertChatAgentSelection).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
			{ selectedAgents: [{ agentId: "agent_a", name: "A" }] },
			null,
		);
	});

	it("idempotency: two consecutive calls with identical arrays both succeed", async () => {
		const ctx = makeContext(null);
		const input = { selectedAgents: [{ agentId: "agent_a", name: "A" }] };

		await callHandler({ context: ctx, input });
		await callHandler({ context: ctx, input });

		expect(mocks.upsertChatAgentSelection).toHaveBeenCalledTimes(2);
		// The procedure does NOT short-circuit — it forwards every call.
		// Idempotency is enforced at the queries layer (covered separately).
	});

	it("forwards organizationId to the upsert in org context", async () => {
		await callHandler({
			context: makeContext(ORG_ID),
			input: { selectedAgents: [{ agentId: "agent_a", name: "A" }] },
		});

		expect(mocks.upsertChatAgentSelection).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
			{ selectedAgents: [{ agentId: "agent_a", name: "A" }] },
			ORG_ID,
		);
	});

	it("forwards null organizationId in personal context (XOR isolation)", async () => {
		await callHandler({
			context: makeContext(null),
			input: { selectedAgents: [{ agentId: "agent_a", name: "A" }] },
		});

		expect(mocks.upsertChatAgentSelection).toHaveBeenCalledExactlyOnceWith(
			USER_ID,
			{ selectedAgents: [{ agentId: "agent_a", name: "A" }] },
			null,
		);
	});

	it("rejects an array above 50 entries via the input Zod schema", async () => {
		const oversized = Array.from({ length: 51 }, (_, i) => ({
			agentId: `agent_${i}`,
			name: `A${i}`,
		}));

		// `capturedInput` is the Zod object captured from the procedure's
		// .input(...) call. Run it through .safeParse to mirror what oRPC
		// does at the boundary.
		const parsed = inputSchema().safeParse({ selectedAgents: oversized });
		expect(parsed.success).toBe(false);
	});

	it("accepts an empty array", async () => {
		const parsed = inputSchema().safeParse({ selectedAgents: [] });
		expect(parsed.success).toBe(true);

		const result = await callHandler({
			context: makeContext(null),
			input: { selectedAgents: [] },
		});
		expect(result).toEqual({ success: true });
	});

	it("rejects malformed entries (e.g. missing name) via the input Zod schema", async () => {
		const parsed = inputSchema().safeParse({
			selectedAgents: [{ agentId: "agent_a" }],
		});
		expect(parsed.success).toBe(false);
	});
});
