/**
 * The workspace document chat's runtime client (`askLibraryRuntime`) ends its run as
 * every request/reply chat does (`collectRequestReplyRun`): a failed run
 * rejects with a `RequestReplyRunError` that keeps a usage limit's payload
 * for the shared limit toast, and a reply that ends without finishing is
 * lost, never an answer.
 */
import { EventType } from "@ag-ui/client";
import { RequestReplyRunError } from "@saas/agents/lib/request-reply-outcome";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askLibraryRuntime } from "../workspace-document-chat-client";

const USAGE_LIMIT = {
	limitId: "limit-1",
	dimension: "TOKENS",
	window: "MONTHLY",
	used: "10",
	max: "10",
	manageLimitsUrl: "https://example.com/limits",
};

const fetchMock = vi.fn<typeof fetch>();

function sse(events: Array<Record<string, unknown>>): Response {
	return new Response(
		events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
		{ status: 200, headers: { "Content-Type": "text/event-stream" } },
	);
}

function ask() {
	return askLibraryRuntime({
		workspaceId: "workspace-example-1",
		message: "What does the guide say?",
		history: [],
		threadId: "thread-example-1",
		organizationId: "org-example-1",
		signal: new AbortController().signal,
		onSources: () => {},
		onText: () => {},
	});
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("askLibraryRuntime", () => {
	it("keeps explicit served identity per turn and ignores malformed metadata", async () => {
		const model = { id: "example-served", viaPlan: false };
		const reply = (value: unknown) =>
			sse([
				{ type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
				{
					type: EventType.TEXT_MESSAGE_START,
					messageId: "a",
					role: "assistant",
				},
				{
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "a",
					delta: "Answer",
				},
				{ type: EventType.TEXT_MESSAGE_END, messageId: "a" },
				{
					type: EventType.CUSTOM,
					name: "fabric.library-chat.model",
					value,
				},
				{ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
			]);
		fetchMock
			.mockResolvedValueOnce(reply(model))
			.mockResolvedValueOnce(reply({ id: "example-configured" }));
		expect((await ask()).model).toEqual(model);
		expect((await ask()).model).toBeUndefined();
	});
	it("rejects a usage limit with the limits the shared toast shows", async () => {
		fetchMock.mockImplementation(async () =>
			sse([
				{ type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
				{
					type: EventType.RUN_ERROR,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					message: "AI usage limit exceeded",
					metadata: {
						fabric: {
							status: 429,
							code: "AI_USAGE_LIMIT_EXCEEDED",
							data: USAGE_LIMIT,
						},
					},
				},
			]),
		);

		const failure = await ask().catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RequestReplyRunError);
		expect(failure).toMatchObject({
			message: "AI usage limit exceeded",
			code: "AI_USAGE_LIMIT_EXCEEDED",
			usageLimit: USAGE_LIMIT,
		});
	});

	it("rejects a reply that ends without finishing as lost, never as an answer", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		fetchMock.mockImplementation(async () =>
			sse([
				{ type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
				{
					type: EventType.TEXT_MESSAGE_START,
					messageId: "a",
					role: "assistant",
				},
				{
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "a",
					delta: "Half an ans",
				},
			]),
		);

		await expect(ask()).rejects.toThrow(
			"The connection to this reply was lost. Please try again.",
		);
	});
});
