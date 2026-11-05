import {
	createWorkspaceDocumentContentReader,
	WorkspaceDocumentContentError,
} from "@repo/database/src/workspace-document-content";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExternalApiContext,
	ExternalApiVariables,
} from "../../external-api/types";

const m = vi.hoisted(() => ({
	read: vi.fn(),
	authorize: vi.fn(),
	list: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: vi.fn(async () => ({ name: "Example project" })),
		},
	},
	canExecuteOrganizationAgents: vi.fn(),
	canRunOrganizationWorkflows: vi.fn(),
	resolveUserOrganization: vi.fn(),
}));
vi.mock("../../users/procedures/api-keys/verify", () => ({
	verifyUserApiKey: vi.fn(),
}));
vi.mock(
	"@repo/database/prisma/queries/workspaces/document-content",
	async () => ({
		...(await import("@repo/database/src/workspace-document-content")),
		readWorkspaceDocumentContent: m.read,
		getWorkspaceDocumentCatalog: m.list,
	}),
);

import { registerWorkspaceDocumentContentRoutes } from "../workspace-document-content";

const ctx: ExternalApiContext = {
	keyType: "organization",
	keyId: "example-key",
	keyPrefix: "org_example",
	userId: "example-user",
	organizationId: "example-org",
	scopes: ["workspaces:read"],
};
const path = "/workspaces/example-workspace/documents/example-document/content";
function app(context = ctx) {
	const app = new Hono<{ Variables: ExternalApiVariables }>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", context);
		await next();
	});
	registerWorkspaceDocumentContentRoutes(app);
	return app;
}
beforeEach(() => {
	vi.resetAllMocks();
	m.authorize.mockResolvedValue(undefined);
	m.read.mockImplementation(
		createWorkspaceDocumentContentReader({
			authorize: m.authorize,
			readPage: async () => ({
				id: "example-document",
				workspaceId: "example-workspace",
				filename: "example.txt",
				mimeType: "text/plain",
				status: "READY",
				text: "A😀",
				revision: "a".repeat(64),
				totalCharacters: 4,
				totalBytes: 7,
			}),
		}),
	);
	m.list.mockResolvedValue({
		documents: [
			{
				id: "example-document",
				filename: "example.txt",
				mimeType: "text/plain",
				status: "READY",
				updatedAt: new Date("2026-01-01"),
				s3Path: "private-example-path",
				extractedText: "private-example-text",
				processingError: "private-example-error",
			},
		],
		documentCount: 1,
		nextOffset: null,
		paginationMode: "live_offset",
		snapshotConsistent: false,
	});
});
describe("Workspace document REST parity", () => {
	it("uses the resolved current actor and returns a revision-pinned bounded page with no-store", async () => {
		const response = await app().request(`${path}?limit=2`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			data: {
				text: "A😀",
				nextOffset: 2,
				revision: "a".repeat(64),
				offsetUnit: "unicode_code_points",
				historicalVersionsAvailable: false,
			},
		});
		expect(m.read).toHaveBeenCalledWith(
			{ userId: ctx.userId, organizationId: ctx.organizationId },
			expect.objectContaining({
				workspaceId: "example-workspace",
				documentId: "example-document",
				limit: 2,
			}),
		);
	});
	it("rejects missing scopes before consulting the content facade", async () => {
		const response = await app({
			...ctx,
			scopes: ["projects:read"],
		}).request(path);
		expect(response.status).toBe(403);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("checks live grants even for wildcard credentials", async () => {
		m.authorize.mockRejectedValue(
			new WorkspaceDocumentContentError("FORBIDDEN"),
		);
		const response = await app({ ...ctx, scopes: ["*"] }).request(path);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			error: { code: "FORBIDDEN" },
		});
	});
	it("preserves indistinguishable missing/object-denied semantics", async () => {
		m.authorize.mockRejectedValue(
			new WorkspaceDocumentContentError("NOT_FOUND"),
		);
		const response = await app().request(path);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: {
				code: "NOT_FOUND",
				message: "Workspace document not found or access denied.",
			},
		});
	});
	it.each([
		"?limit=20001",
		"?offset=-1",
		"?offset=0.5",
		"?expectedRevision=invalid",
		"?limit=NaN",
	])("rejects invalid page %s", async (query) => {
		const response = await app().request(path + query);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_INPUT" },
		});
	});
	it("refuses unpinned continuation and changed content with actionable status", async () => {
		let response = await app().request(`${path}?offset=2`);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "REVISION_REQUIRED" },
		});
		response = await app().request(
			`${path}?expectedRevision=${"b".repeat(64)}`,
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "STALE_REVISION" },
		});
	});
	it("does not let a project-bound credential become an organization-wide document reader", async () => {
		const response = await app({
			...ctx,
			boundProjectId: "example-project",
		}).request(path);
		expect(response.status).toBe(403);
		expect(m.read).not.toHaveBeenCalled();
	});
	it("returns safe document IDs/status for discovery and repeats object authorization", async () => {
		const response = await app().request(
			"/workspaces/example-workspace/documents?limit=10&offset=0",
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({
			data: {
				documents: [
					{
						id: "example-document",
						filename: "example.txt",
						mimeType: "text/plain",
						status: "READY",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
				total: 1,
				nextOffset: null,
				paginationMode: "live_offset",
				snapshotConsistent: false,
			},
		});
		expect(m.list).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: ctx.userId,
				organizationId: ctx.organizationId,
			}),
			{ workspaceId: "example-workspace", limit: 10, offset: 0 },
		);
		expect(JSON.stringify(body)).not.toContain("private-example");
	});
	it("bounds document discovery before database access", async () => {
		const response = await app().request(
			"/workspaces/example-workspace/documents?limit=101",
		);
		expect(response.status).toBe(400);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("sanitizes unexpected adapter errors", async () => {
		m.read.mockRejectedValue(
			new Error("private-example-connection-string"),
		);
		const response = await app().request(path);
		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("private-example");
	});
	it.each(["", " ", "+1", "-0", "1e1", "0x10", "1.0", "1_0"])(
		"rejects non-decimal numeric text %j on both content/catalog routes",
		async (value) => {
			for (const route of [
				path,
				"/workspaces/example-workspace/documents",
			]) {
				for (const field of ["offset", "limit"]) {
					const response = await app().request(
						`${route}?${field}=${encodeURIComponent(value)}`,
					);
					expect(response.status, `${route} ${field}=${value}`).toBe(
						400,
					);
					expect(await response.json()).toMatchObject({
						error: { code: "INVALID_INPUT" },
					});
				}
			}
			expect(m.authorize).not.toHaveBeenCalled();
			expect(m.list).not.toHaveBeenCalled();
		},
	);
});
