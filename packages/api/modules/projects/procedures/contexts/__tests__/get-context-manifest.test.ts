import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextManifestError } from "../../../lib/context-manifest-reader";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	permission: vi.fn(),
	bound: vi.fn(),
}));
vi.mock("../../../lib/context-manifest-reader", async (original) => ({
	...(await original<Record<string, unknown>>()),
	readContextManifest: m.read,
}));
vi.mock("../../../../../lib/authorized-project-binding", () => ({
	resolveBoundOrganization: m.bound,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: (handler: unknown) => ({ _handler: handler }),
	});
	return {
		Permissions: { CONTEXT_READ: "context:read" },
		requireProjectPermission: m.permission,
		tenantProtectedProcedure: chain,
	};
});

import { getContextManifestProcedure } from "../get-context-manifest";

const context = { user: { id: "example-user" }, resHeaders: new Headers() };
const input = {
	projectId: "example-project",
	organizationId: "client-claimed-org",
	limit: 20,
	offset: 0,
	includeCodeContexts: false,
};
const handler = (
	getContextManifestProcedure as unknown as {
		_handler: (args: {
			input: typeof input;
			context: typeof context;
		}) => Promise<unknown>;
	}
)._handler;
beforeEach(() => {
	m.read.mockReset();
	m.bound.mockReturnValue({ bound: true, organizationId: "server-host-org" });
});
describe("oRPC project context manifest", () => {
	it("consumes the middleware's verified host rather than the named tenant", async () => {
		expect(m.permission).toHaveBeenCalledWith("context:read");
		m.read.mockResolvedValue({ version: 1 });
		await expect(handler({ input, context })).resolves.toMatchObject({
			version: 1,
		});
		expect(m.read).toHaveBeenCalledWith(
			{
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: "server-host-org",
			},
			{ limit: 20, offset: 0, includeCodeContexts: false },
		);
		expect(context.resHeaders.get("Cache-Control")).toBe(
			"private, no-store",
		);
	});
	it("requires a verified organization binding", async () => {
		m.bound.mockReturnValue({ bound: false });
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(m.read).not.toHaveBeenCalled();
	});
	it.each([
		["INVALID_INPUT", "BAD_REQUEST"],
		["NOT_FOUND", "NOT_FOUND"],
		["FORBIDDEN", "FORBIDDEN"],
	] as const)("preserves %s denial", async (reason, code) => {
		m.read.mockRejectedValue(new ContextManifestError(reason));
		await expect(handler({ input, context })).rejects.toMatchObject({
			code,
		});
	});
});
