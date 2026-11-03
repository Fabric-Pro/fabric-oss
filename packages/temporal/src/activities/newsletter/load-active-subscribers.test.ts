import { beforeEach, describe, expect, it, vi } from "vitest";

const listActiveNewsletterSubscribers = vi.fn();
const enrollProjectMembersAsSubscribers = vi.fn();
const syncOrganizationSubscribers = vi.fn();
const recordOrganizationSyncFailure = vi.fn();
const logError = vi.fn();

vi.mock("@repo/database", () => ({
	syncOrganizationSubscribers: (...a: unknown[]) =>
		syncOrganizationSubscribers(...a),
	recordOrganizationSyncFailure: (...a: unknown[]) =>
		recordOrganizationSyncFailure(...a),
	listActiveNewsletterSubscribers: (...a: unknown[]) =>
		listActiveNewsletterSubscribers(...a),
	enrollProjectMembersAsSubscribers: (...a: unknown[]) =>
		enrollProjectMembersAsSubscribers(...a),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: (...a: unknown[]) => logError(...a),
	},
}));

import { loadActiveSubscribersActivity } from "./load-active-subscribers";

describe("loadActiveSubscribersActivity", () => {
	beforeEach(() => {
		listActiveNewsletterSubscribers.mockReset().mockResolvedValue([
			{
				id: "s1",
				email: "a@example.com",
				name: null,
				unsubscribeToken: "t1",
			},
		]);
		enrollProjectMembersAsSubscribers
			.mockReset()
			.mockResolvedValue({ enrolled: 1 });
		syncOrganizationSubscribers
			.mockReset()
			.mockResolvedValue({ added: 0, removed: 0 });
		recordOrganizationSyncFailure.mockReset().mockResolvedValue({});
		logError.mockReset();
	});

	it("syncs the organization before reading the list", async () => {
		await loadActiveSubscribersActivity({ projectId: "p1" });

		expect(syncOrganizationSubscribers).toHaveBeenCalledWith("p1");
		expect(
			syncOrganizationSubscribers.mock.invocationCallOrder[0],
		).toBeLessThan(
			listActiveNewsletterSubscribers.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("still sends to the existing list when the sync fails, and says so", async () => {
		syncOrganizationSubscribers.mockRejectedValue(new Error("db down"));

		const out = await loadActiveSubscribersActivity({ projectId: "p1" });

		expect(out.subscribers).toHaveLength(1);
		expect(logError).toHaveBeenCalled();
		expect(recordOrganizationSyncFailure).toHaveBeenCalledWith(
			"p1",
			"db down",
		);
	});

	it("does not fail the send when recording the failure also fails", async () => {
		syncOrganizationSubscribers.mockRejectedValue(new Error("db down"));
		recordOrganizationSyncFailure.mockRejectedValue(
			new Error("still down"),
		);

		const out = await loadActiveSubscribersActivity({ projectId: "p1" });

		expect(out.subscribers).toHaveLength(1);
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
