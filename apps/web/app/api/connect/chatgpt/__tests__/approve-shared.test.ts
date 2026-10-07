/**
 * `POST /api/connect/chatgpt/approve` in shared mode (Fizzy #2770): the slug
 * is resolved only among the session user's own memberships, every reason
 * for refusing reads the same, and the ticket binds one organization.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	createTicket: vi.fn(),
	organizations: vi.fn(),
	findAdminOrganization: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.session }));
vi.mock("@repo/database", () => ({
	createChatGptPlanUploadTicket: mocks.createTicket,
	listChatGptPlanOrganizations: mocks.organizations,
	findChatGptPlanPoolAdminOrganization: mocks.findAdminOrganization,
}));

const { POST } = await import("../approve/route");

const approve = (body: unknown) =>
	POST(
		new Request("http://localhost/api/connect/chatgpt/approve", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.session.mockResolvedValue({ user: { id: "user-admin" } });
	mocks.createTicket.mockResolvedValue({
		ticket: "ticket-example",
		expiresAt: new Date("2026-10-07T12:10:00Z"),
	});
	mocks.findAdminOrganization.mockResolvedValue({
		id: "org-a",
		slug: "example-org",
		name: "Example Org",
		role: "admin",
	});
});

describe("POST /api/connect/chatgpt/approve, shared", () => {
	it("binds one organization the session user administers", async () => {
		const response = await approve({
			shared: { organizationSlug: "example-org" },
		});
		expect(response.status).toBe(200);
		expect(mocks.findAdminOrganization).toHaveBeenCalledWith({
			userId: "user-admin",
			slug: "example-org",
		});
		expect(mocks.createTicket).toHaveBeenCalledWith({
			kind: "org",
			userId: "user-admin",
			organizationId: "org-a",
		});
		expect(mocks.organizations).not.toHaveBeenCalled();
	});

	it("refuses an unknown slug, a non-admin and a flag that is off alike", async () => {
		mocks.findAdminOrganization.mockResolvedValue(null);
		const response = await approve({
			shared: { organizationSlug: "someone-elses-org" },
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "You can connect a shared ChatGPT plan account only to an organization you administer, with ChatGPT plan pooling enabled.",
		});
		expect(mocks.createTicket).not.toHaveBeenCalled();
	});

	it("never takes the organization from anything but the slug lookup", async () => {
		await approve({
			shared: { organizationSlug: "example-org" },
			organizationIds: ["org-elsewhere"],
			organizationId: "org-elsewhere",
		});
		expect(mocks.createTicket).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-a" }),
		);
	});

	it("refuses shared mode without a session", async () => {
		mocks.session.mockResolvedValue(null);
		const response = await approve({
			shared: { organizationSlug: "example-org" },
		});
		expect(response.status).toBe(401);
		expect(mocks.findAdminOrganization).not.toHaveBeenCalled();
	});

	it("refuses a session acting as another user, before any lookup", async () => {
		mocks.session.mockResolvedValue({
			user: { id: "user-admin" },
			session: { impersonatedBy: "app-admin" },
		});
		const response = await approve({
			shared: { organizationSlug: "example-org" },
		});
		expect(response.status).toBe(403);
		expect(mocks.findAdminOrganization).not.toHaveBeenCalled();
		expect(mocks.createTicket).not.toHaveBeenCalled();
	});
});
