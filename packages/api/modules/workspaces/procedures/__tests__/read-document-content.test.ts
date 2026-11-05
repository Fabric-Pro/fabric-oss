import { WorkspaceDocumentContentError } from "@repo/database/src/workspace-document-content";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	permission: vi.fn(),
	resolve: vi.fn(),
	inputSchema: undefined as unknown,
}));
vi.mock(
	"@repo/database/prisma/queries/workspaces/document-content",
	async () => ({
		...(await import("@repo/database/src/workspace-document-content")),
		readWorkspaceDocumentContent: m.read,
	}),
);
vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: (schema: unknown) => {
			m.inputSchema = schema;
			return chain;
		},
		output: () => chain,
		handler: (handler: unknown) => ({ _handler: handler }),
	});
	return {
		Permissions: { WORKSPACE_READ: "workspaces:read" },
		requireInputOrgPermission: m.permission,
		resolveOrganizationId: m.resolve,
		tenantProtectedProcedure: chain,
	};
});

import { readDocumentContentProcedure } from "../read-document-content";

const context = {
	resHeaders: new Headers(),
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
};
const input = {
	workspaceId: "example-workspace",
	documentId: "example-document",
	offset: 0,
	limit: 2,
};
const handler = (
	readDocumentContentProcedure as unknown as {
		_handler: (args: {
			input: Record<string, unknown>;
			context: typeof context;
		}) => Promise<unknown>;
	}
)._handler;
beforeEach(() => {
	m.read.mockReset();
	m.resolve.mockReturnValue("example-org");
});
describe("oRPC bounded document read", () => {
	it("uses the organization permission middleware and delegates with the server's actor", async () => {
		expect(m.permission).toHaveBeenCalledWith("workspaces:read", {
			requireOrganization: true,
		});
		m.read.mockResolvedValue({ text: "A😀", revision: "a".repeat(64) });
		await expect(
			handler({
				input: { ...input, organizationId: "named-org" },
				context,
			}),
		).resolves.toMatchObject({ text: "A😀" });
		expect(m.resolve).toHaveBeenCalledWith("named-org", context.session);
		expect(context.resHeaders.get("Cache-Control")).toBe(
			"private, no-store",
		);
		expect(m.read).toHaveBeenCalledWith(
			{ userId: "example-user", organizationId: "example-org" },
			input,
		);
	});
	it.each([
		["NOT_FOUND", "NOT_FOUND"],
		["FORBIDDEN", "FORBIDDEN"],
		["STALE_REVISION", "CONFLICT"],
		["NOT_READY", "CONFLICT"],
		["REVISION_REQUIRED", "BAD_REQUEST"],
	] as const)("preserves the shared %s refusal", async (reason, code) => {
		m.read.mockRejectedValue(new WorkspaceDocumentContentError(reason));
		await expect(handler({ input, context })).rejects.toMatchObject({
			code,
			data: { reason },
		});
	});
	it("bounds pages and rejects unknown actor overrides at the input boundary", () => {
		const schema = m.inputSchema as z.ZodType;
		expect(schema.safeParse({ ...input, limit: 20001 }).success).toBe(
			false,
		);
		expect(
			schema.safeParse({ ...input, userId: "other-user" }).success,
		).toBe(false);
	});
	it("sanitizes unexpected adapter failures", async () => {
		m.read.mockRejectedValue(new Error("private-example-password"));
		await expect(handler({ input, context })).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Workspace document content could not be read.",
		});
	});
});
