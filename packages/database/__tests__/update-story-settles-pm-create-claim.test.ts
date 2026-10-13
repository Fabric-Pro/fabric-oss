/**
 * `updateStory` with `settlesPmCreateClaim`: the PM link write after a create
 * lands only while the row still holds that create claim, and clears the
 * claim in the same UPDATE (Fizzy #3045). With `onlyIfPmLink`: a confirmed
 * migration drops a stamped link only while the row still carries it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	userStory: {
		findUnique: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		aggregate: vi.fn(),
	},
	featureVersion: { upsert: vi.fn(), createMany: vi.fn() },
	pmTicketMissingStreak: { deleteMany: vi.fn() },
	pendingPmStateChange: { updateMany: vi.fn() },
}));
vi.mock("../prisma/client", () => ({
	db: { $transaction: vi.fn(async (fn: any) => fn(tx)) },
}));

import {
	PmCreateClaimNotHeldError,
	StoryLinkChangedError,
	StoryVersionConflictError,
	updateStory,
} from "../prisma/queries/projects/stories";

const link = {
	externalId: "1075",
	externalUrl: "https://pm.example.com/1075",
	externalMcpServerId: "srv-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	tx.userStory.findUnique.mockResolvedValue({
		version: 1,
		updatedAt: new Date("2026-08-10T10:00:00.000Z"),
		description: "d",
		acceptanceCriteria: "a",
		draftingStage: "DRAFT",
		priority: "MEDIUM",
		roadmapOrder: 1,
		externalId: null,
		externalMcpServerId: null,
	});
	tx.userStory.updateMany.mockResolvedValue({ count: 1 });
});

describe("updateStory settlesPmCreateClaim", () => {
	it("scopes the link write to the claim and clears it in the same UPDATE", async () => {
		await updateStory("s1", "p1", link, {
			lastEditedSource: "PM_PULL",
			settlesPmCreateClaim: "claim-1",
		});

		expect(tx.userStory.updateMany).toHaveBeenCalledTimes(1);
		const [{ where, data }] = tx.userStory.updateMany.mock.calls[0];
		expect(where).toMatchObject({
			id: "s1",
			projectId: "p1",
			pmCreateClaimId: "claim-1",
		});
		expect(data).toMatchObject({
			...link,
			pmCreateClaimId: null,
			pmCreateClaimedAt: null,
		});
	});

	it("writes nothing and throws PmCreateClaimNotHeldError when the row no longer holds the claim", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			updateStory("s1", "p1", link, {
				lastEditedSource: "PM_PULL",
				settlesPmCreateClaim: "claim-1",
			}),
		).rejects.toBeInstanceOf(PmCreateClaimNotHeldError);
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});

	it("a write without it neither scopes to nor clears a claim (unchanged)", async () => {
		await updateStory("s1", "p1", link, { lastEditedSource: "PM_PULL" });

		const [{ where, data }] = tx.userStory.updateMany.mock.calls[0];
		expect(where).not.toHaveProperty("pmCreateClaimId");
		expect(data).not.toHaveProperty("pmCreateClaimId");
		expect(data).not.toHaveProperty("pmCreateClaimedAt");
	});

	it("a write without it still reports a lost race as a version conflict", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			updateStory("s1", "p1", link, { lastEditedSource: "PM_PULL" }),
		).rejects.toBeInstanceOf(StoryVersionConflictError);
	});
});

describe("updateStory onlyIfPmLink", () => {
	const clear = {
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
	};
	const readLink = { externalId: "77", externalMcpServerId: "srv-old" };

	beforeEach(() => {
		tx.userStory.findUnique.mockResolvedValue({
			version: 1,
			updatedAt: new Date("2026-08-10T10:00:00.000Z"),
			externalId: "77",
			externalMcpServerId: "srv-old",
		});
	});

	it("clears a link only while the row still carries that id and server stamp, and leaves the claim alone", async () => {
		await updateStory("s1", "p1", clear, {
			lastEditedSource: "PM_PULL",
			onlyIfPmLink: readLink,
		});

		const [{ where, data }] = tx.userStory.updateMany.mock.calls[0];
		expect(where).toMatchObject({
			id: "s1",
			projectId: "p1",
			externalId: "77",
			externalMcpServerId: "srv-old",
		});
		expect(data).toMatchObject(clear);
		expect(data).not.toHaveProperty("pmCreateClaimId");
		expect(where).not.toHaveProperty("pmCreateClaimId");
	});

	it("writes nothing and throws StoryLinkChangedError when the link changed", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			updateStory("s1", "p1", clear, {
				lastEditedSource: "PM_PULL",
				onlyIfPmLink: readLink,
			}),
		).rejects.toBeInstanceOf(StoryLinkChangedError);
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});

	it("a scoped write that also carries a versioned edit reports a miss as its scope", async () => {
		tx.userStory.findUnique.mockResolvedValue({
			version: 3,
			updatedAt: new Date("2026-08-10T10:00:00.000Z"),
			description: "old",
			externalId: "77",
			externalMcpServerId: "srv-old",
		});
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			updateStory(
				"s1",
				"p1",
				{ ...clear, description: "new" },
				{
					lastEditedSource: "MANUAL",
					onlyIfPmLink: readLink,
				},
			),
		).rejects.toBeInstanceOf(StoryLinkChangedError);
		const [{ where }] = tx.userStory.updateMany.mock.calls[0];
		expect(where).toMatchObject({
			version: 3,
			externalId: "77",
			externalMcpServerId: "srv-old",
		});
		expect(tx.featureVersion.createMany).not.toHaveBeenCalled();
	});
});
