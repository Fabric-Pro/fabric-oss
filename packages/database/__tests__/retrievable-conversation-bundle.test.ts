/**
 * `getRetrievableConversationBundleById` / `getCapturedConversationMarkdown`
 * (Fizzy #2228, U12).
 *
 * A captured bundle is embedded under its OWN row id, and that row is not a
 * `ProjectContext` — so a vector hit on it resolves to nothing through the
 * context path, and embedding it would mean writing into a store nothing reads
 * back. These two resolvers are the read side of that.
 *
 * What is pinned here:
 *   - the bundle's stored text comes back in the retrieval envelope shape the
 *     context path returns, so the caller needs no special case;
 *   - the channel's own label / URL / guidance ride along from the pointer row;
 *   - both resolvers apply the tenant XOR filter, so a row id from another
 *     tenant resolves to nothing rather than to its content;
 *   - a bundle whose row is gone resolves to null rather than throwing, which
 *     is the state an unlink leaves behind for as long as its vectors linger.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: {
		projectContextConversationBundle: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
		},
	},
}));

import { db } from "../prisma/client";
import {
	getCapturedConversationMarkdown,
	getRetrievableConversationBundleById,
} from "../prisma/queries/projects/conversation-bundles";

const findFirst = db.projectContextConversationBundle.findFirst as ReturnType<
	typeof vi.fn
>;
const findMany = db.projectContextConversationBundle.findMany as ReturnType<
	typeof vi.fn
>;

/** A bundle row as the resolver selects it, with its channel pointer joined. */
function bundleRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "bundle-1",
		parentContextId: "ctx-channel",
		providerThreadId: "thread-9",
		content:
			"## Conversation in #delivery\n**Ada** (2026-08-01): shipping.",
		messageCount: 2,
		bundleStartedAt: new Date("2026-08-01T09:00:00Z"),
		bundleEndedAt: new Date("2026-08-01T09:30:00Z"),
		createdAt: new Date("2026-08-01T10:00:00Z"),
		parentContext: {
			metadata: { provider: "SLACK", channelId: "C123" },
			sourceUrl: "https://example.com/archives/C123",
			sourceTitle: "#delivery",
			sourceType: "Team channel",
			aiInstructions: "Treat as informal chatter.",
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getRetrievableConversationBundleById", () => {
	it("returns the bundle's stored text in the context retrieval envelope", async () => {
		findFirst.mockResolvedValueOnce(bundleRow());

		const result = await getRetrievableConversationBundleById({
			bundleId: "bundle-1",
			projectId: "proj-1",
			tenant: { userId: "user-1", organizationId: "org-1" },
		});

		expect(result).toMatchObject({
			id: "bundle-1",
			// Labelled with the channel's own type, so the effective-type
			// mapping can turn it into SLACK_CHANNEL from the provider below.
			type: "INTEGRATION",
			content:
				"## Conversation in #delivery\n**Ada** (2026-08-01): shipping.",
			createdAt: new Date("2026-08-01T10:00:00Z"),
			originalFilename: null,
			sourceUrl: "https://example.com/archives/C123",
			sourceTitle: "#delivery",
			sourceType: "Team channel",
			aiInstructions: "Treat as informal chatter.",
		});
		expect(result?.metadata).toMatchObject({
			provider: "SLACK",
			channelId: "C123",
			parentContextId: "ctx-channel",
			conversationBundleId: "bundle-1",
			providerThreadId: "thread-9",
			messageCount: 2,
			bundleStartedAt: "2026-08-01T09:00:00.000Z",
			bundleEndedAt: "2026-08-01T09:30:00.000Z",
		});
	});

	it("scopes an organization read to the organization, never to the caller", async () => {
		findFirst.mockResolvedValueOnce(bundleRow());

		await getRetrievableConversationBundleById({
			bundleId: "bundle-1",
			projectId: "proj-1",
			tenant: { userId: "user-1", organizationId: "org-1" },
		});

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "bundle-1",
					projectId: "proj-1",
					organizationId: "org-1",
				},
			}),
		);
	});

	it("scopes a personal read to the owner AND to a null organization", async () => {
		findFirst.mockResolvedValueOnce(bundleRow({ parentContext: null }));

		await getRetrievableConversationBundleById({
			bundleId: "bundle-1",
			projectId: "proj-1",
			tenant: { userId: "user-1" },
		});

		expect(findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "bundle-1",
					projectId: "proj-1",
					userId: "user-1",
					organizationId: null,
				},
			}),
		);
	});

	it("resolves to null when the tenant filter matches nothing", async () => {
		findFirst.mockResolvedValueOnce(null);

		await expect(
			getRetrievableConversationBundleById({
				bundleId: "bundle-1",
				projectId: "proj-1",
				tenant: { userId: "outsider", organizationId: "org-2" },
			}),
		).resolves.toBeNull();
	});

	it("survives a bundle whose channel pointer carries no label", async () => {
		findFirst.mockResolvedValueOnce(
			bundleRow({
				parentContext: {
					metadata: null,
					sourceUrl: null,
					sourceTitle: null,
					sourceType: null,
					aiInstructions: null,
				},
				bundleEndedAt: null,
			}),
		);

		const result = await getRetrievableConversationBundleById({
			bundleId: "bundle-1",
			projectId: "proj-1",
			tenant: { userId: "user-1" },
		});

		expect(result?.sourceTitle).toBeNull();
		expect(result?.metadata).toMatchObject({ bundleEndedAt: null });
	});
});

describe("getCapturedConversationMarkdown", () => {
	it("joins every captured bundle in the order the query returns them", async () => {
		findMany.mockResolvedValueOnce([
			{ content: "first window" },
			{ content: "second window" },
		]);

		await expect(
			getCapturedConversationMarkdown("ctx-channel", {
				userId: "user-1",
				organizationId: "org-1",
			}),
		).resolves.toBe("first window\n\n---\n\nsecond window");
	});

	it("drops empty bundles instead of emitting bare separators", async () => {
		findMany.mockResolvedValueOnce([
			{ content: "kept" },
			{ content: "" },
			{ content: "also kept" },
		]);

		await expect(
			getCapturedConversationMarkdown("ctx-channel", {
				userId: "user-1",
			}),
		).resolves.toBe("kept\n\n---\n\nalso kept");
	});

	it("returns an empty string for a channel with nothing captured", async () => {
		findMany.mockResolvedValueOnce([]);

		await expect(
			getCapturedConversationMarkdown("ctx-channel", {
				userId: "user-1",
			}),
		).resolves.toBe("");
	});

	it("applies the personal tenant XOR filter", async () => {
		findMany.mockResolvedValueOnce([]);

		await getCapturedConversationMarkdown("ctx-channel", {
			userId: "user-1",
		});

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					parentContextId: "ctx-channel",
					userId: "user-1",
					organizationId: null,
				},
			}),
		);
	});
});
