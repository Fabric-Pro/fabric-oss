import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	organizationFindUnique: vi.fn(),
	organizationUpdate: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		organization: {
			findUnique: (...a: unknown[]) => mocks.organizationFindUnique(...a),
			update: (...a: unknown[]) => mocks.organizationUpdate(...a),
		},
	},
}));

import {
	getOrganizationAttachmentRetention,
	updateOrganizationAttachmentRetention,
} from "../attachment-retention";

const CHANGED = new Date("2026-08-01T00:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	// `clearAllMocks` clears call history but NOT implementations, so an
	// explicit default here stops a test from passing only by inheriting the
	// previous test's `mockResolvedValue`.
	mocks.organizationFindUnique.mockResolvedValue(null);
	mocks.organizationUpdate.mockResolvedValue({
		attachmentRetentionDays: null,
	});
});

describe("getOrganizationAttachmentRetention", () => {
	it("returns the stored value and its change timestamp", async () => {
		mocks.organizationFindUnique.mockResolvedValue({
			attachmentRetentionDays: 365,
			attachmentRetentionDaysUpdatedAt: CHANGED,
		});
		await expect(getOrganizationAttachmentRetention("o1")).resolves.toEqual(
			{
				attachmentRetentionDays: 365,
				attachmentRetentionDaysUpdatedAt: CHANGED,
			},
		);
	});

	it("normalises a missing organization to nulls rather than undefined", async () => {
		// The caller feeds this straight into an oRPC output contract of
		// `number | null`; `undefined` would fail validation at the boundary
		// instead of reading as "no override".
		await expect(
			getOrganizationAttachmentRetention("gone"),
		).resolves.toEqual({
			attachmentRetentionDays: null,
			attachmentRetentionDaysUpdatedAt: null,
		});
	});
});

describe("updateOrganizationAttachmentRetention", () => {
	it("stamps the change timestamp when the value actually changes", async () => {
		mocks.organizationFindUnique.mockResolvedValue({
			attachmentRetentionDays: null,
		});
		mocks.organizationUpdate.mockResolvedValue({
			attachmentRetentionDays: 180,
		});

		await updateOrganizationAttachmentRetention({
			organizationId: "o1",
			attachmentRetentionDays: 180,
		});

		expect(mocks.organizationUpdate).toHaveBeenCalledWith({
			where: { id: "o1" },
			data: {
				attachmentRetentionDays: 180,
				attachmentRetentionDaysUpdatedAt: expect.any(Date),
			},
			select: { attachmentRetentionDays: true },
		});
	});

	it("does NOT stamp the timestamp on a no-op save", async () => {
		// Re-arming the grace floor on every save would postpone every pending
		// purge indefinitely for every project inheriting this organization.
		mocks.organizationFindUnique.mockResolvedValue({
			attachmentRetentionDays: 180,
		});
		mocks.organizationUpdate.mockResolvedValue({
			attachmentRetentionDays: 180,
		});

		await updateOrganizationAttachmentRetention({
			organizationId: "o1",
			attachmentRetentionDays: 180,
		});

		const data = mocks.organizationUpdate.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("attachmentRetentionDaysUpdatedAt");
		expect(data.attachmentRetentionDays).toBe(180);
	});

	it("stamps when an existing override is cleared", async () => {
		mocks.organizationFindUnique.mockResolvedValue({
			attachmentRetentionDays: 180,
		});

		await updateOrganizationAttachmentRetention({
			organizationId: "o1",
			attachmentRetentionDays: null,
		});

		const data = mocks.organizationUpdate.mock.calls[0][0].data;
		expect(data.attachmentRetentionDays).toBeNull();
		expect(data.attachmentRetentionDaysUpdatedAt).toBeInstanceOf(Date);
	});

	it("does NOT stamp when a row with no override is cleared again", async () => {
		// `findUnique` is nullable, and a row that simply has no override reads
		// as null. Comparing without normalising would make `null !== undefined`
		// true for a missing row and re-arm the floor for a write that changed
		// nothing.
		mocks.organizationFindUnique.mockResolvedValue(null);

		await updateOrganizationAttachmentRetention({
			organizationId: "o1",
			attachmentRetentionDays: null,
		});

		const data = mocks.organizationUpdate.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("attachmentRetentionDaysUpdatedAt");
	});

	it("returns what was persisted, not what was requested", async () => {
		mocks.organizationFindUnique.mockResolvedValue({
			attachmentRetentionDays: null,
		});
		mocks.organizationUpdate.mockResolvedValue({
			attachmentRetentionDays: 365,
		});

		await expect(
			updateOrganizationAttachmentRetention({
				organizationId: "o1",
				attachmentRetentionDays: 365,
			}),
		).resolves.toEqual({ attachmentRetentionDays: 365 });
	});
});
