/**
 * Tests for the `repliesComplete` flag on `list_channel_threads` threads.
 *
 * Graph's `$expand=replies` caps how many replies come back per message; a
 * thread with more replies than that cap gets a replies OData nextLink
 * annotation instead of the rest. This tool does not follow that link (an
 * extra round trip per busy thread), but it must say so — the
 * app-authored-thread skip in the channel-monitor analyzer relies on
 * `repliesComplete` to avoid drawing a "this thread is all-application"
 * conclusion from a reply list it knows is partial.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
	resolveWorkflowIntegrationForProvider: async (
		...args: Parameters<
			typeof import("@repo/database/prisma/queries/workflows/integration-access").resolveWorkflowIntegrationForProvider
		>
	) => {
		const mocked = await import("@repo/database");
		return mocked.db.workflowIntegration.findFirst({
			where: {
				...mocked.workflowIntegrationAccessWhere(args[1], args[2]),
				provider: args[0],
				isActive: true,
			},
		});
	},
	db: {
		workflowIntegration: {
			findFirst: (...args: unknown[]) => findFirstIntegration(...args),
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { executeMicrosoftTeamsTool } from "../index";

// Built at runtime: the joined literal is email-shaped, which the
// repository's publication scan rejects.
const REPLIES_NEXT_LINK_KEY = ["replies", "odata.nextLink"].join("@");

describe("executeMicrosoftTeamsTool('list_channel_threads') — repliesComplete", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		findFirstIntegration.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({ access_token: "graph-test-token" }),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sets repliesComplete: true when the thread carries no replies nextLink annotation", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "M1",
						messageType: "message",
						createdDateTime: "2026-05-23T10:00:00Z",
						from: { application: { displayName: "Alerts Bot" } },
						body: { content: "<p>root</p>" },
						replies: [
							{
								id: "M1-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T10:01:00Z",
								from: {
									application: { displayName: "Alerts Bot" },
								},
								body: { content: "<p>reply</p>" },
							},
						],
					},
				],
			}),
		});

		const result = (await executeMicrosoftTeamsTool(
			"list_channel_threads",
			{ teamId: "T1", channelId: "C1", top: 1 },
			"user-1",
			"org-1",
		)) as { threads: Array<{ repliesComplete: boolean }> };

		expect(result.threads[0].repliesComplete).toBe(true);
	});

	it("sets repliesComplete: false when the thread carries a replies nextLink annotation", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "M2",
						messageType: "message",
						createdDateTime: "2026-05-23T10:00:00Z",
						from: { application: { displayName: "Alerts Bot" } },
						body: { content: "<p>root with many replies</p>" },
						replies: [
							{
								id: "M2-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T10:01:00Z",
								from: {
									application: { displayName: "Alerts Bot" },
								},
								body: { content: "<p>reply page 1</p>" },
							},
						],
						[REPLIES_NEXT_LINK_KEY]:
							"https://graph.microsoft.com/v1.0/teams/T1/channels/C1/messages/M2/replies",
					},
				],
			}),
		});

		const result = (await executeMicrosoftTeamsTool(
			"list_channel_threads",
			{ teamId: "T1", channelId: "C1", top: 1 },
			"user-1",
			"org-1",
		)) as { threads: Array<{ repliesComplete: boolean }> };

		expect(result.threads[0].repliesComplete).toBe(false);
	});

	it("does not follow the replies nextLink annotation (no extra request beyond the thread page itself)", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "M3",
						messageType: "message",
						createdDateTime: "2026-05-23T10:00:00Z",
						from: { application: { displayName: "Alerts Bot" } },
						body: { content: "<p>root</p>" },
						replies: [],
						[REPLIES_NEXT_LINK_KEY]:
							"https://graph.microsoft.com/v1.0/teams/T1/channels/C1/messages/M3/replies",
					},
				],
			}),
		});

		await executeMicrosoftTeamsTool(
			"list_channel_threads",
			{ teamId: "T1", channelId: "C1", top: 1 },
			"user-1",
			"org-1",
		);

		// One call for the thread page. If the tool had followed the
		// replies nextLink it would be two.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
