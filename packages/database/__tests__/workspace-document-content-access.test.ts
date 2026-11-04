import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	member: vi.fn(),
	query: vi.fn(),
	workspace: vi.fn(),
	list: vi.fn(),
}));
vi.mock("../prisma/client", async () => ({
	Prisma: (await import("../prisma/generated/client")).Prisma,
	db: {
		member: { findFirst: m.member },
		workspace: { findFirst: m.workspace },
	},
}));
vi.mock("../prisma/queries/workspaces/workspaces", () => ({
	getWorkspaceAccessContext: m.access,
}));
vi.mock("../src/tenant-db", () => ({
	withRLSContext: (_db: unknown, callback: (tx: unknown) => unknown) =>
		callback({ $queryRaw: m.query }),
}));

import {
	getWorkspaceDocumentCatalog,
	readWorkspaceDocumentContent,
} from "../prisma/queries/workspaces/document-content";

vi.mock("../prisma/queries/workspaces/documents", () => ({
	listWorkspaceDocuments: m.list,
}));

import { getTenantContext } from "../src/tenant-context";

const actor = { userId: "example-user", organizationId: "example-org" };
const input = {
	workspaceId: "example-workspace",
	documentId: "example-document",
};
beforeEach(() => {
	vi.resetAllMocks();
	m.access.mockResolvedValue({ organizationId: actor.organizationId });
	m.member.mockResolvedValue({ role: "member" });
	m.query.mockResolvedValue([
		{
			id: input.documentId,
			workspaceId: input.workspaceId,
			filename: "example.txt",
			mimeType: "text/plain",
			status: "READY",
			text: "abc",
			revision: "a".repeat(64),
			totalCharacters: 3,
			totalBytes: 3,
		},
	]);
});
describe("Workspace document current-role and object admission", () => {
	it.each([null, { organizationId: "other-org" }, { organizationId: null }])(
		"refuses missing or cross-organization object access before body SQL",
		async (access) => {
			m.access.mockResolvedValue(access);
			await expect(
				readWorkspaceDocumentContent(actor, input),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(m.query).not.toHaveBeenCalled();
		},
	);
	it("requires a current member in an undeleted organization", async () => {
		m.member.mockResolvedValue(null);
		await expect(
			readWorkspaceDocumentContent(actor, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.member).toHaveBeenCalledWith({
			where: { ...actor, organization: { deletedAt: null } },
			select: { role: true },
		});
		expect(m.query).not.toHaveBeenCalled();
	});
	it("does not accept an unknown role even when object access exists", async () => {
		m.member.mockResolvedValue({ role: "retired-role" });
		await expect(
			readWorkspaceDocumentContent(actor, input),
		).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
		expect(m.query).not.toHaveBeenCalled();
	});
	it("pins the SQL to both IDs and tenant and enters explicit RLS context", async () => {
		m.query.mockImplementation(async (sql) => {
			expect(getTenantContext()).toMatchObject({
				userId: actor.userId,
				organizationId: actor.organizationId,
				type: "organization",
			});
			expect(sql.values).toEqual([
				1,
				12000,
				input.documentId,
				input.workspaceId,
				actor.organizationId,
			]);
			expect(sql.text).toContain("substring");
			expect(sql.text).toContain("sha256(convert_to");
			return [
				{
					id: input.documentId,
					workspaceId: input.workspaceId,
					filename: "example.txt",
					mimeType: "text/plain",
					status: "READY",
					text: "abc",
					revision: "a".repeat(64),
					totalCharacters: 3,
					totalBytes: 3,
				},
			];
		});
		await expect(
			readWorkspaceDocumentContent(actor, input),
		).resolves.toMatchObject({ text: "abc" });
		expect(m.access).toHaveBeenCalledTimes(2);
		expect(m.member).toHaveBeenCalledTimes(2);
	});
	it("withholds a completed SQL read when membership is revoked during the query", async () => {
		m.member
			.mockResolvedValueOnce({ role: "member" })
			.mockResolvedValueOnce(null);
		await expect(
			readWorkspaceDocumentContent(actor, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.query).toHaveBeenCalledTimes(1);
	});
	it("bounds metadata discovery and projects document fields without full extraction or storage details", async () => {
		m.workspace.mockResolvedValue({
			id: input.workspaceId,
			name: "Example",
			status: "ACTIVE",
			type: "CUSTOM",
			createdAt: new Date("2026-01-01"),
			updatedAt: new Date("2026-01-01"),
		});
		m.list.mockResolvedValue({
			documents: [
				{
					id: input.documentId,
					originalFilename: "example.txt",
					mimeType: "text/plain",
					status: "READY",
					extractedText: "private-example-body",
					s3Path: "private-example-path",
					processingError: "private-example-error",
					updatedAt: new Date("2026-01-01"),
				},
			],
			total: 2,
			hasMore: true,
			nextOffset: 1,
		});
		const page = await getWorkspaceDocumentCatalog(actor, {
			workspaceId: input.workspaceId,
			limit: 1,
			offset: 0,
		});
		expect(page).toMatchObject({
			documentCount: 2,
			nextOffset: 1,
			paginationMode: "live_offset",
			snapshotConsistent: false,
			limit: 1,
			documents: [{ id: input.documentId, filename: "example.txt" }],
		});
		expect(JSON.stringify(page)).not.toContain("private-example");
		expect(m.workspace).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: input.workspaceId,
					organizationId: actor.organizationId,
				},
				select: expect.not.objectContaining({
					documents: expect.anything(),
				}),
			}),
		);
		expect(m.list).toHaveBeenCalledWith({
			workspaceId: input.workspaceId,
			limit: 1,
			offset: 0,
		});
		expect(m.access).toHaveBeenCalledTimes(2);
	});
	it("refuses unbounded metadata discovery before a query", async () => {
		await expect(
			getWorkspaceDocumentCatalog(actor, {
				workspaceId: input.workspaceId,
				limit: 101,
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(m.list).not.toHaveBeenCalled();
	});
});
