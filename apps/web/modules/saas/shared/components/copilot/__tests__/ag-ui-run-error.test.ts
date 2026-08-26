/**
 * Tests for the AG-UI `RUN_ERROR` scanner.
 *
 * The failure it exists to catch, captured from a real failing run against the
 * local app: `POST /api/copilotkit` answered **200** with
 * `content-type: text/event-stream`, and the only frame on the stream was
 *
 *     data: {"type":"RUN_ERROR","message":"fetch failed","code":"INCOMPLETE_STREAM"}
 *
 * The user saw no reply, no error, and their own message gone from the thread.
 */

import { describe, expect, it, vi } from "vitest";
import { findAgUiRunError } from "../ag-ui-run-error";

function eventStream(...chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("findAgUiRunError", () => {
	it("finds the RUN_ERROR that a healthy 200 carried, from the real captured frame", async () => {
		const found = await findAgUiRunError(
			eventStream(
				'data: {"type":"RUN_ERROR","message":"fetch failed","code":"INCOMPLETE_STREAM"}\n',
			),
		);

		expect(found).toEqual({
			message: "fetch failed",
			code: "INCOMPLETE_STREAM",
		});
	});

	it("stays silent for a run that streamed content and ended cleanly", async () => {
		const found = await findAgUiRunError(
			eventStream(
				'data: {"type":"RUN_STARTED"}\n',
				'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Here"}\n',
				'data: {"type":"TEXT_MESSAGE_CONTENT","delta":" you go"}\n',
				'data: {"type":"RUN_FINISHED"}\n',
			),
		);

		expect(found).toBeNull();
	});

	it("finds a RUN_ERROR split across chunk boundaries mid-frame", async () => {
		// A real stream splits on network chunks, not on frame boundaries, so
		// the scanner must buffer a partial line rather than drop it.
		const found = await findAgUiRunError(
			eventStream(
				'data: {"type":"RUN_STARTED"}\ndata: {"type":"RUN_ER',
				'ROR","message":"Your credit balance is too low"}\n',
			),
		);

		expect(found?.message).toBe("Your credit balance is too low");
	});

	it("finds a RUN_ERROR on the final line even without a trailing newline", async () => {
		const found = await findAgUiRunError(
			eventStream(
				'data: {"type":"RUN_ERROR","code":"INCOMPLETE_STREAM"}',
			),
		);

		expect(found?.code).toBe("INCOMPLETE_STREAM");
	});

	it("ignores a malformed frame rather than throwing, so a bad frame cannot break the run", async () => {
		const found = await findAgUiRunError(
			eventStream(
				'data: {"type":"RUN_ERROR", this is not json\n',
				'data: {"type":"RUN_FINISHED"}\n',
			),
		);

		expect(found).toBeNull();
	});

	it("ignores content that merely mentions RUN_ERROR in an assistant reply", async () => {
		const found = await findAgUiRunError(
			eventStream(
				'data: {"type":"TEXT_MESSAGE_CONTENT","delta":"the RUN_ERROR frame means"}\n',
			),
		);

		expect(found).toBeNull();
	});

	it("rejects when the connection dies part-way through, rather than resolving null", async () => {
		// A stream that errors is NOT the same as one that ends without a
		// RUN_ERROR. Resolving null here would report a broken connection as a
		// healthy run and put the user back in silence — so the rejection is
		// the contract the caller's network-failure branch depends on.
		const encoder = new TextEncoder();
		const dying = new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(
						encoder.encode('data: {"type":"RUN_STARTED"}\n'),
					);
					controller.error(new Error("network died"));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);

		await expect(findAgUiRunError(dying)).rejects.toThrow("network died");
	});

	it("does not read a response that is not an event stream", async () => {
		const json = new Response(JSON.stringify({ type: "RUN_ERROR" }), {
			headers: { "content-type": "application/json" },
		});

		expect(await findAgUiRunError(json)).toBeNull();
		// Left unread, so the caller's own parse still works.
		expect(json.bodyUsed).toBe(false);
	});
});

/**
 * The silence watchdog. Measured as a gap between frames, never as a cap on
 * total duration — a long run is not a stuck one.
 */
describe("findAgUiRunError silence watchdog", () => {
	function stallingStream(holdMs: number, thenSend?: string): Response {
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream({
				async start(controller) {
					controller.enqueue(
						encoder.encode('data: {"type":"RUN_STARTED"}\n'),
					);
					await new Promise((r) => setTimeout(r, holdMs));
					if (thenSend) {
						controller.enqueue(encoder.encode(thenSend));
					}
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	}

	it("reports silence once the gap between frames passes the threshold", async () => {
		const onSilence = vi.fn();
		await findAgUiRunError(stallingStream(60), {
			onSilence,
			silenceMs: 10,
		});

		expect(onSilence).toHaveBeenCalledTimes(1);
	});

	it("retracts the report when the run speaks again", async () => {
		const onSilence = vi.fn();
		const onResume = vi.fn();
		await findAgUiRunError(
			stallingStream(60, 'data: {"type":"RUN_FINISHED"}\n'),
			{ onSilence, onResume, silenceMs: 10 },
		);

		expect(onSilence).toHaveBeenCalledTimes(1);
		expect(onResume).toHaveBeenCalledTimes(1);
	});

	it("keeps the report standing when the run goes quiet and then just stops", async () => {
		// The case the notice exists for: silence, then a close carrying no
		// content and no error. Retracting here would return the user to the
		// silence this whole module is about.
		const onSilence = vi.fn();
		const onResume = vi.fn();
		await findAgUiRunError(stallingStream(60), {
			onSilence,
			onResume,
			silenceMs: 10,
		});

		expect(onSilence).toHaveBeenCalledTimes(1);
		expect(onResume).not.toHaveBeenCalled();
	});

	it("stays quiet for a run that keeps streaming inside the threshold", async () => {
		const onSilence = vi.fn();
		await findAgUiRunError(
			stallingStream(10, 'data: {"type":"RUN_FINISHED"}\n'),
			{ onSilence, silenceMs: 400 },
		);

		expect(onSilence).not.toHaveBeenCalled();
	});
});
