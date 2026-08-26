/**
 * Temporal payload size guard (Fizzy #1997).
 *
 * Every value crossing a Temporal boundary — activity input/output, child
 * workflow args/results, signals, queries — travels inside ONE gRPC message,
 * and the Temporal frontend rejects any message larger than 4 MiB with
 * `ResourceExhausted` ("grpc: received message larger than max"). The ceiling
 * applies to Temporal Cloud and self-hosted alike; raising `limit.blobSize.*`
 * in dynamic config does NOT move it (blobSize gates history-blob checks, not
 * the gRPC frame), and Cloud exposes no knob at all. Proven in production
 * (#1741): a 6,482,333-byte activity return was rejected at exactly
 * 4,194,304 bytes.
 *
 * The raw failure mode is nasty: the activity finishes locally, its completion
 * RPC is rejected by the SDK core, START_TO_CLOSE retries burn through without
 * changing anything, and the flow stalls downstream with no error naming the
 * real cause. The guard fails FAST instead — inside the producer, with the
 * boundary label and the serialized size in the message.
 *
 * Pure and dependency-free so both activities and the workflow sandbox can
 * import it (mirrors `../workflows/daily-brief-release-note-exclusions`).
 */

/** The gRPC max-message-size every Temporal frontend enforces (4 MiB). */
export const TEMPORAL_MAX_MESSAGE_BYTES = 4_194_304;

/** Serialized size above which a boundary logs a warning. Half the frame —
 *  big enough to be worth looking at, small enough to leave reaction room. */
export const PAYLOAD_WARN_BYTES = 2 * 1024 * 1024;

/** Hard budget for one boundary crossing: the frame minus headroom for
 *  protobuf framing, payload metadata, and sibling payloads sharing the
 *  message. A value over this budget would be rejected anyway; failing here
 *  names the culprit instead of leaving a cryptic core rejection. */
export const PAYLOAD_HARD_LIMIT_BYTES = TEMPORAL_MAX_MESSAGE_BYTES - 64 * 1024;

export type PayloadSizeClass = "ok" | "warn" | "exceeds";

/**
 * Serialized UTF-8 byte length of a value as Temporal's default data converter
 * would ship it. `JSON.stringify(...).length` alone undercounts multibyte text
 * (emoji/CJK are 2–4 wire bytes per UTF-16 unit); `Buffer.byteLength` measures
 * what actually crosses the wire.
 */
export function measureSerializedBytes(value: unknown): number {
	const json = JSON.stringify(value);
	if (json === undefined) {
		// undefined / functions / symbols serialize to nothing — nothing ships.
		return 0;
	}
	return Buffer.byteLength(json, "utf8");
}

export function classifyPayloadSize(bytes: number): PayloadSizeClass {
	if (bytes > PAYLOAD_HARD_LIMIT_BYTES) {
		return "exceeds";
	}
	if (bytes > PAYLOAD_WARN_BYTES) {
		return "warn";
	}
	return "ok";
}

/**
 * Thrown by {@link assertPayloadWithinLimit}. `name` doubles as the
 * ApplicationFailure type, so adding `"PAYLOAD_TOO_LARGE"` to a proxy's
 * `nonRetryableErrorTypes` skips pointless retries — no input shrinks by
 * being retried.
 */
export class PayloadTooLargeError extends Error {
	readonly bytes: number;

	constructor(label: string, bytes: number) {
		super(
			`Temporal payload too large at "${label}": ${bytes} bytes serialized, ` +
				`budget ${PAYLOAD_HARD_LIMIT_BYTES} (gRPC frame ${TEMPORAL_MAX_MESSAGE_BYTES}). ` +
				"Slim the value at the boundary or stage bulk detail in the database " +
				"and pass ids instead — see pm-state-poll.ts (#1741) and " +
				"qa-agentic-run/run-batching.ts.",
		);
		this.name = "PAYLOAD_TOO_LARGE";
		this.bytes = bytes;
	}
}

/**
 * Measure `value` and throw {@link PayloadTooLargeError} past the hard budget.
 * Returns the measured byte count so the caller can put it on its existing
 * log line (the `serializedBytes` diagnostic #1741 introduced).
 */
export function assertPayloadWithinLimit(
	value: unknown,
	label: string,
): number {
	const bytes = measureSerializedBytes(value);
	if (bytes > PAYLOAD_HARD_LIMIT_BYTES) {
		throw new PayloadTooLargeError(label, bytes);
	}
	return bytes;
}
