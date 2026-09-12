import { defaultPayloadConverter, type Payload } from "@temporalio/common";

/**
 * Decodes the heartbeat details of a pending activity as returned by
 * `WorkflowHandle.describe()`.
 *
 * The client SDK decodes memo and search attributes on `describe()`, but
 * leaves `raw.pendingActivities[].heartbeatDetails` as the wire form: a
 * `Payloads` proto holding one encoded payload per `heartbeat()` argument.
 * The stream route used to read `.toolCalls` and `.responseText` straight
 * off that proto, found nothing, and fell back to the workflow's progress
 * query, which only carries the final result. That is why tool calls and
 * text only appeared once the whole turn had finished.
 *
 * Uses the default payload converter, which is what the client and worker
 * are configured with. Returns `undefined` for missing or unreadable
 * details, and passes through an object that is already decoded (as in
 * tests, or if a future SDK decodes for us).
 */
export function decodeHeartbeatDetails<T>(raw: unknown): T | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}
	if (!("payloads" in raw)) {
		return raw as T;
	}
	const payloads = (raw as { payloads?: unknown }).payloads;
	if (!Array.isArray(payloads) || payloads.length === 0) {
		return undefined;
	}
	try {
		return defaultPayloadConverter.fromPayload<T>(payloads[0] as Payload);
	} catch {
		return undefined;
	}
}
