/**
 * Tests for author-kind classification (skipping the Teams
 * channel/chat monitor's per-thread LLM analyzer for app/connector/bot-only
 * threads).
 *
 * Covers:
 *  - `classifyGraphFromKind` directly (user / application / unknown / null).
 *  - The `list_channel_threads` tool: `fromKind` on the root AND on each
 *    reply, independently.
 *  - The `list_chat_messages_for_monitor` tool: `fromKind` per message.
 *
 * The existing `from` display-name string is asserted unchanged alongside
 * `fromKind` — other consumers depend on that string and this feature must
 * not touch it.
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

import { classifyGraphFromKind, executeMicrosoftTeamsTool } from "../index";

describe("classifyGraphFromKind", () => {
	it("returns 'user' when from.user is present", () => {
		expect(classifyGraphFromKind({ user: { displayName: "Alice" } })).toBe(
			"user",
		);
	});

	it("returns 'application' when from.application is present and from.user is absent", () => {
		expect(
			classifyGraphFromKind({
				application: { displayName: "Alerts Bot" },
			}),
		).toBe("application");
	});

	it("returns 'unknown' when from is missing", () => {
		expect(classifyGraphFromKind(undefined)).toBe("unknown");
	});

	it("returns 'unknown' when from is null", () => {
		expect(classifyGraphFromKind(null)).toBe("unknown");
	});

	it("returns 'unknown' when from has neither user nor application", () => {
		expect(classifyGraphFromKind({})).toBe("unknown");
	});

	it("prefers 'user' when both user and application are somehow present", () => {
		expect(
			classifyGraphFromKind({
				user: { displayName: "Alice" },
				application: { displayName: "Alerts Bot" },
			}),
		).toBe("user");
	});
});

describe("executeMicrosoftTeamsTool('list_channel_threads') — fromKind", () => {
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

	it("classifies a user-authored root and reply, leaving the `from` display string unchanged", async () => {
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
						from: { user: { displayName: "Alice Engineer" } },
						body: { content: "<p>root</p>" },
						replies: [
							{
								id: "M1-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T10:01:00Z",
								from: { user: { displayName: "Bob Reviewer" } },
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
		)) as {
			threads: Array<{
				from: string;
				fromKind: string;
				replies: Array<{ from: string; fromKind: string }>;
			}>;
		};

		expect(result.threads[0].from).toBe("Alice Engineer");
		expect(result.threads[0].fromKind).toBe("user");
		expect(result.threads[0].replies[0].from).toBe("Bob Reviewer");
		expect(result.threads[0].replies[0].fromKind).toBe("user");
	});

	it("classifies an application-authored root, leaving `from` as 'Unknown' (no user displayName)", async () => {
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
						from: {
							application: {
								displayName: "Alerts Bot",
								id: "app-123",
								applicationIdentityType: "bot",
							},
						},
						body: { content: "<p>Deploy alert fired</p>" },
						replies: [],
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
				from: string;
				fromKind: string;
				replies: unknown[];
			}>;
		};

		// Unchanged: the display-name string only ever reads `from.user`, so
		// an app-authored root still falls back to "Unknown" here — other
		// consumers of this string are untouched by this feature.
		expect(result.threads[0].from).toBe("Unknown");
		expect(result.threads[0].fromKind).toBe("application");
		expect(result.threads[0].replies).toEqual([]);
	});

	it("classifies a message with no `from` at all as 'unknown'", async () => {
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
						body: { content: "<p>system-ish message</p>" },
						replies: [
							{
								id: "M3-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T10:01:00Z",
								body: { content: "<p>reply, no from</p>" },
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
				fromKind: string;
				replies: Array<{ fromKind: string }>;
			}>;
		};

		expect(result.threads[0].fromKind).toBe("unknown");
		expect(result.threads[0].replies[0].fromKind).toBe("unknown");
	});

	it("classifies root and reply independently (application root, user reply)", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "M4",
						messageType: "message",
						createdDateTime: "2026-05-23T10:00:00Z",
						from: { application: { displayName: "Alerts Bot" } },
						body: { content: "<p>Deploy alert fired</p>" },
						replies: [
							{
								id: "M4-R1",
								messageType: "message",
								createdDateTime: "2026-05-23T10:01:00Z",
								from: { user: { displayName: "Carol Oncall" } },
								body: { content: "<p>Investigating</p>" },
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
				fromKind: string;
				replies: Array<{ fromKind: string }>;
			}>;
		};

		expect(result.threads[0].fromKind).toBe("application");
		expect(result.threads[0].replies[0].fromKind).toBe("user");
	});
});

describe("executeMicrosoftTeamsTool('list_chat_messages_for_monitor') — fromKind", () => {
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

	it("classifies each message's fromKind independently (user, application, unknown)", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({
				value: [
					{
						id: "C1",
						messageType: "message",
						createdDateTime: "2026-05-23T10:00:00Z",
						from: { user: { displayName: "Alice Engineer" } },
						body: { content: "<p>hi</p>" },
					},
					{
						id: "C2",
						messageType: "message",
						createdDateTime: "2026-05-23T10:01:00Z",
						from: { application: { displayName: "Standup Bot" } },
						body: { content: "<p>Daily reminder</p>" },
					},
					{
						id: "C3",
						messageType: "message",
						createdDateTime: "2026-05-23T10:02:00Z",
						body: { content: "<p>no from at all</p>" },
					},
				],
			}),
		});

		const result = (await executeMicrosoftTeamsTool(
			"list_chat_messages_for_monitor",
			{ chatId: "chat-1", top: 10 },
			"user-1",
			"org-1",
		)) as {
			messages: Array<{ id: string; from: string; fromKind: string }>;
		};

		expect(result.messages).toHaveLength(3);
		expect(result.messages[0]).toMatchObject({
			id: "C1",
			from: "Alice Engineer",
			fromKind: "user",
		});
		expect(result.messages[1]).toMatchObject({
			id: "C2",
			from: "Unknown",
			fromKind: "application",
		});
		expect(result.messages[2]).toMatchObject({
			id: "C3",
			from: "Unknown",
			fromKind: "unknown",
		});
	});
});
