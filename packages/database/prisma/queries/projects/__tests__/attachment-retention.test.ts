import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindMany: vi.fn(),
	projectAggregate: vi.fn(),
	organizationAggregate: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		project: {
			findMany: (...a: unknown[]) => mocks.projectFindMany(...a),
			aggregate: (...a: unknown[]) => mocks.projectAggregate(...a),
		},
		organization: {
			aggregate: (...a: unknown[]) => mocks.organizationAggregate(...a),
		},
	},
}));

import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
} from "@repo/utils/attachment";
import {
	getMinimumAttachmentRetentionOverride,
	resolveAttachmentRetentionOverrides,
} from "../attachment-retention";

const CHANGED = new Date("2026-08-01T00:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	// `clearAllMocks` clears call history but NOT implementations, so without an
	// explicit default here a test that never sets `projectFindMany` would pass
	// only by inheriting the previous test's `mockResolvedValue` — and fail when
	// run in isolation with `-t`.
	mocks.projectFindMany.mockResolvedValue([]);
	mocks.projectAggregate.mockResolvedValue({
		_min: { attachmentRetentionDays: null },
	});
	mocks.organizationAggregate.mockResolvedValue({
		_min: { attachmentRetentionDays: null },
	});
});

describe("resolveAttachmentRetentionOverrides", () => {
	it("prefers the project override over the organization's", async () => {
		mocks.projectFindMany.mockResolvedValue([
			{
				id: "p1",
				attachmentRetentionDays: 120,
				attachmentRetentionDaysUpdatedAt: CHANGED,
				organization: {
					attachmentRetentionDays: 365,
					attachmentRetentionDaysUpdatedAt: null,
				},
			},
		]);
		const map = await resolveAttachmentRetentionOverrides(["p1"]);
		expect(map.get("p1")).toEqual({ days: 120, settingChangedAt: CHANGED });
	});

	it("inherits the organization override when the project has none", async () => {
		mocks.projectFindMany.mockResolvedValue([
			{
				id: "p1",
				attachmentRetentionDays: null,
				attachmentRetentionDaysUpdatedAt: null,
				organization: {
					attachmentRetentionDays: 365,
					attachmentRetentionDaysUpdatedAt: CHANGED,
				},
			},
		]);
		const map = await resolveAttachmentRetentionOverrides(["p1"]);
		expect(map.get("p1")).toEqual({ days: 365, settingChangedAt: CHANGED });
	});

	it("returns days null for a personal project with no override", async () => {
		mocks.projectFindMany.mockResolvedValue([
			{
				id: "p1",
				attachmentRetentionDays: null,
				attachmentRetentionDaysUpdatedAt: null,
				organization: null,
			},
		]);
		const map = await resolveAttachmentRetentionOverrides(["p1"]);
		expect(map.get("p1")).toEqual({ days: null, settingChangedAt: null });
	});

	it("returns a TOTAL map: every requested id is present", async () => {
		// A missing key must mean "could not resolve", never "no override" —
		// the purge skips rows it cannot resolve rather than defaulting them,
		// and that distinction is only possible if the map is total.
		mocks.projectFindMany.mockResolvedValue([
			{
				id: "p1",
				attachmentRetentionDays: null,
				attachmentRetentionDaysUpdatedAt: null,
				organization: null,
			},
		]);
		const map = await resolveAttachmentRetentionOverrides(["p1", "gone"]);
		expect(map.has("p1")).toBe(true);
		expect(map.has("gone")).toBe(false);
		expect(map.size).toBe(1);
	});

	it("does NOT filter out soft-deleted projects", async () => {
		// A soft-deleted project is restorable for 7 days and its attachments
		// survive. Excluding it here would silently revert its window to the
		// server default and purge a backlog that is still recoverable.
		await resolveAttachmentRetentionOverrides(["p1"]);
		const where = mocks.projectFindMany.mock.calls[0][0].where;
		expect(where).toEqual({ id: { in: ["p1"] } });
		expect(where).not.toHaveProperty("deletedAt");
	});

	it("short-circuits on an empty id list", async () => {
		const map = await resolveAttachmentRetentionOverrides([]);
		expect(map.size).toBe(0);
		expect(mocks.projectFindMany).not.toHaveBeenCalled();
	});
});

describe("getMinimumAttachmentRetentionOverride", () => {
	it("returns null when nothing is overridden", async () => {
		await expect(
			getMinimumAttachmentRetentionOverride(),
		).resolves.toBeNull();
	});

	it("returns the smaller of the project and organization minima", async () => {
		mocks.projectAggregate.mockResolvedValue({
			_min: { attachmentRetentionDays: 200 },
		});
		mocks.organizationAggregate.mockResolvedValue({
			_min: { attachmentRetentionDays: 60 },
		});
		await expect(getMinimumAttachmentRetentionOverride()).resolves.toBe(60);
	});

	it("restricts both aggregates to the usable range", async () => {
		// This is what makes the purge's scan-bound proof hold: an unusable
		// stored value resolves to the SERVER DEFAULT at filter time, so it
		// must not contribute to the minimum. If it did, one bad row anywhere
		// would distort the scan bound for the entire deployment.
		await getMinimumAttachmentRetentionOverride();
		const expected = {
			attachmentRetentionDays: {
				gte: MIN_ATTACHMENT_RETENTION_DAYS,
				lte: MAX_ATTACHMENT_RETENTION_DAYS,
			},
		};
		expect(mocks.projectAggregate.mock.calls[0][0].where).toEqual(expected);
		expect(mocks.organizationAggregate.mock.calls[0][0].where).toEqual(
			expected,
		);
	});
});
