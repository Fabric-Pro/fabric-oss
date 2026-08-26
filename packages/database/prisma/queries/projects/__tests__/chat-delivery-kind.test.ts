/**
 * Fizzy #2203 — the kind discriminator must PARTITION the chat-delivery ledger.
 *
 * Each test here is a regression guard for a silent-corruption bug, not a
 * feature check. Verify each one fails when its kind filter is removed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMany = vi.fn();
const create = vi.fn();
const findMany = vi.fn();

vi.mock("../../../client", () => ({
	db: { newsletterChatDelivery: { create, updateMany, findMany } },
}));

const {
	claimChatDelivery,
	listChatDeliveriesForProjectSend,
	listChatDeliveriesForSend,
	markChatDelivery,
} = await import("../newsletter");

const target = {
	sendId: "send-1",
	platform: "SLACK" as const,
	externalTeamId: "T-example",
	channelId: "C-example",
};

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue({});
	updateMany.mockResolvedValue({ count: 1 });
	findMany.mockResolvedValue([]);
});

describe("chat delivery ledger partitioning by kind", () => {
	it("claim writes the kind onto the row", async () => {
		await claimChatDelivery({
			...target,
			projectId: "p-1",
			organizationId: null,
			userId: null,
			kind: "APPROVAL",
		});
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ kind: "APPROVAL" }),
			}),
		);
	});

	it("mark scopes its updateMany by kind, so an APPROVAL mark cannot flip the CONTENT row", async () => {
		await markChatDelivery({
			...target,
			kind: "APPROVAL",
			status: "FAILED",
		});
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ kind: "APPROVAL" }),
			}),
		);
	});

	it("the send read-back filters by kind, so approval rows cannot inflate the content delivery counts", async () => {
		await listChatDeliveriesForSend("send-1", "CONTENT");
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ kind: "CONTENT" }),
			}),
		);
	});

	// The panel's sort must cover the ledger's full identity, and `kind` joined
	// that identity in this change. LAST in the array, so the existing
	// channel-major grouping is untouched and only the two-kinds-one-channel tie
	// is broken — a tie that became reachable when the legacy index was dropped.
	it("the project read-back breaks the two-kinds-one-channel tie, without disturbing the channel grouping", async () => {
		await listChatDeliveriesForProjectSend("send-1", "p-1");
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				orderBy: [
					{ platform: "asc" },
					{ externalTeamId: "asc" },
					{ channelId: "asc" },
					{ kind: "asc" },
				],
			}),
		);
	});
});
