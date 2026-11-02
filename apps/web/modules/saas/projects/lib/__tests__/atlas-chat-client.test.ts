// @vitest-environment node
// (A browser's fetch abort is a DOMException that is an Error, as in Node;
// jsdom's DOMException is not one.)
/**
 * One Atlas chat turn over either transport (`atlas-chat-client.ts`): both
 * hand the panel the answer's text and at most one terminal sentinel.
 *
 *   - the route's event iterator: string deltas in order, both sentinels,
 *     unknown objects ignored, nothing more once aborted;
 *   - the agent runtime: the run names the `atlas-chat` agent, the
 *     conversation as its thread, the options, the organization and the
 *     signal; text and both notes map to the same sink calls; a run error,
 *     an endpoint refusal and a reply that ends without finishing reject with
 *     the message the panel shows; an abort passes through.
 */
import type { AGUIEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	run: vi.fn(),
}));

vi.mock("@saas/agents/lib/request-reply-runtime", () => ({
	streamRequestReplyRun: (...args: unknown[]) => m.run(...args),
}));

const { consumeAtlasRouteStream, streamAtlasRuntime } = await import(
	"../atlas-chat-client"
);

const THREAD = "conversation-example-1";
const RUN = "run-example-0001";
const PROPS = {
	projectId: "project-example-1",
	repositoryIntegrationId: "integration-1",
	mode: "BUSINESS" as const,
	focusNodeKey: "node-a",
};
const MESSAGES = [{ role: "user" as const, content: "How does auth work?" }];

function sink() {
	return { onDelta: vi.fn(), onSentinel: vi.fn() };
}

/** A runtime run that emits `events`, then ends. */
function emits(events: AGUIEvent[]) {
	m.run.mockImplementation(
		async (args: { onEvent: (event: AGUIEvent) => void }) => {
			for (const event of events) {
				args.onEvent(event);
			}
		},
	);
}

function turn(signal = new AbortController().signal) {
	return {
		conversationId: THREAD,
		organizationId: "org-example-1",
		props: PROPS,
		messages: MESSAGES,
		signal,
	};
}

const STARTED: AGUIEvent = {
	type: EventType.RUN_STARTED,
	threadId: THREAD,
	runId: RUN,
};
const FINISHED: AGUIEvent = {
	type: EventType.RUN_FINISHED,
	threadId: THREAD,
	runId: RUN,
};

function text(delta: string): AGUIEvent {
	return {
		type: EventType.TEXT_MESSAGE_CONTENT,
		messageId: `${RUN}:answer`,
		delta,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("consumeAtlasRouteStream", () => {
	it("hands over deltas in order and both sentinels, ignores unknown objects, and stops once aborted", async () => {
		const controller = new AbortController();
		const into = sink();
		async function* route() {
			yield "Hello ";
			yield { type: "some-future-event" };
			yield "world";
			yield { type: "atlas-chat-persist-failed" };
			yield { type: "atlas-chat-interrupted" };
			controller.abort();
			yield "after the abort";
		}

		await consumeAtlasRouteStream(route(), controller.signal, into);

		expect(into.onDelta.mock.calls).toEqual([["Hello "], ["world"]]);
		expect(into.onSentinel.mock.calls).toEqual([
			["atlas-chat-persist-failed"],
			["atlas-chat-interrupted"],
		]);
	});
});

describe("streamAtlasRuntime", () => {
	it("runs the atlas-chat agent on the conversation, with the options, organization and signal", async () => {
		emits([STARTED, FINISHED]);
		const controller = new AbortController();

		await streamAtlasRuntime(turn(controller.signal), sink());

		expect(m.run).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "atlas-chat",
				threadId: THREAD,
				messages: MESSAGES,
				forwardedProps: PROPS,
				organizationId: "org-example-1",
				signal: controller.signal,
			}),
		);
	});

	it("maps the text and both notes, and ignores another agent's CUSTOM events", async () => {
		emits([
			STARTED,
			{
				type: EventType.CUSTOM,
				name: "fabric.library-chat.sources",
				value: { sources: [] },
			},
			text("Sessions "),
			text("live in Redis."),
			{
				type: EventType.CUSTOM,
				name: "fabric.atlas-chat.persist-failed",
				value: {},
			},
			{
				type: EventType.CUSTOM,
				name: "fabric.atlas-chat.interrupted",
				value: {},
			},
			FINISHED,
		]);
		const into = sink();

		await streamAtlasRuntime(turn(), into);

		expect(into.onDelta.mock.calls).toEqual([
			["Sessions "],
			["live in Redis."],
		]);
		expect(into.onSentinel.mock.calls).toEqual([
			["atlas-chat-persist-failed"],
			["atlas-chat-interrupted"],
		]);
	});

	it("rejects with the run's error message", async () => {
		emits([
			STARTED,
			{
				type: EventType.RUN_ERROR,
				code: "THREAD_ALREADY_RUNNING",
				message: "This chat is still answering.",
			},
		]);

		await expect(streamAtlasRuntime(turn(), sink())).rejects.toThrow(
			"This chat is still answering.",
		);
	});

	it("rejects a reply that ends without finishing as lost, never as a whole answer", async () => {
		emits([STARTED, text("Partial")]);

		await expect(streamAtlasRuntime(turn(), sink())).rejects.toThrow(
			"The connection to this reply was lost. Please try again.",
		);
	});

	it.each([
		[
			401,
			{
				error: "Unauthorized",
				message: "Sign in to use the agent runtime.",
			},
			"Sign in to use the agent runtime.",
		],
		[
			403,
			{
				error: "Forbidden",
				message: "You do not have access to this organization.",
			},
			"You do not have access to this organization.",
		],
	])(
		"an HTTP %s refusal rejects with the server's message",
		async (status, payload, shown) => {
			m.run.mockRejectedValue(
				Object.assign(
					new Error(`HTTP ${status}: ${JSON.stringify(payload)}`),
					{ status, payload },
				),
			);

			const refused = await streamAtlasRuntime(turn(), sink()).catch(
				(error: unknown) => error,
			);

			expect(refused).toBeInstanceOf(Error);
			expect(refused).toMatchObject({ message: shown });
		},
	);

	it("passes an abort through as the same object", async () => {
		const abort = new DOMException(
			"The user aborted a request.",
			"AbortError",
		);
		m.run.mockRejectedValue(abort);

		await expect(streamAtlasRuntime(turn(), sink())).rejects.toBe(abort);
	});
});
