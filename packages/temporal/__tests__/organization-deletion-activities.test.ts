/**
 * The organization purge activities (Fizzy #2462).
 *
 * The workflow test next door proves the sweep's control flow. This one proves
 * the three decisions the workflow cannot see because they happen inside an
 * activity:
 *
 *   - `deletionReminderSentAt` is stamped ONLY when a message was actually
 *     accepted. `sendEmail` returns `false` for a render or provider failure
 *     rather than throwing, so an unconditional stamp would spend the single
 *     warning an organization ever gets on a mail nobody received.
 *   - P2025 from the guarded delete is DISAMBIGUATED rather than assumed. Under
 *     `deletedAt: { not: null }` it fires both for "restored" and for "already
 *     gone", and the two want opposite answers.
 *   - The object sweep refuses to run against an organization that still exists,
 *     and covers every org-scoped key including the logo.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	user: { findUnique: vi.fn() },
	organization: { findUnique: vi.fn() },
}));

const queryMocks = vi.hoisted(() => ({
	getOrganizationsNeedingPurgeReminder: vi.fn(),
	getOrganizationsReadyForPurge: vi.fn(),
	getPurchasesByOrganizationId: vi.fn(),
	markOrganizationPurgeReminderSent: vi.fn(),
	permanentDeleteOrganization: vi.fn(),
}));

const sendEmail = vi.hoisted(() => vi.fn());
const cancelSubscription = vi.hoisted(() => vi.fn());
const deleteOrganizationCollections = vi.hoisted(() => vi.fn());
const storageMocks = vi.hoisted(() => ({
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: dbMock,
	ORGANIZATION_RETENTION_DAYS: 7,
	...queryMocks,
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/mail", () => ({ sendEmail }));
vi.mock("@repo/payments", () => ({ cancelSubscription }));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	deleteOrganizationCollections,
}));
vi.mock("@repo/storage", () => storageMocks);
vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://example.com",
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: {
			bucketNames: {
				avatars: "avatars",
				chatDocuments: "chat-documents",
				qaRunEvidence: "qa-run-evidence",
			},
		},
	},
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {
		throw new Error("not in an activity context");
	},
}));

import {
	cancelOrganizationSubscriptionsActivity,
	captureOrganizationSubscriptionIdsActivity,
	deleteOrganizationObjectsFromStorageActivity,
	deleteOrganizationVectorsActivity,
	getOrganizationsNeedingPurgeReminderActivity,
	permanentDeleteOrganizationFromDbActivity,
	sendOrganizationDeletionReminderActivity,
} from "../src/activities/organization-deletion";

const PURGE_AT = "2098-03-14T00:00:00.000Z";

const reminderInput = (over: Record<string, unknown> = {}) => ({
	organizationId: "org-1",
	organizationName: "Example Org",
	owners: [{ id: "user-1", email: "owner@example.com" }],
	scheduledPermanentDeleteAt: PURGE_AT,
	...over,
});

/** Prisma's "record to update/delete not found", which the guard produces. */
function prismaNotFound() {
	return Object.assign(new Error("An operation failed"), { code: "P2025" });
}

function emptyBucket() {
	storageMocks.listObjects.mockResolvedValue({
		objects: [],
		nextContinuationToken: undefined,
	});
}

beforeEach(() => {
	for (const stub of [
		dbMock.user.findUnique,
		dbMock.organization.findUnique,
		...Object.values(queryMocks),
		sendEmail,
		cancelSubscription,
		deleteOrganizationCollections,
		...Object.values(storageMocks),
	]) {
		stub.mockReset();
	}

	dbMock.organization.findUnique.mockResolvedValue(null);
	storageMocks.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
	emptyBucket();
});

describe("getOrganizationsNeedingPurgeReminderActivity", () => {
	/**
	 * The date leaves the database as a `Date` and must leave the activity as an
	 * ISO string: Temporal's converter is JSON, so a `Date` in an activity result
	 * arrives at the workflow as a string wearing a `Date` type, and
	 * `toLocaleString` on a string silently returns the string.
	 */
	it("flattens the purge date to an ISO string", async () => {
		queryMocks.getOrganizationsNeedingPurgeReminder.mockResolvedValue([
			{
				id: "org-1",
				name: "Example Org",
				deletedBy: "user-1",
				owners: [{ id: "user-1", email: "owner@example.com" }],
				scheduledPermanentDeleteAt: new Date(PURGE_AT),
			},
		]);

		const rows = await getOrganizationsNeedingPurgeReminderActivity({});

		expect(rows).toEqual([
			{
				id: "org-1",
				name: "Example Org",
				deletedBy: "user-1",
				owners: [{ id: "user-1", email: "owner@example.com" }],
				scheduledPermanentDeleteAt: PURGE_AT,
			},
		]);
	});
});

