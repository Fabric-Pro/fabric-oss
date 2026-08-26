import { beforeEach, describe, expect, it, vi } from "vitest";

const listActiveNewsletterSubscribers = vi.fn();
const enrollProjectMembersAsSubscribers = vi.fn();

vi.mock("@repo/database", () => ({
	listActiveNewsletterSubscribers: (...a: unknown[]) =>
		listActiveNewsletterSubscribers(...a),
	enrollProjectMembersAsSubscribers: (...a: unknown[]) =>
		enrollProjectMembersAsSubscribers(...a),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { loadActiveSubscribersActivity } from "./load-active-subscribers";

describe("loadActiveSubscribersActivity", () => {
	beforeEach(() => {
		listActiveNewsletterSubscribers.mockReset().mockResolvedValue([
			{
				id: "s1",
				email: "a@x.com",
				name: null,
				unsubscribeToken: "t1",
			},
		]);
		enrollProjectMembersAsSubscribers
			.mockReset()
			.mockResolvedValue({ enrolled: 1 });
	});

	it("reconciles members then returns the active list", async () => {
		const out = await loadActiveSubscribersActivity({ projectId: "p1" });
		expect(enrollProjectMembersAsSubscribers).toHaveBeenCalledWith({
			projectId: "p1",
		});
		// reconcile runs BEFORE the active-list read
		const enrolOrder =
			enrollProjectMembersAsSubscribers.mock.invocationCallOrder[0];
		const listOrder =
			listActiveNewsletterSubscribers.mock.invocationCallOrder[0];
		expect(enrolOrder).toBeLessThan(listOrder);
		expect(out.subscribers).toHaveLength(1);
	});

	it("still returns the active list if reconcile throws (best-effort)", async () => {
		enrollProjectMembersAsSubscribers.mockRejectedValue(new Error("blip"));
		const out = await loadActiveSubscribersActivity({ projectId: "p1" });
		expect(out.subscribers).toHaveLength(1);
	});
});
