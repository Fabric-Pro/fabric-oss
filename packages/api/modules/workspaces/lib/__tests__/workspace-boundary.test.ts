import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	document: vi.fn(),
	conversation: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getWorkspaceAccessContext: mocks.access,
	db: {
		workspaceDocument: { findUnique: mocks.document },
		agentConversation: { findFirst: mocks.conversation },
	},
}));
vi.mock("../../../../orpc/procedures", () => ({
	resolveOrganizationId: (
		_input: unknown,
		session: { activeOrganizationId?: string },
	) => session.activeOrganizationId,
}));

import { assertWorkspaceBoundary } from "../workspace-boundary";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({ organizationId: "org-a" });
});
describe("document API tenant boundaries", () => {
	it("rejects missing or unrecognized resource identifiers", async () => {
		for (const input of [{}, { id: "other-resource" }, null])
			await expect(
				assertWorkspaceBoundary(input, "user-1", "org-a"),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("accepts the caller's accessible workspace in the authorized organization", async () => {
		await expect(
			assertWorkspaceBoundary({ workspaceId: "ws-a" }, "user-1", "org-a"),
		).resolves.toBeUndefined();
		expect(mocks.access).toHaveBeenCalledWith("ws-a", "user-1");
	});
	it("refuses a workspace in another organization even when the user belongs to both", async () => {
		mocks.access.mockResolvedValue({ organizationId: "org-b" });
		await expect(
			assertWorkspaceBoundary({ workspaceId: "ws-b" }, "user-1", "org-a"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("refuses absent access and null-tenant workspaces", async () => {
		for (const access of [null, { organizationId: null }]) {
			mocks.access.mockResolvedValue(access);
			await expect(
				assertWorkspaceBoundary(
					{ workspaceId: "ws" },
					"user-1",
					"org-a",
				),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		}
	});
	it("resolves document-only requests to their hosting workspace", async () => {
		mocks.document.mockResolvedValue({ workspaceId: "ws-b" });
		mocks.access.mockResolvedValue({ organizationId: "org-b" });
		await expect(
			assertWorkspaceBoundary({ documentId: "doc-b" }, "user-1", "org-a"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.document).toHaveBeenCalledWith({
			where: { id: "doc-b" },
			select: { workspaceId: true },
		});
	});
	it("refuses unknown documents without disclosing another workspace", async () => {
		mocks.document.mockResolvedValue(null);
		await expect(
			assertWorkspaceBoundary(
				{ documentId: "missing" },
				"user-1",
				"org-a",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.access).not.toHaveBeenCalled();
	});
	it("checks conversations against both the actor and organization", async () => {
		mocks.conversation.mockResolvedValue(null);
		await expect(
			assertWorkspaceBoundary(
				{ conversationId: "conversation-b" },
				"user-1",
				"org-a",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.conversation).toHaveBeenCalledWith({
			where: {
				id: "conversation-b",
				userId: "user-1",
				organizationId: "org-a",
			},
			select: { id: true },
		});
	});
	it("requires a resolved organization before performing lookups", async () => {
		await expect(
			assertWorkspaceBoundary(
				{ workspaceId: "ws-a" },
				"user-1",
				undefined,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.access).not.toHaveBeenCalled();
	});
});
