/**
 * How much an AI chat request is allowed to carry, and how to measure what it
 * is already carrying.
 *
 * Separate from `image-upload-utils` on purpose. That module is about producing
 * an image — canvas compression, S3 upload, orpc calls — and the surfaces that
 * consume it mock it wholesale in tests. These are pure arithmetic about the
 * REQUEST, needed by the upload hook and by the chat surfaces that hold context,
 * so they live where they can be imported without dragging a canvas or a
 * network client behind them.
 */

/** Bytes a raw payload occupies once base64-encoded (4 bytes per 3). */
export function encodedSizeOf(rawBytes: number): number {
	return Math.ceil(rawBytes / 3) * 4;
}

/**
 * Ceiling the HOSTING PLATFORM enforces on one chat request body.
 *
 * This is a different, lower limit than the provider's per-image one in
 * `image-upload-utils`. That one asks "will the model accept this image?"; this
 * asks "will the request carrying it even arrive?". The serverless function
 * fronting `/api/copilotkit` refuses an oversized body with a 413 before the
 * model is reached, so an image can satisfy the provider and still never be
 * seen. Measured on staging: a 2.35 MB body succeeds, a 4.56 MB body is refused.
 */
const MAX_REQUEST_BODY_BYTES = Math.floor(4.5 * 1024 * 1024);

/**
 * Room reserved for everything in the request that is NOT attachment context —
 * message history, agent state, tool definitions, other readables. Attachments
 * get what is left rather than the whole body, since they only share it.
 */
const REQUEST_BODY_HEADROOM_BYTES = 512 * 1024;

/**
 * Budget shared by ALL rag-context entries on one request — chat uploads plus
 * story media plus resolved attachment contexts, because every one of them can
 * carry a base64 image and they all ride the same body.
 *
 * Per-file validation cannot replace this. Two images that each satisfy every
 * per-file rule still exceed the body cap together, which is how a thread died
 * in Fizzy #2167: the offending entry stayed in context, so every later turn —
 * plain text included — was refused too.
 */
export const MAX_TOTAL_CONTEXT_BYTES =
	MAX_REQUEST_BODY_BYTES - REQUEST_BODY_HEADROOM_BYTES;

/**
 * Bytes a finished rag-context entry occupies on the wire. The entry is already
 * a string (base64 data URL included), so its UTF-8 length is what the body
 * pays. `TextEncoder` rather than `Blob` so this stays usable outside a DOM.
 */
export function contextEntryBytes(entry: string): number {
	return new TextEncoder().encode(entry).length;
}
