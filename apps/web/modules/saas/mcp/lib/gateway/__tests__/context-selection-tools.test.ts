import { ContextAssemblyError } from "@repo/rag/lib/context-continuity/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createContextSelectionTools } from "../tools/context-selection-tools";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({ assemble: vi.fn() }));
vi.mock("@repo/rag/lib/context-continuity", () => ({
	assembleSelectedContext: m.assemble,
}));
const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example User",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["projects:read"],
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60000),
};
const project = { sourceKind: "project_context", sourceId: "example-source" };
const workspace = {
	sourceKind: "workspace_document",
	workspaceId: "example-workspace",
	documentId: "example-document",
	required: false,
};
const authorize = vi.fn();
const family = createContextSelectionTools(authorize);
const handler = family.handlers.get("fabric_assemble_project_context")!;
beforeEach(() => {
	vi.clearAllMocks();
	authorize.mockResolvedValue({ organizationId: "example-org" });
	m.assemble.mockResolvedValue({
		version: 1,
		contentRole: "reference_data",
		sources: [],
		omissions: [],
	});
});
describe("selected context MCP", () => {
	it("forwards trusted actor and exact references to shared core, without actor input override", async () => {
		const result = await handler(
			{ projectId: "example-project", selections: [project] },
			session,
		);
		expect(result.isError).not.toBe(true);
		expect(m.assemble).toHaveBeenCalledWith(
			{
				userId: "example-user",
				organizationId: "example-org",
				projectId: "example-project",
			},
			{ selections: [{ ...project, required: true }] },
		);
		await handler(
			{
				projectId: "example-project",
				userId: "example-other",
				selections: [project],
			},
			session,
		);
		expect(m.assemble).toHaveBeenCalledTimes(1);
	});
	it.each([[[]], [["mcp:read"]], [["mcp:write"]], [["projects:read"]]])(
		"requires explicit Workspace ceiling even for optional sources with %j",
		async (scopes) => {
			expect(
				(
					await handler(
						{
							projectId: "example-project",
							selections: [workspace],
						},
						{ ...session, scopes },
					)
				).isError,
			).toBe(true);
			expect(m.assemble).not.toHaveBeenCalled();
			expect(authorize).not.toHaveBeenCalled();
		},
	);
	it("allows explicit org Workspace read with current shared-reader checks", async () => {
		expect(
			(
				await handler(
					{ projectId: "example-project", selections: [workspace] },
					{
						...session,
						scopes: ["projects:read", "workspaces:read"],
					},
				)
			).isError,
		).not.toBe(true);
		expect(m.assemble).toHaveBeenCalledOnce();
	});
	it.each([
		{ projectId: "example-project" },
		{ pinnedProjectId: "example-project" },
		{ credential: "service" as const },
	])(
		"refuses mixed exports outside a bounded connection %j",
		async (bound) => {
			expect(
				(
					await handler(
						{
							projectId: "example-project",
							selections: [workspace],
						},
						{ ...session, ...bound, scopes: ["*"] },
					)
				).isError,
			).toBe(true);
			expect(m.assemble).not.toHaveBeenCalled();
		},
	);
	it("does not cross a project binding even with wildcard", async () => {
		expect(
			(
				await handler(
					{ projectId: "example-other", selections: [project] },
					{ ...session, projectId: "example-project", scopes: ["*"] },
				)
			).isError,
		).toBe(true);
		expect(authorize).not.toHaveBeenCalled();
	});
	it.each([[project, project], [{ ...workspace, offset: 5 }]])(
		"preserves duplicate and continuation refinements",
		async (selections) => {
			expect(
				(
					await handler(
						{ projectId: "example-project", selections },
						session,
					)
				).isError,
			).toBe(true);
			expect(m.assemble).not.toHaveBeenCalled();
		},
	);
	it("refuses denied current actor without disclosing context", async () => {
		authorize.mockResolvedValue(null);
		expect(
			(
				await handler(
					{ projectId: "example-project", selections: [project] },
					session,
				)
			).isError,
		).toBe(true);
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it("returns typed stale refusals, redacts unknown provider errors", async () => {
		m.assemble.mockRejectedValueOnce(
			new ContextAssemblyError("STALE_REVISION"),
		);
		const stale = await handler(
			{ projectId: "example-project", selections: [project] },
			session,
		);
		expect(JSON.stringify(stale)).toContain("STALE_REVISION");
		m.assemble.mockRejectedValueOnce(
			new Error("example-private-provider-error"),
		);
		const unknown = await handler(
			{ projectId: "example-project", selections: [project] },
			session,
		);
		expect(unknown.isError).toBe(true);
		expect(JSON.stringify(unknown)).not.toContain(
			"example-private-provider-error",
		);
	});
	it("registers a read-only family with scope; inspection requires no confirmation", () => {
		expect(family.scopes.fabric_assemble_project_context).toEqual({
			scope: "projects:read",
			kind: "read",
		});
		expect(family.definitions[0].annotations).toMatchObject({
			readOnlyHint: true,
			idempotentHint: true,
		});
		expect(family.definitions[0]._meta).toBeUndefined();
	});
});
