/**
 * Channel-name resolution for Teams channel proposals in the Daily Brief.
 *
 * A first-analysis proposal is found through the thread's seen-message row. A
 * proposal from a revisited thread (late replies analyzed after the first
 * pass) may have no seen row pointing at it — the thread's single row keeps
 * its earlier link — so its channel comes from `sourceMetadata.linkedChannelId`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const proposalFindMany = vi.fn();
const linkedChannelFindMany = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		pendingBacklogProposal: {
			findMany: (...a: unknown[]) => proposalFindMany(...a),
		},
		projectLinkedTeamsChannel: {
			findMany: (...a: unknown[]) => linkedChannelFindMany(...a),
		},
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: () => {},
}));

import { collectTeamsProposals } from "../collect-teams-proposals";

const INPUT = {
	projectId: "p1",
	organizationId: "o1",
	timeWindowStart: "2026-09-27T00:00:00.000Z",
	timeWindowEnd: "2026-09-28T00:00:00.000Z",
};

function row(id: string, channelName: string | null) {
	return {
		id,
		status: "PENDING",
		summary: `summary ${id}`,
		changeCount: 1,
		createdAt: new Date("2026-09-27T12:00:00.000Z"),
		seenMessages:
			channelName === null ? [] : [{ linkedChannel: { channelName } }],
	};
}

beforeEach(() => {
	proposalFindMany.mockReset();
	linkedChannelFindMany.mockReset();
});

describe("collectTeamsProposals — channel name", () => {
	it("falls back to the linked channel in sourceMetadata when no seen row points at the proposal", async () => {
		proposalFindMany
			.mockResolvedValueOnce([
				row("first", "engineering"),
				row("revisit", null),
			])
			.mockResolvedValueOnce([
				{ id: "revisit", sourceMetadata: { linkedChannelId: "lc1" } },
			]);
		linkedChannelFindMany.mockResolvedValue([
			{ id: "lc1", channelName: "support" },
		]);

		const items = await collectTeamsProposals(INPUT);

		expect(items.map((i) => [i.proposalCuid, i.channelName])).toEqual([
			["first", "engineering"],
			["revisit", "support"],
		]);
		expect(items[1].title).toBe(
			"Backlog proposal from #support (1 change)",
		);
		// Only the unlinked proposal is looked up, scoped to Teams channel
		// proposals of this project.
		expect(proposalFindMany.mock.calls[1][0]).toMatchObject({
			where: {
				id: { in: ["revisit"] },
				projectId: "p1",
				source: "TEAMS_CHANNEL",
			},
		});
		expect(linkedChannelFindMany.mock.calls[0][0]).toMatchObject({
			where: { id: { in: ["lc1"] }, projectId: "p1" },
		});
	});

	it("leaves the channel unset for a non-Teams proposal with no seen row", async () => {
		proposalFindMany
			.mockResolvedValueOnce([row("slack", null)])
			// The source filter excludes it from the fallback lookup.
			.mockResolvedValueOnce([]);

		const items = await collectTeamsProposals(INPUT);

		expect(items[0].channelName).toBeUndefined();
		expect(items[0].title).toBe("Backlog proposal (1 change)");
		expect(linkedChannelFindMany).not.toHaveBeenCalled();
	});

	it("issues no fallback query when every proposal resolved through its seen row", async () => {
		proposalFindMany.mockResolvedValueOnce([row("first", "engineering")]);

		await collectTeamsProposals(INPUT);

		expect(proposalFindMany).toHaveBeenCalledTimes(1);
		expect(linkedChannelFindMany).not.toHaveBeenCalled();
	});
});
