import { type AGUIEvent, EventType } from "@ag-ui/client";

/** An async-iterable chat stream the component can `for await` over. */
export function streamOf(events: unknown[]) {
	return (async function* () {
		for (const event of events) {
			yield event;
		}
	})();
}

const RUN_STARTED: AGUIEvent = {
	type: EventType.RUN_STARTED,
	threadId: "conv-new",
	runId: "run-1",
};
const RUN_FINISHED: AGUIEvent = {
	type: EventType.RUN_FINISHED,
	threadId: "conv-new",
	runId: "run-1",
};

/** An agent runtime run: the answer's text, the turn's notes, then the end. */
export function runtimeAnswer(
	deltas: string[],
	notes: Array<"persist-failed" | "interrupted"> = [],
): (emit: (event: AGUIEvent) => void) => void {
	return (emit) => {
		emit(RUN_STARTED);
		for (const delta of deltas) {
			emit({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "run-1:answer",
				delta,
			});
		}
		for (const note of notes) {
			emit({
				type: EventType.CUSTOM,
				name: `fabric.atlas-chat.${note}`,
				value: {},
			});
		}
		emit(RUN_FINISHED);
	};
}

/**
 * An agent runtime run that has started its answer and stays open: until
 * its request is aborted (then it rejects as fetch does), or until
 * `finish` (then it ends the answer).
 */
export function heldRuntimeAnswer(delta: string) {
	let finish = () => {};
	const finished = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const respond = async (
		emit: (event: AGUIEvent) => void,
		signal: AbortSignal,
	) => {
		emit(RUN_STARTED);
		emit({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId: "run-1:answer",
			delta,
		});
		await Promise.race([
			finished,
			new Promise<never>((_, reject) => {
				signal.addEventListener("abort", () =>
					reject(
						Object.assign(new Error("The operation was aborted."), {
							name: "AbortError",
						}),
					),
				);
			}),
		]);
		emit(RUN_FINISHED);
	};
	return { respond, finish: () => finish() };
}

/** An agent runtime run the engine refused. */
export function runtimeRefusal(
	code: string,
	message: string,
): (emit: (event: AGUIEvent) => void) => void {
	return (emit) => {
		emit({ type: EventType.RUN_ERROR, code, message });
	};
}
