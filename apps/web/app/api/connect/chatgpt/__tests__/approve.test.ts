/**
 * `POST /api/connect/chatgpt/approve` (Fizzy #2939): only a signed-in person
 * gets a ticket, the ticket names the session's own user, and it binds only
 * the ticked organizations where that person may use the plan.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	createTicket: vi.fn(),
	organizations: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.session }));
vi.mock("@repo/database", () => ({
	createChatGptPlanUploadTicket: mocks.createTicket,
	listChatGptPlanOrganizations: mocks.organizations,
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
	mocks.session.mockResolvedValue({ user: { id: "user-a" } });
	mocks.organizations.mockResolvedValue([{ id: "org-a" }, { id: "org-b" }]);
	mocks.createTicket.mockResolvedValue({
		ticket: "ticket-example",
		expiresAt: new Date("2026-10-06T12:10:00Z"),
	});
});

describe("POST /api/connect/chatgpt/approve", () => {
	it("refuses a request without a session", async () => {
		mocks.session.mockResolvedValue(null);
		expect((await approve({ organizationIds: [] })).status).toBe(401);
		expect(mocks.createTicket).not.toHaveBeenCalled();
	});

	it("binds the session's user and only the allowed ticked organizations", async () => {
		const response = await approve({
			organizationIds: ["org-a", "org-elsewhere"],
		});
		expect(response.status).toBe(200);
		expect(mocks.createTicket).toHaveBeenCalledWith({
			userId: "user-a",
			organizationIds: ["org-a"],
		});
		expect(await response.json()).toMatchObject({
			ticket: "ticket-example",
		});
	});

	it("refuses when no ticked organization allows the plan", async () => {
		expect((await approve({})).status).toBe(403);
		mocks.organizations.mockResolvedValue([]);
		expect((await approve({ organizationIds: ["org-a"] })).status).toBe(
			403,
		);
		expect(mocks.createTicket).not.toHaveBeenCalled();
	});
});
