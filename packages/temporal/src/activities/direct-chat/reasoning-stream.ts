/**
 * Inspects a Vercel AI SDK 7 stream part and returns the reasoning text it
 * carries, or null if the part is not a reasoning chunk with content.
 *
 * The SDK has multiple `reasoning-delta` shapes depending on the stream union,
 * and 7 did not change them — only the property the stream is read from, which
 * is `streamText().stream` where 6 had `fullStream`:
 *
 *   - `TextStreamPart<TOOLS>` (what `streamText().stream` emits):
 *       { type: "reasoning-delta", id: string, text: string }   ← `text`
 *
 *   - `UIMessageChunk` and `SingleRequestTextStreamPart`:
 *       { type: "reasoning-delta", id: string, delta: string }  ← `delta`
 *
 * This helper reads `text` first (the actual `stream` surface) and falls back
 * to `delta` (defensive, for forward-compat or middleware that normalises onto the
 * other union). Returns null when neither is a non-empty string.
 *
 * Background: an earlier draft of this helper read only `delta` because the plan
 * iteration verified the `UIMessageChunk` shape instead of `TextStreamPart`.
 * That bug returned `null` for every chunk emitted by the streamText stream and
 * made the reasoning trace feature non-functional in production. Reading both
 * fields prevents a recurrence on future SDK shape shifts.
 *
 * `reasoning-start` and `reasoning-end` carry no content; this helper returns
 * null for both. Timing capture in the activity loop reads `part.type` directly.
 */
export function extractReasoningText(part: unknown): string | null {
	if (typeof part !== "object" || part === null) {
		return null;
	}
	const p = part as { type?: string; text?: unknown; delta?: unknown };
	if (p.type !== "reasoning-delta") {
		return null;
	}
	// Prefer `text` (TextStreamPart shape — what the streamText stream emits).
	if (typeof p.text === "string" && p.text.length > 0) {
		return p.text;
	}
	// Fall back to `delta` (the other SDK unions; defensive against shape drift).
	if (typeof p.delta === "string" && p.delta.length > 0) {
		return p.delta;
	}
	return null;
}
