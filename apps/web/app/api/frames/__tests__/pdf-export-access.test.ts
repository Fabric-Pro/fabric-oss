import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	canRead: vi.fn(),
	frame: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	result: vi.fn(),
	getHandle: vi.fn(),
}));
vi.mock("@repo/auth", () => ({ auth: { api: { getSession: mocks.session } } }));
vi.mock("@repo/database", () => ({
	canReadOrganizationFrames: mocks.canRead,
	getAccessibleFrameById: mocks.frame,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.start, getHandle: mocks.getHandle },
	}),
}));
vi.mock("@repo/temporal/workflows", () => ({ exportFrameToPDF: vi.fn() }));

import { POST } from "../[id]/export/pdf/route";
import { GET } from "../[id]/export/pdf/status/[workflowId]/route";

const params = { params: Promise.resolve({ id: "frame-example" }) };
const statusParams = (workflowId = "frame-export-frame-example-123") => ({
	params: Promise.resolve({ id: "frame-example", workflowId }),
});
const post = () =>
	POST(
		new Request("http://localhost/api/frames/frame-example/export/pdf", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ organizationId: "org-example" }),
		}) as never,
		params,
	);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue({
		user: { id: "user-example", email: "user@example.com" },
		session: { activeOrganizationId: "org-example" },
	});
	mocks.canRead.mockResolvedValue(true);
	mocks.frame.mockResolvedValue({
		id: "frame-example",
		organizationId: "org-example",
	});
	mocks.start.mockResolvedValue({
		workflowId: "frame-export-frame-example-123",
	});
	mocks.describe.mockResolvedValue({ status: { name: "RUNNING" } });
	mocks.getHandle.mockReturnValue({
		describe: mocks.describe,
		result: mocks.result,
	});
});
describe("frame PDF export access", () => {
	it("requires authentication and current frame read permission before starting work", async () => {
		mocks.session.mockResolvedValue(null);
		expect((await post()).status).toBe(401);
		mocks.session.mockResolvedValue({
			user: { id: "user-example" },
			session: { activeOrganizationId: "org-example" },
		});
		mocks.canRead.mockResolvedValue(false);
		expect((await post()).status).toBe(404);
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("requires object access even when the caller belongs to the organization", async () => {
		mocks.frame.mockResolvedValue(null);
		expect((await post()).status).toBe(404);
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.frame).toHaveBeenCalledWith({
			id: "frame-example",
			userId: "user-example",
			userEmail: "user@example.com",
			organizationId: "org-example",
		});
	});
	it("starts authorized exports on the queue served by the main worker", async () => {
		expect((await post()).status).toBe(200);
		expect(mocks.start).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				taskQueue: "fabric-worker",
				args: [
					expect.objectContaining({
						frameId: "frame-example",
						userId: "user-example",
						organizationId: "org-example",
					}),
				],
			}),
		);
	});
	it("refuses another frame's export handle before asking Temporal", async () => {
		const r = await GET(
			new Request("http://localhost") as never,
			statusParams("frame-export-another-frame-123"),
		);
		expect(r.status).toBe(404);
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});
	it("returns running status without waiting for the workflow result", async () => {
		const r = await GET(
			new Request("http://localhost") as never,
			statusParams(),
		);
		expect(await r.json()).toEqual({ status: "running" });
		expect(mocks.result).not.toHaveBeenCalled();
	});
	it("checks current object access on every status poll", async () => {
		mocks.frame.mockResolvedValue(null);
		expect(
			(
				await GET(
					new Request("http://localhost") as never,
					statusParams(),
				)
			).status,
		).toBe(404);
		expect(mocks.getHandle).not.toHaveBeenCalled();
	});
});
