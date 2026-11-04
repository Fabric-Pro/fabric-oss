import { WorkspaceLinkError } from "@repo/api/modules/projects/lib/workspace-document-links/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceDocumentLinkTools } from "../tools/workspace-document-link-tools";
import type { GatewaySession } from "../types";

const commands = vi.hoisted(() => ({
	list: vi.fn(),
	read: vi.fn(),
	add: vi.fn(),
	remove: vi.fn(),
}));
vi.mock("@repo/api/modules/projects/lib/workspace-document-links", () => ({
	workspaceDocumentLinkCommands: async () => commands,
}));
const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["projects:read", "projects:write", "workspaces:read"],
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60000),
};
const authorize = vi.fn(async () => ({ organizationId: "example-org" }));
const tools = createWorkspaceDocumentLinkTools(authorize);
const actor = {
	userId: session.userId,
	organizationId: "example-org",
	projectId: "example-project",
};
const payload = (
	r: Awaited<
		ReturnType<NonNullable<ReturnType<typeof tools.readHandlers.get>>>
	>,
) => JSON.parse(r.content[0].text);
beforeEach(() => {
	vi.clearAllMocks();
	authorize.mockResolvedValue({ organizationId: "example-org" });
});
describe("linked Workspace MCP boundaries", () => {
	it.each(["mcp:read", "mcp:write", "projects:read"])(
		"requires explicit Workspace scope beyond %s",
		async (scope) => {
			const result = await tools.readHandlers.get(
				"fabric_list_project_workspace_documents",
			)?.(
				{ projectId: actor.projectId },
				{ ...session, scopes: [scope] },
			);
			expect(payload(result).code).toBe("INSUFFICIENT_SCOPE");
			expect(authorize).not.toHaveBeenCalled();
			expect(commands.list).not.toHaveBeenCalled();
		},
	);
	it("limits a project connection to its project before source discovery", async () => {
		const result = await tools.readHandlers.get(
			"fabric_list_project_workspace_documents",
		)?.(
			{ projectId: "example-other-project" },
			{ ...session, projectId: actor.projectId },
		);
		expect(result.isError).toBe(true);
		expect(authorize).not.toHaveBeenCalled();
	});
	it("uses the bound server actor and bounded current read rather than caller ownership", async () => {
		commands.read.mockResolvedValue({
			text: "🧵",
			contentRole: "reference_data",
		});
		const result = await tools.readHandlers.get(
			"fabric_read_project_workspace_document",
		)?.(
			{
				projectId: actor.projectId,
				linkId: "example-link",
				offset: 1,
				limit: 10,
				expectedRevision: "a".repeat(64),
			},
			session,
		);
		expect(result.isError).not.toBe(true);
		expect(commands.read).toHaveBeenCalledWith(actor, {
			linkId: "example-link",
			offset: 1,
			limit: 10,
			expectedRevision: "a".repeat(64),
		});
	});
	it("does not let wildcard scope bypass current object permission", async () => {
		commands.read.mockRejectedValueOnce(
			new WorkspaceLinkError("FORBIDDEN"),
		);
		const result = await tools.readHandlers.get(
			"fabric_read_project_workspace_document",
		)?.(
			{ projectId: actor.projectId, linkId: "example-link" },
			{ ...session, scopes: ["*"] },
		);
		expect(result.isError).toBe(true);
		expect(payload(result).code).toBe("FORBIDDEN");
	});
	it("rejects user-supplied authority and unknown payload fields", async () => {
		const result = await tools.readHandlers.get(
			"fabric_read_project_workspace_document",
		)?.(
			{
				projectId: actor.projectId,
				linkId: "example-link",
				userId: "example-other-user",
			},
			session,
		);
		expect(payload(result).code).toBe("INVALID_INPUT");
		expect(authorize).not.toHaveBeenCalled();
	});
	it("allows editors to unlink an unavailable reference without source scope", async () => {
		commands.remove.mockResolvedValue({ removed: true });
		const result = await tools.writes.handlers.get(
			"fabric_unlink_workspace_document",
		)?.(
			{ projectId: actor.projectId, linkId: "example-link" },
			{ ...session, scopes: ["projects:write"] },
		);
		expect(payload(result)).toEqual({ removed: true });
		expect(commands.remove).toHaveBeenCalledWith(
			actor,
			{ linkId: "example-link" },
			"api_key",
		);
	});
	it("keeps runtime services from changing document links", async () => {
		const result = await tools.writes.handlers.get(
			"fabric_unlink_workspace_document",
		)?.(
			{ projectId: actor.projectId, linkId: "example-link" },
			{ ...session, credential: "service", scopes: ["*"] },
		);
		expect(payload(result).code).toBe("FORBIDDEN");
		expect(commands.remove).not.toHaveBeenCalled();
	});
	it("redacts unexpected failures rather than exposing source/provider details", async () => {
		commands.list.mockRejectedValueOnce(
			new Error("example private storage detail"),
		);
		const result = await tools.readHandlers.get(
			"fabric_list_project_workspace_documents",
		)?.({ projectId: actor.projectId }, session);
		expect(payload(result).code).toBe("UNAVAILABLE");
		expect(JSON.stringify(result)).not.toContain("private storage");
	});
});
