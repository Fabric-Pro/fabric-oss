import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ findUnique: vi.fn(), membership: vi.fn() }));
vi.mock("@repo/database", () => ({
	db: { agentTemplateInstance: { findUnique: h.findUnique } },
	getInstanceVersion: vi.fn(),
	getActiveInstanceVersion: vi.fn(),
	getInstanceVersionHistory: vi.fn(),
}));
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: h.membership,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		input: () => chain,
		handler: (handler: unknown) => ({ _handler: handler }),
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: { AGENT_TEMPLATE_READ: "AGENT_TEMPLATE_READ" },
		requirePermission: () => vi.fn(),
	};
});

import { getInstanceProcedure } from "../get";

const handler = (
	getInstanceProcedure as unknown as {
		_handler: (args: {
			input: { id: string };
			context: { user: { id: string } };
		}) => Promise<{ instance: Record<string, unknown> }>;
	}
)._handler;
const configuredBindings = [
	{ mcpConfigId: "example-enabled-mcp", isEnabled: true },
	{ mcpConfigId: "example-disabled-mcp", isEnabled: false },
];
let bindings = configuredBindings;
beforeEach(() => {
	bindings = configuredBindings;
	h.membership.mockReset().mockResolvedValue({ id: "example-membership" });

	h.findUnique.mockReset();
	h.findUnique.mockImplementation(
		async (query: {
			include: {
				mcpServerConfigurations?: { where?: { isEnabled?: boolean } };
				_count?: { select: { mcpServerConfigurations: boolean } };
			};
		}) => {
			const requestedBindings = query.include.mcpServerConfigurations;
			const selectedBindings = bindings
				.filter(
					(binding) =>
						!requestedBindings?.where?.isEnabled ||
						binding.isEnabled,
				)
				.map(({ mcpConfigId }) => ({ mcpConfigId }));
			return {
				id: "example-agent",
				userId: "example-owner",
				organizationId: "example-org",
				...(query.include._count
					? { _count: { mcpServerConfigurations: bindings.length } }
					: {}),
				...(requestedBindings
					? { mcpServerConfigurations: selectedBindings }
					: {}),
			};
		},
	);
});
describe("instance getter MCP rehydration", () => {
	it("retains the declaration when every relation binding is disabled", async () => {
		bindings = [configuredBindings[1]];
		const result = await handler({
			input: { id: "example-agent" },
			context: { user: { id: "example-member" } },
		});
		expect(result.instance.mcpServerConfigurations).toEqual([]);
		expect(result.instance._count).toEqual({ mcpServerConfigurations: 1 });
	});
	it("returns only enabled relation bindings for an authorized instance read", async () => {
		const result = await handler({
			input: { id: "example-agent" },
			context: { user: { id: "example-member" } },
		});
		expect(result.instance._count).toEqual({ mcpServerConfigurations: 2 });
		expect(result.instance.mcpServerConfigurations).toEqual([
			{ mcpConfigId: "example-enabled-mcp" },
		]);
		expect(h.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				include: expect.objectContaining({
					mcpServerConfigurations: {
						where: { isEnabled: true },
						select: { mcpConfigId: true },
					},
				}),
			}),
		);
	});
	it("does not expose instance bindings to a non-owner without organization membership", async () => {
		h.membership.mockResolvedValue(null);
		await expect(
			handler({
				input: { id: "example-agent" },
				context: { user: { id: "example-outsider" } },
			}),
		).rejects.toThrow("You don't have access to this instance");
	});
});
