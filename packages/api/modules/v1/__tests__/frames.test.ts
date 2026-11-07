import { FrameUpdateConflictError } from "@repo/database";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	list: vi.fn(),
	brandingGet: vi.fn(),
	brandingApply: vi.fn(),
	get: vi.fn(),
	context: vi.fn(),
	update: vi.fn(),
	restore: vi.fn(),
	history: vi.fn(),
	canUpdate: vi.fn(),
	canRead: vi.fn(),
	canDelete: vi.fn(),
	share: vi.fn(),
	revoke: vi.fn(),
	grants: vi.fn(),
	startExport: vi.fn(),
	getExport: vi.fn(),
	cancelExport: vi.fn(),
	downloadExport: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	listFrames: m.list,
	getFrameBranding: m.brandingGet,
	applyFrameBranding: m.brandingApply,
	ArtifactBrandingError: class extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	},
	getFrameById: m.get,
	updateFrame: m.update,
	revertFrameToVersion: m.restore,
	getFrameEditHistory: m.history,
	canUpdateOrganizationFrames: m.canUpdate,
	canReadOrganizationFrames: m.canRead,
	canDeleteOrganizationFrames: m.canDelete,
	shareFrame: m.share,
	revokeFrameSharing: m.revoke,
	listSharingGrants: m.grants,
	FrameUpdateConflictError: class extends Error {},
}));
vi.mock("../../frames/lib/frame-export-service", () => ({
	startFrameExport: m.startExport,
	getFrameExport: m.getExport,
	cancelFrameExport: m.cancelExport,
	downloadFrameExport: m.downloadExport,
	FrameExportError: class extends Error {
		status = 409;
		code = "CONFLICT";
	},
}));
vi.mock("../helpers", () => ({
	resolveV1Context: m.context,
	ok: (data: unknown) => ({ data }),
	notFound: () => ({ error: { message: "Frame not found" } }),
}));
// Existing auth-middleware suites exercise current permissions and key scopes;
// this route test keeps the declared required scope visible at the boundary.
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			if (c.req.header("x-example-scope") !== scope) {
				return c.json({ error: "scope" }, 403);
			}
			await next();
		},
}));

import type { ExternalApiVariables } from "../../external-api/types";
import { registerFrameRoutes } from "../frames";

const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		userId: "example-user",
		organizationId: "example-org",
	} as ExternalApiVariables["externalApiContext"]);
	await next();
});
registerFrameRoutes(app);
const frame = {
	id: "example-frame",
	title: "Example",
	fileType: "FRAME",
	status: "ACTIVE",
	isPublic: true,
	shareToken: "example-bearer-token",
	userId: "example-user",
	organizationId: "example-org",
	createdAt: new Date(),
	updatedAt: new Date(),
};
const get = (path: string) =>
	app.request(path, { headers: { "x-example-scope": "frames:read" } });
beforeEach(() => {
	vi.clearAllMocks();
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	m.list.mockResolvedValue([frame]);
	m.get.mockResolvedValue(frame);
	m.canRead.mockResolvedValue(true);
	m.canDelete.mockResolvedValue(true);
	m.canUpdate.mockResolvedValue(true);
});
describe("Frames API discovery", () => {
	it("preserves exact actor/tenant filters and redacts links", async () => {
		const r = await get(
			"/frames?conversationId=example-thread&limit=21&offset=20",
		);
		expect(r.status).toBe(200);
		expect(m.list).toHaveBeenCalledWith({
			userId: "example-user",
			organizationId: "example-org",
			conversationId: "example-thread",
			limit: 21,
			offset: 20,
		});
		const body = await r.text();
		expect(body).not.toContain("example-bearer-token");
		expect(JSON.parse(body).data[0].shareToken).toBeNull();
	});
	it("redacts owner detail reads too", async () => {
		const r = await get("/frames/example-frame");
		expect((await r.json()).data.shareToken).toBeNull();
	});
	it.each([
		"limit=-1",
		"limit=1.2",
		"offset=-1",
		"offset=no",
		"conversationId=",
	])("refuses invalid input %s", async (query) => {
		expect((await get(`/frames?${query}`)).status).toBe(400);
		expect(m.list).not.toHaveBeenCalled();
	});
	it("keeps scope and unresolved tenant failures ahead of reads", async () => {
		expect((await app.request("/frames")).status).toBe(403);
		m.context.mockResolvedValue({
			error: "No accessible organization",
			status: 403,
		});
		expect((await get("/frames")).status).toBe(403);
		expect(m.list).not.toHaveBeenCalled();
	});
});

