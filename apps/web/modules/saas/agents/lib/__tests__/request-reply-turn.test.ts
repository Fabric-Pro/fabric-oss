// @vitest-environment node
// (A browser's fetch abort is a DOMException that is an Error, as in Node;
// jsdom's DOMException is not one.)
/**
 * How a request/reply chat's turn on the agent runtime ends, one policy for
 * every such chat (`runRequestReplyTurn`):
 *
 *   - every event reaches the chat, its terminal events included;
 *   - a finished run resolves;
 *   - a run error rejects with its message, even when the response then
 *     drops;
 *   - an endpoint refusal rejects with the server's message, never the raw
 *     `HTTP <status>: <json>` text;
 *   - a reply that ends without finishing, or drops before an error, rejects
 *     as lost;
 *   - an abort passes through as the same object.
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

const { collectRequestReplyRun: runRequestReplyTurn } = await import(
	"../request-reply-outcome"
);

const THREAD = "thread-example-1";
const RUN = "run-example-0001";
const LOST = "The connection to this reply was lost. Please try again.";

const STARTED: AGUIEvent = {
	type: EventType.RUN_STARTED,
	threadId: THREAD,
	runId: RUN,
};
const TEXT: AGUIEvent = {
	type: EventType.TEXT_MESSAGE_CONTENT,
	messageId: `${RUN}:answer`,
	delta: "Partial",
};
const FINISHED: AGUIEvent = {
	type: EventType.RUN_FINISHED,
	threadId: THREAD,
	runId: RUN,
};
const FAILED: AGUIEvent = {
	type: EventType.RUN_ERROR,
	code: "THREAD_ALREADY_RUNNING",
	message: "This chat is still answering.",
};

/** A runtime run that emits `events`, then ends (or drops with `drop`). */
function emits(events: AGUIEvent[], drop?: Error) {
	m.run.mockImplementation(
		async (args: { onEvent: (event: AGUIEvent) => void }) => {
			for (const event of events) {
				args.onEvent(event);
			}
			if (drop) {
				throw drop;
			}
		},
	);
}

function turn(onEvent = vi.fn()) {
	return {
		agentId: "example-chat",
		threadId: THREAD,
		messages: [{ role: "user" as const, content: "A question" }],
		forwardedProps: { resourceId: "resource-example-1" },
		organizationId: "org-example-1",
		signal: new AbortController().signal,
		onEvent,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("runRequestReplyTurn", () => {
	it("runs the request as given and hands every event to the chat, its terminal events included", async () => {
		emits([STARTED, TEXT, FINISHED]);
		const onEvent = vi.fn();
		const request = turn(onEvent);

		await runRequestReplyTurn(request);

		expect(m.run).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "example-chat",
				threadId: THREAD,
				messages: request.messages,
				forwardedProps: request.forwardedProps,
				organizationId: "org-example-1",
				signal: request.signal,
			}),
		);
		expect(onEvent.mock.calls).toEqual([[STARTED], [TEXT], [FINISHED]]);
	});

	it("rejects with the run's error message, before or after a dropped response", async () => {
		emits([STARTED, FAILED]);
		await expect(runRequestReplyTurn(turn())).rejects.toThrow(
			"This chat is still answering.",
		);

		emits([STARTED, FAILED], new Error("socket hang up"));
		await expect(runRequestReplyTurn(turn())).rejects.toThrow(
			"This chat is still answering.",
		);
	});

	it("rejects a reply that ends without finishing, or drops, as lost, never as a whole answer", async () => {
		emits([STARTED, TEXT]);
		await expect(runRequestReplyTurn(turn())).rejects.toThrow(LOST);

		emits([STARTED, TEXT], new Error("socket hang up"));
		await expect(runRequestReplyTurn(turn())).rejects.toThrow(LOST);
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

			const refused = await runRequestReplyTurn(turn()).catch(
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

		await expect(runRequestReplyTurn(turn())).rejects.toBe(abort);
	});
});
