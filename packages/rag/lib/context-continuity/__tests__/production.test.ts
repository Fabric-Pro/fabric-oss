import { createHash } from "node:crypto";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	hasAccess: vi.fn(),
	deleted: vi.fn(),
	project: vi.fn(),
	workspace: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: m.hasAccess,
	isProjectSoftDeleted: m.deleted,
}));
vi.mock("../../context-quality/project-access", () => ({
	resolveEffectiveProjectPermissions: m.access,
}));
vi.mock("@repo/database/prisma/queries/workspaces/document-content", () => ({
	readWorkspaceDocumentContent: m.workspace,
}));
vi.mock("../../context-quality/project-reader", async (original) => ({
	...(await original<
		typeof import("../../context-quality/project-reader")
	>()),
	readProjectContextSnapshot: m.project,
}));

import { assembleSelectedContext } from "../index";

const actor = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
};
const text = "Example document";
const revision = createHash("sha256").update(text).digest("hex");
const ref = {
	sourceKind: "workspace_document" as const,
	workspaceId: "example-workspace",
	documentId: "example-document",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue({
		organizationId: actor.organizationId,
		permissions: [Permissions.CONTEXT_READ],
	});
	m.hasAccess.mockResolvedValue(true);
	m.deleted.mockResolvedValue(false);
	m.workspace.mockImplementation(async () => ({
		id: ref.documentId,
		workspaceId: ref.workspaceId,
		organizationId: actor.organizationId,
		filename: "example.txt",
		text,
		revision,
		offset: 0,
		totalCharacters: text.length,
		totalBytes: Buffer.byteLength(text),
	}));
});
describe("production context assembly authority wiring", () => {
	it("uses current Project authority even for Workspace-only input and passes explicit Workspace actor scope", async () => {
		const packet = await assembleSelectedContext(actor, {
			selections: [ref],
		});
		expect(packet.sources[0]).toMatchObject({
			content: text,
			sourceRevision: revision,
		});
		expect(m.access).toHaveBeenCalledTimes(2);
		expect(m.hasAccess).toHaveBeenCalledWith(
			actor.projectId,
			actor.userId,
			actor.organizationId,
		);
		expect(m.workspace).toHaveBeenCalledWith(
			{ userId: actor.userId, organizationId: actor.organizationId },
			{
				workspaceId: ref.workspaceId,
				documentId: ref.documentId,
				offset: 0,
				limit: 16384,
				expectedRevision: undefined,
			},
		);
		expect(m.project).not.toHaveBeenCalled();
	});
	it("fails closed on foreign organization, project deletion, revoked project access or current role", async () => {
		for (const [index, alter] of [
			() =>
				m.access.mockResolvedValue({
					organizationId: "another-org",
					permissions: [Permissions.CONTEXT_READ],
				}),
			() => m.deleted.mockResolvedValue(true),
			() => m.hasAccess.mockResolvedValue(false),
			() =>
				m.access.mockResolvedValue({
					organizationId: actor.organizationId,
					permissions: [],
				}),
		].entries()) {
			m.access.mockResolvedValue({
				organizationId: actor.organizationId,
				permissions: [Permissions.CONTEXT_READ],
			});
			m.deleted.mockResolvedValue(false);
			m.hasAccess.mockResolvedValue(true);
			alter();
			await expect(
				assembleSelectedContext(actor, { selections: [ref] }),
			).rejects.toMatchObject(
				index === 3
					? { code: "FORBIDDEN", status: 403 }
					: { code: "NOT_FOUND", status: 404 },
			);
			expect(m.workspace).not.toHaveBeenCalled();
		}
	});
	it("sanitizes unexpected authority storage exceptions to static503", async () => {
		m.access.mockRejectedValue(
			new Error("private connection credential example-secret"),
		);
		await expect(
			assembleSelectedContext(actor, { selections: [ref] }),
		).rejects.toMatchObject({
			code: "UNAVAILABLE",
			status: 503,
			message:
				"Selected context could not be read. Retry this selection when its sources are available.",
		});
	});
});