describe("sendOrganizationDeletionReminderActivity", () => {
	it("stamps deletionReminderSentAt once the provider accepts the message", async () => {
		sendEmail.mockResolvedValue(true);

		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput(),
		);

		expect(result).toEqual({ sent: true });
		expect(
			queryMocks.markOrganizationPurgeReminderSent,
		).toHaveBeenCalledWith("org-1");

		const [call] = sendEmail.mock.calls;
		expect(call[0].to).toBe("owner@example.com");
		expect(call[0].templateId).toBe("organizationDeletionReminder");
		// Per organization AND per recipient: a retried attempt cannot send the
		// same owner twice, while a pass that missed an owner can still reach
		// them.
		expect(call[0].idempotencyKey).toBe(
			"org-deletion-reminder-org-1-user-1",
		);
		// The page that actually renders the restore banner — not an invented
		// route that would 404 on the one click this mail exists to produce.
		expect(call[0].context.restoreUrl).toBe(
			"https://example.com/new-organization",
		);
		expect(call[0].context.retentionDays).toBe(7);
		// Localised here, on the last hop that still holds a real Date — never
		// the raw ISO text the workflow passed in.
		expect(call[0].context.purgeDate).not.toBe(PURGE_AT);
		expect(call[0].context.purgeDate).toContain("2098");
	});

	/**
	 * The whole reason the stamp is conditional. `sendEmail` reports a render or
	 * provider failure by returning false, not by throwing.
	 */
	it("does NOT stamp when the provider refuses the message", async () => {
		sendEmail.mockResolvedValue(false);

		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput(),
		);

		expect(result.sent).toBe(false);
		expect(
			queryMocks.markOrganizationPurgeReminderSent,
		).not.toHaveBeenCalled();
	});

	it("does NOT stamp when there is nobody to warn", async () => {
		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput({ owners: [] }),
		);

		expect(result.sent).toBe(false);
		expect(sendEmail).not.toHaveBeenCalled();
		expect(
			queryMocks.markOrganizationPurgeReminderSent,
		).not.toHaveBeenCalled();
	});

	it("warns EVERY owner, not just whoever pressed the button", async () => {
		// Restoring is gated by the same permission as deleting, so an owner is
		// exactly the set of people who can act on this warning.
		sendEmail.mockResolvedValue(true);

		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput({
				owners: [
					{ id: "user-1", email: "owner@example.com" },
					{ id: "user-2", email: "second@example.com" },
				],
			}),
		);

		expect(result).toEqual({ sent: true });
		expect(sendEmail).toHaveBeenCalledTimes(2);
		expect(sendEmail.mock.calls.map((call) => call[0].to)).toEqual([
			"owner@example.com",
			"second@example.com",
		]);
	});

	/**
	 * The stamp is all-or-nothing because the column cannot record "four of five
	 * owners". Leaving it null costs the owners who succeeded a duplicate on the
	 * next sweep; stamping it would cost the one who failed their only warning,
	 * which is the failure the feature exists to prevent.
	 */
	it("does NOT stamp when only some owners were reached", async () => {
		sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput({
				owners: [
					{ id: "user-1", email: "owner@example.com" },
					{ id: "user-2", email: "second@example.com" },
				],
			}),
		);

		expect(result.sent).toBe(false);
		expect(
			queryMocks.markOrganizationPurgeReminderSent,
		).not.toHaveBeenCalled();
	});

	it("does NOT stamp when an owner has no address on file", async () => {
		sendEmail.mockResolvedValue(true);

		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput({
				owners: [{ id: "user-1", email: null }],
			}),
		);

		expect(result.sent).toBe(false);
		expect(
			queryMocks.markOrganizationPurgeReminderSent,
		).not.toHaveBeenCalled();
	});

	it("reports a thrown send as unsent rather than propagating it", async () => {
		sendEmail.mockRejectedValue(new Error("provider exploded"));

		const result = await sendOrganizationDeletionReminderActivity(
			reminderInput(),
		);

		expect(result).toEqual({ sent: false, error: "provider exploded" });
		expect(
			queryMocks.markOrganizationPurgeReminderSent,
		).not.toHaveBeenCalled();
	});
});

describe("permanentDeleteOrganizationFromDbActivity", () => {
	it("reports success when the guarded delete removed the row", async () => {
		queryMocks.permanentDeleteOrganization.mockResolvedValue({
			id: "org-1",
		});

		const result = await permanentDeleteOrganizationFromDbActivity({
			organizationId: "org-1",
		});

		expect(result).toEqual({ success: true });
	});

	/**
	 * THE GUARD, at its source. P2025 with the row still present means the
	 * `deletedAt: { not: null }` clause rejected a live organization — somebody
	 * restored it. Reporting success here (which is what the project version
	 * does) would hand the caller a licence to delete a live tenant's vectors.
	 */
	it("reports a restored organization as a skip, not a success", async () => {
		queryMocks.permanentDeleteOrganization.mockRejectedValue(
			prismaNotFound(),
		);
		dbMock.organization.findUnique.mockResolvedValue({ id: "org-1" });

		const result = await permanentDeleteOrganizationFromDbActivity({
			organizationId: "org-1",
		});

		expect(result.success).toBe(false);
		expect(result.restored).toBe(true);
	});

	/**
	 * The same error code with NO row is the retry case: a previous attempt
	 * deleted it and lost its response. Reporting failure would strand the
	 * external teardown, which nothing else would ever retry.
	 */
	it("reports an already-destroyed organization as success so teardown still runs", async () => {
		queryMocks.permanentDeleteOrganization.mockRejectedValue(
			prismaNotFound(),
		);
		dbMock.organization.findUnique.mockResolvedValue(null);

		const result = await permanentDeleteOrganizationFromDbActivity({
			organizationId: "org-1",
		});

		expect(result).toEqual({ success: true });
	});

	it("rethrows a transient failure so Temporal retries it", async () => {
		queryMocks.permanentDeleteOrganization.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			permanentDeleteOrganizationFromDbActivity({
				organizationId: "org-1",
			}),
		).rejects.toThrow("connection reset");
	});
});

