import { call } from "@orpc/server";
import { ContextAssemblyError } from "@repo/rag/lib/context-continuity/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	assemble: vi.fn(),
	bound: vi.fn(),
	permission: vi.fn(),
}));
vi.mock("@repo/rag/lib/context-continuity", async (original) => ({
	...(await original<Record<string, unknown>>()),
	assembleSelectedContext: m.assemble,
}));
vi.mock("../../../../../lib/authorized-project-binding", () => ({
	resolveBoundOrganization: m.bound,
}));
vi.mock("../../../../../orpc/procedures", async () => {
	const { os } = await import("@orpc/server");
	return {
		tenantProtectedProcedure: os,
		Permissions: { CONTEXT_READ: "context:read" },
		requireProjectPermission: (permission: unknown) => {
			m.permission(permission);
			return async ({ next }: { next: () => Promise<unknown> }) => next();
		},
	};
});

import { assembleContextProcedure } from "../assemble-context";

const context = { user: { id: "example-user" }, resHeaders: new Headers() };
const project = { projectId: "example-project", organizationId: "example-org" };
const ref = { sourceKind: "project_context", sourceId: "example-source" };
const invoke = (input: unknown = { ...project, selections: [ref] }) =>
	call(assembleContextProcedure, input as never, { context });
beforeEach(() => {
	m.assemble.mockReset();
	m.bound.mockReturnValue({ bound: true, organizationId: "example-org" });
	m.assemble.mockResolvedValue({
		version: 1,
		selectionHash: "a".repeat(64),
		sources: [],
	});
});
describe("Portal context assembly transport", () => {
	it("requires context permission and consumes verified host/actor rather than client actor fields", async () => {
		expect(m.permission).toHaveBeenCalledWith("context:read");
		await invoke();
		expect(m.bound).toHaveBeenCalledWith(project.organizationId);
		expect(m.assemble).toHaveBeenCalledWith(
			{ ...project, userId: context.user.id },
			{ selections: [{ ...ref, required: true }] },
		);
		expect(context.resHeaders.get("Cache-Control")).toBe(
			"private, no-store",
		);
	});
	it.each([
		{ selections: [] },
		{ selections: [ref, ref] },
		{ selections: [{ ...ref, expectedRevision: "invalid" }] },
		{
			selections: [
				{
					sourceKind: "workspace_document",
					workspaceId: "example-workspace",
					documentId: "example-document",
					offset: 1,
				},
			],
		},
		{ selections: [ref], userId: "another-user" },
	])("preserves shared strict/refinement validation: %j", async (patch) => {
		await expect(invoke({ ...project, ...patch })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it("requires an actual middleware organization binding", async () => {
		m.bound.mockReturnValue({ bound: false });
		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.assemble).not.toHaveBeenCalled();
	});
	it.each([
		["STALE_REVISION", "CONFLICT"],
		["NOT_FOUND", "NOT_FOUND"],
		["FORBIDDEN", "FORBIDDEN"],
		["TOO_LARGE", "PAYLOAD_TOO_LARGE"],
	] as const)(
		"maps known safe refusal %s without releasing a packet",
		async (reason, code) => {
			m.assemble.mockRejectedValue(new ContextAssemblyError(reason));
			await expect(invoke()).rejects.toMatchObject({
				code,
				data: { code: reason },
			});
		},
	);
	it("sanitizes unexpected source-storage errors", async () => {
		m.assemble.mockRejectedValue(
			new Error("private storage credential example-secret"),
		);
		await expect(invoke()).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message:
				"Selected context could not be read. Retry this selection when its sources are available.",
		});
	});
	it("bounds accepted serialized RPC input before reading sources", async () => {
		const selections = Array.from({ length: 12 }, (_, index) => ({
			sourceKind: "workspace_document",
			workspaceId: "\u0001".repeat(200),
			documentId: "\u0001".repeat(198) + String(index).padStart(2, "0"),
		}));
		await expect(invoke({ ...project, selections })).rejects.toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
		});
		expect(m.assemble).not.toHaveBeenCalled();
	});
});
