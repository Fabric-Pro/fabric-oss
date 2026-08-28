/**
 * Unit tests for `listConversationBundlesAwaitingEmbedding` — the queue the
 * conversation-bundle recovery sweep drains (Fizzy #2228, U11).
 *
 * Prisma is mocked (no Postgres required). What matters here is the QUERY:
 * which rows the predicate admits, in what order, how many, and which columns
 * come back — none of which a behavioural test against the sweep could pin,
 * because the sweep would look identical while asking for the wrong rows.
 *
 * The predicate is the exact complement of a live lease, and it has to stay the
 * same one `claimConversationBundleForEmbedding` matches on. A listing that
 * admitted rows the claim then refuses would burn a batch slot every run
 * forever; a listing narrower than the claim would leave rows unreachable. The
 * last case below asserts that agreement directly rather than trusting the two
 * to drift together.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindMany, mockUpdateMany } = vi.hoisted(() => ({
	mockFindMany: vi.fn(),
	mockUpdateMany: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectContextConversationBundle: {
			findMany: mockFindMany,
			updateMany: mockUpdateMany,
		},
	},
	Prisma: {},
}));

import {
	CONVERSATION_BUNDLE_EMBEDDING_LEASE_MS,
	CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH,
	claimConversationBundleForEmbedding,
	listConversationBundlesAwaitingEmbedding,
} from "../conversation-bundles";

const NOW = new Date("2026-08-25T12:00:00.000Z");

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "bundle_1",
		parentContextId: "ctx_1",
		projectId: "proj_1",
		content: "## Conversation in #engineering",
		userId: null,
		organizationId: "org_1",
		parentContext: {
			userId: "user_1",
			sourceTitle: null,
			metadata: { provider: "SLACK", title: "#engineering" },
		},
		...overrides,
	};
}

describe("listConversationBundlesAwaitingEmbedding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindMany.mockResolvedValue([]);
		mockUpdateMany.mockResolvedValue({ count: 1 });
	});

	it("asks only for rows with no vector and no live lease", async () => {
		await listConversationBundlesAwaitingEmbedding({ now: NOW });

		const args = mockFindMany.mock.calls[0][0];
		expect(args.where).toEqual({
			embeddedAt: null,
			OR: [
				{ embeddingLeaseAt: null },
				{
					embeddingLeaseAt: {
						lt: new Date(
							NOW.getTime() -
								CONVERSATION_BUNDLE_EMBEDDING_LEASE_MS,
						),
					},
				},
			],
		});
	});

	it("never admits a row that already has a vector", async () => {
		// `embeddedAt` is written ONLY after the vector store confirms, so a
		// non-null value is the one thing that means "there are points for this
		// row". A sweep that re-embedded those would double the provider bill
		// of every run and rewrite points nothing asked it to touch.
		const args = await listConversationBundlesAwaitingEmbedding({
			now: NOW,
		}).then(() => mockFindMany.mock.calls[0][0]);

		expect(args.where.embeddedAt).toBeNull();
		expect(args.where).not.toHaveProperty("embeddedAt.not");
	});

	it("honours a caller's staleness window on both terms of the predicate", async () => {
		await listConversationBundlesAwaitingEmbedding({
			now: NOW,
			leaseMs: 60_000,
		});

		const args = mockFindMany.mock.calls[0][0];
		expect(args.where.OR[1].embeddingLeaseAt.lt).toEqual(
			new Date(NOW.getTime() - 60_000),
		);
	});

	it("agrees with the claim about which leases are live", async () => {
		// Same instant, same window, in both directions. If these two ever
		// disagree the sweep either spins on rows it can never claim or leaves
		// claimable rows unreachable — and neither fails loudly.
		await listConversationBundlesAwaitingEmbedding({
			now: NOW,
			leaseMs: 90_000,
		});
		await claimConversationBundleForEmbedding({
			bundleId: "bundle_1",
			now: NOW,
			leaseMs: 90_000,
		});

		const listed = mockFindMany.mock.calls[0][0].where;
		const claimed = mockUpdateMany.mock.calls[0][0].where;
		expect(claimed.embeddedAt).toEqual(listed.embeddedAt);
		expect(claimed.OR).toEqual(listed.OR);
	});

	it("takes the oldest first, with a total order", async () => {
		await listConversationBundlesAwaitingEmbedding({ now: NOW });

		const args = mockFindMany.mock.calls[0][0];
		// FIFO: the bundle unsearchable longest is the one somebody has most
		// likely already looked for and not found. `id` breaks `createdAt` ties
		// — everything written in one transaction shares a timestamp — so two
		// runs over an unchanged backlog agree on the prefix they take.
		expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
	});

	it("bounds the batch, defaulting to the shared ceiling", async () => {
		await listConversationBundlesAwaitingEmbedding({ now: NOW });
		expect(mockFindMany.mock.calls[0][0].take).toBe(
			CONVERSATION_BUNDLE_EMBEDDING_SWEEP_BATCH,
		);

		await listConversationBundlesAwaitingEmbedding({ now: NOW, limit: 3 });
		expect(mockFindMany.mock.calls[1][0].take).toBe(3);
	});

	it("selects the row's own organizationId, and the parent only to fill the gaps", async () => {
		await listConversationBundlesAwaitingEmbedding({ now: NOW });

		const select = mockFindMany.mock.calls[0][0].select;
		for (const column of [
			"id",
			"parentContextId",
			"projectId",
			"content",
			"userId",
			"organizationId",
		]) {
			expect(select[column]).toBe(true);
		}
		expect(select.parentContext).toEqual({
			select: { userId: true, sourceTitle: true, metadata: true },
		});
	});

	it("widens an organization bundle's tenant with the parent's userId", async () => {
		// The bundle tables enforce the tenant XOR with a CHECK constraint, so
		// an organization bundle has NO userId of its own — but the embedding
		// call and the provider-config lookup both need one. The parent context
		// stores both columns (see `createContext`) and its userId is the
		// person who linked the channel, which is the identity live capture
		// embeds under too.
		mockFindMany.mockResolvedValue([row()]);

		const [bundle] = await listConversationBundlesAwaitingEmbedding({
			now: NOW,
		});

		expect(bundle.userId).toBe("user_1");
		expect(bundle.organizationId).toBe("org_1");
	});

	it("keeps a personal bundle personal", async () => {
		mockFindMany.mockResolvedValue([
			row({
				userId: "user_1",
				organizationId: null,
				parentContext: {
					userId: "user_1",
					sourceTitle: null,
					metadata: { provider: "SLACK", title: "#solo" },
				},
			}),
		]);

		const [bundle] = await listConversationBundlesAwaitingEmbedding({
			now: NOW,
		});

		// Null, not the parent's organization: `organizationId` is what
		// resolves the vector collection, and inheriting one here would file a
		// personal conversation into an organization's collection.
		expect(bundle.organizationId).toBeNull();
		expect(bundle.userId).toBe("user_1");
	});

	it("falls back to the channel metadata title when the parent has no sourceTitle", async () => {
		// Neither channel registrar writes `sourceTitle` — both put the display
		// name in `metadata.title` — so without this fallback every recovered
		// bundle's vector payload would be missing the name the live path wrote.
		mockFindMany.mockResolvedValue([row()]);

		const [bundle] = await listConversationBundlesAwaitingEmbedding({
			now: NOW,
		});

		expect(bundle.sourceTitle).toBe("#engineering");
	});

	it("prefers an explicit sourceTitle, and tolerates metadata that has none", async () => {
		mockFindMany.mockResolvedValue([
			row({
				parentContext: {
					userId: "user_1",
					sourceTitle: "Explicit title",
					metadata: null,
				},
			}),
			row({
				id: "bundle_2",
				parentContext: {
					userId: "user_1",
					sourceTitle: null,
					metadata: "not an object",
				},
			}),
		]);

		const [withTitle, withoutTitle] =
			await listConversationBundlesAwaitingEmbedding({ now: NOW });

		expect(withTitle.sourceTitle).toBe("Explicit title");
		expect(withoutTitle.sourceTitle).toBeNull();
	});
});
