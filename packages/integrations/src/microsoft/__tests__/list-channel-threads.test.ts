/**
 * Tests for the `list_channel_threads` branch of `executeMicrosoftTeamsTool`.
 *
 * Scoped to the chat-thread image-attachments feature: assert that
 * `pendingAttachments` is emitted on each thread + reply when the message
 * body HTML contains Graph `hostedContents/{id}/$value` references, AND
 * stays empty when there are no inline images (backward compat).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", () => ({
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

// `@repo/ai` is reached via static import in `microsoft/index.ts` for the
// excerpt extractor (used by `list_messages`); stub it out to avoid loading
// the real LLM stack in unit tests.
vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { executeMicrosoftTeamsTool } from "../index";

const HOSTED_URL_PREFIX =
	"https://graph.microsoft.com/v1.0/teams/T1/channels/C1/messages/M1";

const ROOT_HTML = `
	<p>Bug repro:</p>
	<img src="${HOSTED_URL_PREFIX}/hostedContents/root-img-1/$value" alt="Step 1">
	<img src="${HOSTED_URL_PREFIX}/hostedContents/root-img-2/$value" alt="Step 2">
`;

const REPLY_HTML = `
	<p>Reproduced. See attached:</p>
	<img src="${HOSTED_URL_PREFIX}/hostedContents/reply-img-1/$value" alt="My env">
`;

describe("executeMicrosoftTeamsTool('list_channel_threads')", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		findFirstIntegration.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({
				access_token: "graph-test-token",
			}),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("emits pendingAttachments per thread + reply when bodies carry hostedContent <img> tags", async () => {
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
						lastModifiedDateTime: "2026-05-23T10:05:00Z",
						webUrl: "https://teams.microsoft.com/M1",
						body: { content: ROOT_HTML },
						from: {
							user: { displayName: "Alice Engineer" },
						},
						replies: [
							{
								id: "M1-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T10:01:00Z",
								body: { content: REPLY_HTML },
								from: {
									user: { displayName: "Bob Reviewer" },
								},
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
		)) as {
			threads: Array<{
				id: string;
				pendingAttachments: unknown[];
				replies: Array<{ id: string; pendingAttachments: unknown[] }>;
			}>;
			count: number;
		};

		expect(result.count).toBe(1);
		expect(result.threads).toHaveLength(1);

		const thread = result.threads[0];
		expect(thread.id).toBe("M1");
		expect(thread.replies).toHaveLength(1);
		expect(thread.replies[0].id).toBe("M1-R1");

		// Reply-level attachments: 1 inline image. `parentMessageId` is
		// the thread root id (M1) — kept for backward-compat with the
		// legacy reconstruction path. `srcUrl` is the verbatim Graph URL
		// Teams wrote into the reply's body and is what the apply-time
		// downloader will fetch (preferred over reconstruction).
		expect(thread.replies[0].pendingAttachments).toEqual([
			{
				source: "teams",
				ref: {
					id: "reply-img-1",
					messageId: "M1-R1",
					parentMessageId: "M1",
					contentType: "application/octet-stream",
					srcUrl: `${HOSTED_URL_PREFIX}/hostedContents/reply-img-1/$value`,
					altText: "My env",
				},
			},
		]);

		// Thread-level: root's 2 + reply's 1 = 3.
		expect(thread.pendingAttachments).toHaveLength(3);
		expect(thread.pendingAttachments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					source: "teams",
					ref: expect.objectContaining({
						id: "root-img-1",
						messageId: "M1",
					}),
				}),
				expect.objectContaining({
					source: "teams",
					ref: expect.objectContaining({
						id: "root-img-2",
						messageId: "M1",
					}),
				}),
				expect.objectContaining({
					source: "teams",
					ref: expect.objectContaining({
						id: "reply-img-1",
						messageId: "M1-R1",
					}),
				}),
			]),
		);
	});

	it("emits empty pendingAttachments arrays when there are no inline images (backward compat)", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "M2",
						messageType: "message",
						createdDateTime: "2026-05-23T11:00:00Z",
						body: { content: "<p>Plain text discussion.</p>" },
						from: { user: { displayName: "Alice" } },
						replies: [
							{
								id: "M2-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T11:01:00Z",
								body: { content: "<p>Reply, no image.</p>" },
								from: { user: { displayName: "Bob" } },
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
		)) as {
			threads: Array<{
				id: string;
				pendingAttachments: unknown[];
				replies: Array<{ id: string; pendingAttachments: unknown[] }>;
			}>;
		};

		expect(result.threads).toHaveLength(1);
		expect(result.threads[0].pendingAttachments).toEqual([]);
		expect(result.threads[0].replies[0].pendingAttachments).toEqual([]);
	});
});