describe("deleteOrganizationVectorsActivity", () => {
	it("drops the organization's collections", async () => {
		deleteOrganizationCollections.mockResolvedValue(undefined);

		const result = await deleteOrganizationVectorsActivity({
			organizationId: "org-1",
		});

		expect(result).toEqual({ success: true });
		expect(deleteOrganizationCollections).toHaveBeenCalledWith("org-1");
	});

	it("refuses to touch an organization whose row still exists", async () => {
		dbMock.organization.findUnique.mockResolvedValue({ id: "org-1" });

		const result = await deleteOrganizationVectorsActivity({
			organizationId: "org-1",
		});

		expect(result).toEqual({ success: true });
		expect(deleteOrganizationCollections).not.toHaveBeenCalled();
	});

	it("surfaces a total failure rather than throwing", async () => {
		deleteOrganizationCollections.mockRejectedValue(
			new Error("Invalid organization ID format: org-1"),
		);

		const result = await deleteOrganizationVectorsActivity({
			organizationId: "org-1",
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Invalid organization ID format");
	});
});

describe("deleteOrganizationObjectsFromStorageActivity", () => {
	it("sweeps every org-scoped prefix and the logo object", async () => {
		storageMocks.listObjects.mockResolvedValue({
			objects: [{ key: "org-1/workspace-files/a.md" }],
			nextContinuationToken: undefined,
		});
		storageMocks.deleteObjects.mockResolvedValue({
			deleted: 1,
			errors: [],
		});

		const result = await deleteOrganizationObjectsFromStorageActivity({
			organizationId: "org-1",
		});

		// Two prefix sweeps, one page each.
		expect(result.pages).toBe(2);
		expect(storageMocks.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: "chat-documents",
				prefix: "org-1/",
			}),
		);
		expect(storageMocks.listObjects).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: "qa-run-evidence",
				prefix: "org-1/",
			}),
		);
		// The logo is one known key, not a prefix.
		expect(storageMocks.deleteObjects).toHaveBeenCalledWith(["org-1.png"], {
			bucket: "avatars",
		});
	});

	it("refuses to touch an organization whose row still exists", async () => {
		dbMock.organization.findUnique.mockResolvedValue({ id: "org-1" });

		const result = await deleteOrganizationObjectsFromStorageActivity({
			organizationId: "org-1",
		});

		expect(result).toEqual({ deleted: 0, pages: 0 });
		expect(storageMocks.listObjects).not.toHaveBeenCalled();
		expect(storageMocks.deleteObjects).not.toHaveBeenCalled();
	});

	/**
	 * Residual errors throw so Temporal retries the whole sweep. Returning a
	 * partial count would report a cleanup nobody performed, and there is no
	 * later run that would rediscover the objects.
	 */
	it("throws when objects are left behind", async () => {
		storageMocks.listObjects.mockResolvedValue({
			objects: [{ key: "org-1/workspace-files/a.md" }],
			nextContinuationToken: undefined,
		});
		storageMocks.deleteObjects.mockResolvedValue({
			deleted: 0,
			errors: [{ key: "org-1/workspace-files/a.md", message: "denied" }],
		});

		await expect(
			deleteOrganizationObjectsFromStorageActivity({
				organizationId: "org-1",
			}),
		).rejects.toThrow("storage cleanup failed");
	});
});

describe("subscription teardown", () => {
	/**
	 * `Purchase.organizationId` is `onDelete: Cascade`, so this read only ever
	 * returns anything BEFORE the purge. Capturing here is what makes the
	 * cancellation possible at all.
	 */
	it("captures only real subscription ids", async () => {
		queryMocks.getPurchasesByOrganizationId.mockResolvedValue([
			{ type: "SUBSCRIPTION", subscriptionId: "sub_example" },
			{ type: "SUBSCRIPTION", subscriptionId: null },
			{ type: "ONE_TIME", subscriptionId: "sub_not_a_subscription" },
		]);

		const result = await captureOrganizationSubscriptionIdsActivity({
			organizationId: "org-1",
		});

		expect(result).toEqual({ subscriptionIds: ["sub_example"] });
	});

	it("cancels each captured subscription and collects the refusals", async () => {
		cancelSubscription
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("no such subscription"));

		const result = await cancelOrganizationSubscriptionsActivity({
			organizationId: "org-1",
			subscriptionIds: ["sub_example", "sub_gone"],
		});

		expect(result).toEqual({ cancelled: 1, failed: ["sub_gone"] });
	});
});