const post = (action: string, body: unknown, scope = "frames:write") =>
	app.request(`/frames/example-frame/${action}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-example-scope": scope,
		},
		body: JSON.stringify(body),
	});
it("requires scope, current authority, and the reviewed content revision", async () => {
	m.canUpdate.mockResolvedValue(true);
	m.update.mockResolvedValue(frame);
	const edit = {
		title: "Updated",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	};
	expect((await post("update", edit, "frames:read")).status).toBe(403);
	m.canUpdate.mockResolvedValue(false);
	expect((await post("update", edit)).status).toBe(403);
	m.canUpdate.mockResolvedValue(true);
	expect((await post("update", { ...edit, isPublic: true })).status).toBe(
		400,
	);
	expect((await post("update", edit)).status).toBe(200);
	expect(m.update).toHaveBeenCalledWith(
		expect.objectContaining({
			id: "example-frame",
			userId: "example-user",
			organizationId: "example-org",
			expectedUpdatedAt: new Date(edit.expectedUpdatedAt),
		}),
	);
});
it("restores one exact entry and forwards its revision", async () => {
	m.canUpdate.mockResolvedValue(true);
	m.restore.mockResolvedValue({
		success: true,
		updatedAt: "2026-11-02T00:00:00Z",
	});
	expect(
		(
			await post("restore", {
				historyEntryId: "example-entry",
				expectedUpdatedAt: "2026-11-01T00:00:00Z",
			})
		).status,
	).toBe(200);
	expect(m.restore).toHaveBeenCalledWith(
		expect.objectContaining({
			historyEntryId: "example-entry",
			frameId: "example-frame",
			userId: "example-user",
			organizationId: "example-org",
		}),
	);
});

it("returns a distinct conflict and refuses inaccessible content", async () => {
	m.canUpdate.mockResolvedValue(true);
	m.update.mockRejectedValueOnce(new FrameUpdateConflictError());
	const edit = {
		title: "Changed",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	};
	const stale = await post("update", edit);
	expect(stale.status).toBe(409);
	expect((await stale.json()).error.code).toBe("CONFLICT");
	m.update.mockResolvedValueOnce(null);
	expect((await post("update", edit)).status).toBe(404);
	m.restore.mockResolvedValueOnce({
		success: false,
		error: "Frame not found",
	});
	expect(
		(
			await post("restore", {
				expectedUpdatedAt: edit.expectedUpdatedAt,
				historyEntryId: "example-entry",
			})
		).status,
	).toBe(404);
});
it("returns metadata-only history after owner resolution", async () => {
	m.history.mockResolvedValue([
		{
			id: "example-entry",
			editType: "full_update",
			editedAt: new Date("2026-11-01T00:00:00Z"),
			contentSnapshot: "example private content",
			revertedToVersion: null,
		},
	]);
	const r = await get("/frames/example-frame/history");
	expect(r.status).toBe(200);
	expect(await r.text()).not.toContain("example private content");
	m.get.mockResolvedValue(null);
	m.history.mockClear();
	expect((await get("/frames/example-frame/history")).status).toBe(404);
	expect(m.history).not.toHaveBeenCalled();
});

it("requires export scope and forwards stable admission identity without publication fields", async () => {
	const input = {
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
		requestId: "12345678-1234-4123-8123-123456789abc",
		orientation: "portrait",
	};
	m.startExport.mockResolvedValue({
		exportId: "example-export",
		status: "pending",
		expectedUpdatedAt: input.expectedUpdatedAt,
	});
	expect((await post("exports", input, "frames:read")).status).toBe(403);
	expect(m.startExport).not.toHaveBeenCalled();
	expect((await post("exports", { ...input, isPublic: true })).status).toBe(
		400,
	);
	expect((await post("exports", input)).status).toBe(200);
	expect(m.startExport).toHaveBeenCalledWith(
		{ userId: "example-user", organizationId: "example-org" },
		{ frameId: "example-frame", ...input },
	);
});
it("keeps status read-only and download issuance explicit", async () => {
	m.getExport.mockResolvedValue({
		status: "completed",
		exportId: "example-export",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	});
	m.downloadExport.mockResolvedValue({
		url: "https://example.com/short-lived",
		expiresAt: "2026-11-01T00:01:00Z",
	});
	expect(
		(await get("/frames/example-frame/exports/example-export")).status,
	).toBe(200);
	expect(m.downloadExport).not.toHaveBeenCalled();
	expect(
		(await post("exports/example-export/download", {}, "frames:read"))
			.status,
	).toBe(200);
	expect(m.downloadExport).toHaveBeenCalledWith(
		{ userId: "example-user", organizationId: "example-org" },
		{ frameId: "example-frame", exportId: "example-export" },
	);
	expect(
		(await post("exports/example-export/cancel", {}, "frames:read")).status,
	).toBe(403);
	m.cancelExport.mockResolvedValue({ status: "running" });
	expect((await post("exports/example-export/cancel", {})).status).toBe(200);
});
it("requires current sharing authority and reviewed revision for every sharing mutation", async () => {
	const input = {
		scope: "PUBLIC",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	};
	m.share.mockResolvedValue({
		ok: true,
		scope: "PUBLIC",
		shareToken: "example-link-token",
		updatedAt: new Date(input.expectedUpdatedAt),
	});
	m.canUpdate.mockResolvedValue(false);
	expect((await post("share", input)).status).toBe(403);
	expect(m.share).not.toHaveBeenCalled();
	m.canUpdate.mockResolvedValue(true);
	expect((await post("share", { scope: "PUBLIC" })).status).toBe(400);
	expect((await post("share", input)).status).toBe(200);
	m.revoke.mockResolvedValue({
		ok: true,
		scope: "PRIVATE",
		updatedAt: new Date(input.expectedUpdatedAt),
		revokedInvitations: 1,
	});
	expect(
		(
			await post("revoke-sharing", {
				expectedUpdatedAt: input.expectedUpdatedAt,
				mode: "all",
			})
		).status,
	).toBe(200);
	expect(m.revoke).toHaveBeenCalledWith({
		frameId: "example-frame",
		userId: "example-user",
		organizationId: "example-org",
		expectedUpdatedAt: new Date(input.expectedUpdatedAt),
		mode: "all",
	});
	expect(
		(
			await post("revoke-sharing", {
				expectedUpdatedAt: input.expectedUpdatedAt,
				mode: "invitation",
			})
		).status,
	).toBe(400);
});
it("never returns public link credentials in sharing inspection", async () => {
	m.grants.mockResolvedValue([
		{
			id: "example-grant",
			email: "reader@example.com",
			invitedAt: new Date("2026-11-01T00:00:00Z"),
			token: "example-invitation-secret",
		},
	]);
	const r = await get("/frames/example-frame/sharing");
	expect(r.status).toBe(200);
	const body = await r.text();
	expect(body).not.toContain("example-bearer-token");
	expect(body).not.toContain("example-invitation-secret");
	m.get.mockResolvedValue(null);
	m.grants.mockClear();
	expect((await get("/frames/example-frame/sharing")).status).toBe(404);
	expect(m.grants).not.toHaveBeenCalled();
});

it("preserves safe export conflict codes without exposing provider errors", async () => {
	const service = await import("../../frames/lib/frame-export-service");
	m.startExport.mockRejectedValueOnce(
		new service.FrameExportError(
			409,
			"CONFLICT",
			"Reviewed revision changed",
		),
	);
	const result = await post("exports", {
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
		requestId: "12345678-1234-4123-8123-123456789abc",
	});
	expect(result.status).toBe(409);
	expect((await result.json()).error.code).toBe("CONFLICT");
});

it("requires the same live delete authority as UI revocation even when sharing updates are allowed", async () => {
	m.canUpdate.mockResolvedValue(true);
	m.canDelete.mockResolvedValue(false);
	const result = await post("revoke-sharing", {
		mode: "all",
		expectedUpdatedAt: "2026-11-01T00:00:00Z",
	});
	expect(result.status).toBe(403);
	expect(m.revoke).not.toHaveBeenCalled();
	expect(m.canDelete).toHaveBeenCalledWith("example-user", "example-org");
});

describe("Frame branding transport contract", () => {
	it("reads reviewed source choices with the exact actor and organization", async () => {
		m.brandingGet.mockResolvedValue({
			frameUpdatedAt: "2026-11-05T00:00:00.000Z",
			projectId: "example-project",
			company: { version: 1 },
			client: { version: 2 },
		});
		const r = await get("/frames/example-frame/branding");
		expect(r.status).toBe(200);
		expect(m.brandingGet).toHaveBeenCalledWith({
			id: "example-frame",
			userId: "example-user",
			organizationId: "example-org",
		});
	});
	it("never reaches a writer from a read-only key", async () => {
		const r = await app.request("/frames/example-frame/branding", {
			method: "POST",
			headers: {
				"x-example-scope": "frames:read",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				source: "CLIENT",
				expectedBrandVersion: 1,
				expectedUpdatedAt: "2026-11-05T00:00:00.000Z",
			}),
		});
		expect(r.status).toBe(403);
		expect(m.brandingApply).not.toHaveBeenCalled();
	});
	it("bounds the original JSON stream before applying a brand", async () => {
		const r = await app.request("/frames/example-frame/branding", {
			method: "POST",
			headers: {
				"x-example-scope": "frames:write",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				source: "CLIENT",
				padding: "x".repeat(17000),
				expectedBrandVersion: 1,
				expectedUpdatedAt: "2026-11-05T00:00:00.000Z",
			}),
		});
		expect(r.status).toBe(413);
		expect(m.brandingApply).not.toHaveBeenCalled();
	});
});
