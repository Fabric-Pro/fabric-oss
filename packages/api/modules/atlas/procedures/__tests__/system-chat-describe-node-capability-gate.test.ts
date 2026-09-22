/**
 * The two Atlas AI doors the first pass left ungated (Fizzy #1930).
 *
 * Multi-repository chat and "Describe with AI" are AI over the codebase just
 * like the single-repository chat, so they sit behind the same capability —
 * otherwise the gate on that one door is a suggestion. The refusal must reach
 * the caller before Atlas is asked for anything.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: [] as Array<(...args: unknown[]) => unknown>,
	mocks: {
		assertCapabilityAvailable: vi.fn(),
		systemChat: vi.fn(),
		describeNodeOnDemand: vi.fn(),
	},
}));

vi.mock("../../../capabilities/assert", () => ({
	assertCapabilityAvailable: mocks.assertCapabilityAvailable,
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
}));

vi.mock("@repo/atlas", () => ({
	AtlasService: class {
		systemChat = mocks.systemChat;
		describeNodeOnDemand = mocks.describeNodeOnDemand;
	},
	systemChatInputSchema: {},
	describeNodeInputSchema: {},
}));

vi.mock("../../lib", () => ({
	assertAtlasEnabled: () => undefined,
	mapAtlasError: (error: unknown) => {
		throw error;
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.push(fn);
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => ({}),
		requireProjectPermission: () => ({}),
		resolveOrganizationId: () => "organization_example",
	};
});

const { systemChatProcedure } = await import("../system-chat");
const { describeNodeProcedure } = await import("../describe-node");

const handlerOf = (procedure: unknown) =>
	(procedure as { _handler: (args: unknown) => Promise<unknown> })._handler;

const call = (procedure: unknown) =>
	handlerOf(procedure)({
		input: { projectId: "project_example", organizationId: null },
		context: { user: { id: "user_example" }, session: {} },
	});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.assertCapabilityAvailable.mockRejectedValue(
		new ORPCError("PRECONDITION_FAILED", { message: "not ready" }),
	);
});

describe.each([
	["systemChat", systemChatProcedure, mocks.systemChat],
	["describeNode", describeNodeProcedure, mocks.describeNodeOnDemand],
])("%s — the capability door", (_name, procedure, serviceCall) => {
	it("asserts codebase Q&A for this project and viewer", async () => {
		await expect(call(procedure)).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
		});
		expect(mocks.assertCapabilityAvailable).toHaveBeenCalledWith({
			capabilityKey: "atlas.codebase-qa",
			projectId: "project_example",
			userId: "user_example",
			organizationId: "organization_example",
		});
	});

	it("refuses before Atlas is asked for anything", async () => {
		await expect(call(procedure)).rejects.toBeDefined();
		expect(serviceCall).not.toHaveBeenCalled();
	});
});
