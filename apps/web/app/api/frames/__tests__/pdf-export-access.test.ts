import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	session: vi.fn(),
	start: vi.fn(),
	get: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: m.session } } }));
vi.mock("@repo/api/modules/frames/lib/frame-export-service", () => ({
	startFrameExport: m.start,
	getFrameExport: m.get,
	FrameExportError: class extends Error {
		constructor(
			public status: number,
			public code: string,
			message: string,
		) {
			super(message);
		}
	},
}));

import { FrameExportError } from "@repo/api/modules/frames/lib/frame-export-service";
import { POST } from "../[id]/export/pdf/route";
import { GET } from "../[id]/export/pdf/status/[workflowId]/route";

const request = {
	expectedUpdatedAt: "2026-11-01T00:00:00Z",
	requestId: "11111111-1111-4111-8111-111111111111",
};
const post = (body: unknown = request) =>
	POST(
		new Request("http://localhost/api/frames/example-frame/export/pdf", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		}) as never,
		{ params: Promise.resolve({ id: "example-frame" }) },
	);
const get = () =>
	GET(new Request("http://localhost") as never, {
		params: Promise.resolve({
			id: "example-frame",
			workflowId: "example-export",
		}),
	});
beforeEach(() => {
	vi.clearAllMocks();
	m.session.mockResolvedValue({
		user: { id: "example-user", email: "user@example.com" },
		session: { activeOrganizationId: "example-org" },
	});
	m.start.mockResolvedValue({
		exportId: "example-export",
		status: "pending",
	});
	m.get.mockResolvedValue({
		exportId: "example-export",
		status: "completed",
	});
});
it("requires a session before dispatching shared commands", async () => {
	m.session.mockResolvedValue(null);
	expect((await post()).status).toBe(401);
	expect((await get()).status).toBe(401);
	expect(m.start).not.toHaveBeenCalled();
	expect(m.get).not.toHaveBeenCalled();
});
it("forwards original actor, organization and reviewed identity to canonical admission", async () => {
	expect((await post()).status).toBe(200);
	expect(m.start).toHaveBeenCalledWith(
		{
			userId: "example-user",
			userEmail: "user@example.com",
			organizationId: "example-org",
		},
		{ ...request, frameId: "example-frame", orientation: undefined },
	);
});
it("preserves authorization and conflict failures from canonical commands", async () => {
	m.start.mockRejectedValue(
		new FrameExportError(409, "CONFLICT", "Review the page again."),
	);
	expect((await post()).status).toBe(409);
	m.get.mockRejectedValue(
		new FrameExportError(404, "NOT_FOUND", "Export not found."),
	);
	expect((await get()).status).toBe(404);
});
it("rejects malformed requests before dispatch and never reflects unknown provider errors", async () => {
	expect((await post(null)).status).toBe(400);
	m.get.mockRejectedValue(new Error("example provider secret"));
	const r = await get();
	expect(r.status).toBe(503);
	expect(await r.text()).not.toContain("secret");
});
it("uses metadata-only status rather than fetching a legacy workflow result URL", async () => {
	const r = await get();
	expect(await r.json()).toEqual({
		exportId: "example-export",
		status: "completed",
	});
	expect(m.get).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: "example-user",
			organizationId: "example-org",
		}),
		{ frameId: "example-frame", exportId: "example-export" },
	);
});
