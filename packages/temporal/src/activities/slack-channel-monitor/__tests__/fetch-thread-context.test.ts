import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the credentials helper so the activity skips its real database lookup.
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: vi.fn(async () => ({
		accessToken: "xoxb-test",
		integrationId: "wfi-1",
	})),
}));

// `@temporalio/activity` is loaded only for `Context.current().heartbeat()`
// inside the rate-limit retry branch — we never hit that path in tests, but
// the import has to succeed.
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			heartbeat: () => {},
		}),
	},
}));

import { fetchSlackThreadContextActivity } from "../fetch-thread-context";

interface MockConversationsRepliesBody {
	ok: true;
	has_more?: boolean;
	messages: Array<{
		ts: string;
		thread_ts?: string;
		text?: string;
		user?: string;
		bot_id?: string;
		files?: Array<{
			id: string;
			name?: string;
			title?: string;
			mimetype?: string;
			url_private?: string;
			size?: number;
		}>;
	}>;
}

function mockSlackReplies(body: MockConversationsRepliesBody): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const VALID_INPUT = {
	userId: "u1",
	organizationId: "o1",
	slackTeamId: "T1",
	channelId: "C1",
	threadRootTs: "1700000000.000100",
};

describe("fetchSlackThreadContextActivity — pending attachments", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("rounds-trips Slack file refs into pendingAttachments + messages[].files", async () => {
		fetchMock.mockResolvedValue(
			mockSlackReplies({
				ok: true,
				messages: [
					{
						ts: "1700000000.000100",
						thread_ts: "1700000000.000100",
						text: "look at these errors",
						user: "U1",
						files: [
							{
								id: "F1",
								name: "stack.png",
								title: "Stack trace",
								mimetype: "image/png",
								url_private:
									"https://files.slack.com/files-pri/T1-F1/stack.png",
								size: 12345,
							},
							{
								id: "F2",
								name: "log.jpeg",
								mimetype: "image/jpeg",
								url_private:
									"https://files.slack.com/files-pri/T1-F2/log.jpeg",
								size: 9876,
							},
						],
					},
				],
			}),
		);

		const result = await fetchSlackThreadContextActivity(VALID_INPUT);

		expect(result.messages).toHaveLength(1);
		const firstMsg = result.messages[0];
		expect(firstMsg.files).toBeDefined();
		expect(firstMsg.files).toHaveLength(2);
		expect(firstMsg.files?.[0]).toEqual({
			id: "F1",
			name: "stack.png",
			mimetype: "image/png",
			urlPrivate: "https://files.slack.com/files-pri/T1-F1/stack.png",
			size: 12345,
			title: "Stack trace",
		});
		// pendingAttachments are flattened with messageTs.
		expect(result.pendingAttachments).toHaveLength(2);
		expect(result.pendingAttachments[0]).toMatchObject({
			source: "slack",
			messageTs: "1700000000.000100",
			file: { id: "F1", mimetype: "image/png" },
		});
		expect(result.pendingAttachments[1]).toMatchObject({
			source: "slack",
			messageTs: "1700000000.000100",
			file: { id: "F2", mimetype: "image/jpeg" },
		});
		expect(result.attachmentWarnings).toEqual([]);
	});

	it("is backward-compatible: messages without files yield empty pendingAttachments + no .files key", async () => {
		fetchMock.mockResolvedValue(
			mockSlackReplies({
				ok: true,
				messages: [
					{
						ts: "1700000000.000100",
						thread_ts: "1700000000.000100",
						text: "no images here",
						user: "U1",
					},
					{
						ts: "1700000000.000200",
						thread_ts: "1700000000.000100",
						text: "just a follow up",
						user: "U2",
					},
				],
			}),
		);

		const result = await fetchSlackThreadContextActivity(VALID_INPUT);

		expect(result.messages).toHaveLength(2);
		// `files` is intentionally absent (undefined) on a message with no kept
		// files so downstream readers can short-circuit on the key check.
		expect(result.messages[0].files).toBeUndefined();
		expect(result.messages[1].files).toBeUndefined();
		// Existing fields are preserved.
		expect(result.messages[0].sender).toBe("U1");
		expect(result.messages[0].content).toBe("no images here");
		expect(result.pendingAttachments).toEqual([]);
		expect(result.attachmentWarnings).toEqual([]);
	});

	it("filters image/svg+xml and emits an unsupported_mime warning", async () => {
		fetchMock.mockResolvedValue(
			mockSlackReplies({
				ok: true,
				messages: [
					{
						ts: "1700000000.000100",
						thread_ts: "1700000000.000100",
						text: "diagram + screenshot",
						user: "U1",
						files: [
							{
								id: "F-png",
								name: "shot.png",
								mimetype: "image/png",
								url_private:
									"https://files.slack.com/files-pri/T1-Fpng/shot.png",
								size: 1024,
							},
							{
								id: "F-svg",
								name: "diagram.svg",
								mimetype: "image/svg+xml",
								url_private:
									"https://files.slack.com/files-pri/T1-Fsvg/diagram.svg",
								size: 2048,
							},
						],
					},
				],
			}),
		);

		const result = await fetchSlackThreadContextActivity(VALID_INPUT);

		// Only the PNG survives into messages[].files.
		expect(result.messages[0].files).toHaveLength(1);
		expect(result.messages[0].files?.[0].id).toBe("F-png");
		// pendingAttachments mirrors the kept set.
		expect(result.pendingAttachments).toHaveLength(1);
		expect(result.pendingAttachments[0]).toMatchObject({
			source: "slack",
			file: { id: "F-png" },
		});
		// SVG drop is surfaced as an unsupported_mime warning.
		expect(result.attachmentWarnings).toEqual([
			{
				source: "slack",
				refId: "F-svg",
				reason: "unsupported_mime",
				detail: "image/svg+xml",
			},
		]);
	});
});
