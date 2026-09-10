/**
 * The organization purge sweep, at the workflow level (Fizzy #2462).
 *
 * Three properties are worth pinning here, and they are all about ORDER and
 * about what the sweep refuses to do:
 *
 *   1. The reminder pass only counts a warning the activity says went out — the
 *      `deletionReminderSentAt` stamp lives inside that activity, so the
 *      workflow's only job is not to invent a send that did not happen.
 *   2. A restored organization is SKIPPED, not failed, and — the assertion that
 *      actually matters — nothing external is torn down for it. A restored
 *      tenant that comes back without its vectors, files or billing is a worse
 *      outcome than one that was never restorable.
 *   3. Teardown runs only AFTER a database delete that really removed the row,
 *      and every step runs even when an earlier one fails, because none of them
 *      can be retried by a later sweep once the row is gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	getOrganizationsNeedingPurgeReminderActivity: vi.fn(),
	sendOrganizationDeletionReminderActivity: vi.fn(),
	getExpiredOrganizationsActivity: vi.fn(),
	captureOrganizationSubscriptionIdsActivity: vi.fn(),
	permanentDeleteOrganizationFromDbActivity: vi.fn(),
	deleteOrganizationVectorsActivity: vi.fn(),
	deleteOrganizationObjectsFromStorageActivity: vi.fn(),
	cancelOrganizationSubscriptionsActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	ApplicationFailure: class ApplicationFailure extends Error {
		static nonRetryable(message: string, type: string) {
			const failure = new ApplicationFailure(message);
			failure.name = type;
			return failure;
		}
	},
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	proxyActivities: vi.fn(() => activityStubs),
}));

import { organizationDeleteCleanupWorkflow } from "../src/workflows/organization-deletion";

const PURGE_AT = "2098-03-14T00:00:00.000Z";

const expiredOrg = (over: Record<string, unknown> = {}) => ({
	id: "org-1",
	name: "Example Org",
	...over,
});

const orgNeedingReminder = (over: Record<string, unknown> = {}) => ({
	id: "org-1",
	name: "Example Org",
	deletedBy: "user-1",
	owners: [{ id: "user-1", email: "owner1@example.com" }],
	scheduledPermanentDeleteAt: PURGE_AT,
	...over,
});

/** Every teardown stub, for the "must not have been touched" assertions. */
function expectNoTeardown() {
	expect(
		activityStubs.deleteOrganizationVectorsActivity,
	).not.toHaveBeenCalled();
	expect(
		activityStubs.deleteOrganizationObjectsFromStorageActivity,
	).not.toHaveBeenCalled();
	expect(
		activityStubs.cancelOrganizationSubscriptionsActivity,
	).not.toHaveBeenCalled();
}

beforeEach(() => {
	// Per-stub resets rather than `vi.clearAllMocks()`: an unconsumed
	// `mockResolvedValueOnce` survives that call and leaks into the next test.
	for (const stub of Object.values(activityStubs)) {
		stub.mockReset();
	}

	activityStubs.getOrganizationsNeedingPurgeReminderActivity.mockResolvedValue(
		[],
	);
	activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([]);
	activityStubs.captureOrganizationSubscriptionIdsActivity.mockResolvedValue({
		subscriptionIds: [],
	});
	activityStubs.permanentDeleteOrganizationFromDbActivity.mockResolvedValue({
		success: true,
	});
	activityStubs.deleteOrganizationVectorsActivity.mockResolvedValue({
		success: true,
	});
	activityStubs.deleteOrganizationObjectsFromStorageActivity.mockResolvedValue(
		{ deleted: 0, pages: 1 },
	);
	activityStubs.cancelOrganizationSubscriptionsActivity.mockResolvedValue({
		cancelled: 0,
		failed: [],
	});
});

describe("reminder pass", () => {
	it("asks the activity to warn each organization in the band, and counts what it sent", async () => {
		activityStubs.getOrganizationsNeedingPurgeReminderActivity.mockResolvedValue(
			[
				orgNeedingReminder(),
				orgNeedingReminder({ id: "org-2", name: "Second Example Org" }),
			],
		);
		activityStubs.sendOrganizationDeletionReminderActivity.mockResolvedValue(
			{ sent: true },
		);

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.remindersSent).toBe(2);
		expect(
			activityStubs.sendOrganizationDeletionReminderActivity,
		).toHaveBeenCalledWith({
			organizationId: "org-1",
			organizationName: "Example Org",
			owners: [{ id: "user-1", email: "owner1@example.com" }],
			// Passed through as the ISO string the activity produced, never as a
			// Date — the JSON data converter would flatten it anyway, and the
			// receiving activity formats it.
			scheduledPermanentDeleteAt: PURGE_AT,
		});
	});

	/**
	 * The stamp that stops a second warning lives inside the send activity and
	 * is written only on a real send. So a refusal must not be counted, and —
	 * more importantly — must not stop the rest of the batch.
	 */
	it("does not count a reminder the activity refused to send, and keeps going", async () => {
		activityStubs.getOrganizationsNeedingPurgeReminderActivity.mockResolvedValue(
			[
				orgNeedingReminder({ id: "org-1", deletedBy: null }),
				orgNeedingReminder({ id: "org-2" }),
			],
		);
		activityStubs.sendOrganizationDeletionReminderActivity
			.mockResolvedValueOnce({
				sent: false,
				error: "No reminder recipient",
			})
			.mockResolvedValueOnce({ sent: true });

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.remindersSent).toBe(1);
		expect(
			activityStubs.sendOrganizationDeletionReminderActivity,
		).toHaveBeenCalledTimes(2);
		// A mailbox that refuses is not a purge failure.
		expect(out.failedOrganizationIds).toEqual([]);
		expect(out.success).toBe(true);
	});

	it("a throwing reminder does not abort the batch or fail the run", async () => {
		activityStubs.getOrganizationsNeedingPurgeReminderActivity.mockResolvedValue(
			[
				orgNeedingReminder({ id: "org-1" }),
				orgNeedingReminder({ id: "org-2" }),
			],
		);
		activityStubs.sendOrganizationDeletionReminderActivity
			.mockRejectedValueOnce(new Error("smtp exploded"))
			.mockResolvedValueOnce({ sent: true });

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.remindersSent).toBe(1);
		expect(out.success).toBe(true);
	});
});

describe("purge pass", () => {
	/**
	 * THE GUARD. `permanentDeleteOrganization` fails closed when `deletedAt` is
	 * back to null, and this is what the workflow must do with that answer.
	 */
	it("skips a restored organization without failing it or touching anything external", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);
		activityStubs.permanentDeleteOrganizationFromDbActivity.mockResolvedValue(
			{
				success: false,
				restored: true,
				error: "Organization was restored",
			},
		);

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.organizationsDeleted).toBe(0);
		// A restore is a SKIP, not a failure — this list is what alerting reads.
		expect(out.failedOrganizationIds).toEqual([]);
		expect(out.success).toBe(true);
		expectNoTeardown();
	});

	it("skips without teardown even when the row simply could not be deleted", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);
		activityStubs.permanentDeleteOrganizationFromDbActivity.mockResolvedValue(
			{ success: false },
		);

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.organizationsDeleted).toBe(0);
		expectNoTeardown();
	});

	it("tears down vectors, objects and billing after a successful database delete", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);
		activityStubs.captureOrganizationSubscriptionIdsActivity.mockResolvedValue(
			{ subscriptionIds: ["sub_example"] },
		);

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.organizationsDeleted).toBe(1);
		expect(out.success).toBe(true);

		expect(
			activityStubs.deleteOrganizationVectorsActivity,
		).toHaveBeenCalledWith({ organizationId: "org-1" });
		expect(
			activityStubs.deleteOrganizationObjectsFromStorageActivity,
		).toHaveBeenCalledWith({ organizationId: "org-1" });
		expect(
			activityStubs.cancelOrganizationSubscriptionsActivity,
		).toHaveBeenCalledWith({
			organizationId: "org-1",
			subscriptionIds: ["sub_example"],
		});
	});

	/**
	 * The subscription ids have to be lifted out before the cascade removes the
	 * purchase rows that carry them, so the capture must precede the delete.
	 * Ordering, not just presence — reading them afterwards returns nothing and
	 * bills a destroyed tenant forever.
	 */
	it("captures subscription ids before the delete, not after", async () => {
		const order: string[] = [];
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);
		activityStubs.captureOrganizationSubscriptionIdsActivity.mockImplementation(
			async () => {
				order.push("capture");
				return { subscriptionIds: ["sub_example"] };
			},
		);
		activityStubs.permanentDeleteOrganizationFromDbActivity.mockImplementation(
			async () => {
				order.push("delete");
				return { success: true };
			},
		);
		activityStubs.cancelOrganizationSubscriptionsActivity.mockImplementation(
			async () => {
				order.push("cancel");
				return { cancelled: 1, failed: [] };
			},
		);

		await organizationDeleteCleanupWorkflow();

		expect(order).toEqual(["capture", "delete", "cancel"]);
	});

	it("does not call the payment provider when there is nothing to cancel", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);

		await organizationDeleteCleanupWorkflow();

		expect(
			activityStubs.cancelOrganizationSubscriptionsActivity,
		).not.toHaveBeenCalled();
	});

	/**
	 * None of the teardown steps can be retried by a later sweep — the row that
	 * would put this organization back in the batch is gone. So a failure in one
	 * must not swallow the two behind it, and must not un-count the delete that
	 * did happen.
	 */
	it("continues teardown when the vector step fails", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);
		activityStubs.captureOrganizationSubscriptionIdsActivity.mockResolvedValue(
			{ subscriptionIds: ["sub_example"] },
		);
		activityStubs.deleteOrganizationVectorsActivity.mockResolvedValue({
			success: false,
			error: "qdrant unreachable",
		});

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.organizationsDeleted).toBe(1);
		expect(out.success).toBe(true);
		expect(
			activityStubs.deleteOrganizationObjectsFromStorageActivity,
		).toHaveBeenCalled();
		expect(
			activityStubs.cancelOrganizationSubscriptionsActivity,
		).toHaveBeenCalled();
	});

	it("continues to billing when the storage sweep throws past its retries", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg(),
		]);
		activityStubs.captureOrganizationSubscriptionIdsActivity.mockResolvedValue(
			{ subscriptionIds: ["sub_example"] },
		);
		activityStubs.deleteOrganizationObjectsFromStorageActivity.mockRejectedValue(
			new Error("bucket unreachable"),
		);

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.organizationsDeleted).toBe(1);
		expect(out.failedOrganizationIds).toEqual([]);
		expect(
			activityStubs.cancelOrganizationSubscriptionsActivity,
		).toHaveBeenCalled();
	});

	it("records a genuine failure without stranding the rest of the batch", async () => {
		activityStubs.getExpiredOrganizationsActivity.mockResolvedValue([
			expiredOrg({ id: "org-1" }),
			expiredOrg({ id: "org-2" }),
		]);
		activityStubs.permanentDeleteOrganizationFromDbActivity
			.mockRejectedValueOnce(new Error("connection reset"))
			.mockResolvedValueOnce({ success: true });

		const out = await organizationDeleteCleanupWorkflow();

		expect(out.failedOrganizationIds).toEqual(["org-1"]);
		expect(out.organizationsDeleted).toBe(1);
		expect(out.success).toBe(false);
	});
});
