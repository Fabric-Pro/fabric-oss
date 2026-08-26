/**
 * Inspects a Vercel AI SDK 6 stream part and returns the reasoning text it
 * carries, or null if the part is not a reasoning chunk with content.
 *
 * AI SDK 6 has multiple `reasoning-delta` shapes depending on the stream union:
 *
 *   - `TextStreamPart<TOOLS>` (what `streamText().fullStream` emits — verified at
 *     `apps/web/node_modules/ai/dist/index.d.ts:2592, 2614`):
 *       { type: "reasoning-delta", id: string, text: string }   ← `text`
 *
 *   - `UIMessageChunk` (line 2090) and `SingleRequestTextStreamPart` (line 4573):
 *       { type: "reasoning-delta", id: string, delta: string }  ← `delta`
 *
 * This helper reads `text` first (the actual `fullStream` surface) and falls back
 * to `delta` (defensive, for forward-compat or middleware that normalises onto the
 * other union). Returns null when neither is a non-empty string.
 *
 * Background: an earlier draft of this helper read only `delta` because the plan
 * iteration verified the `UIMessageChunk` shape (line 2090) instead of
 * `TextStreamPart` (line 2592). That bug returned `null` for every chunk emitted
 * by `streamText().fullStream` and made the reasoning trace feature non-functional
 * in production. Reading both fields prevents a recurrence on future SDK shape
 * shifts.
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
	// Prefer `text` (TextStreamPart shape — what fullStream actually emits).
	if (typeof p.text === "string" && p.text.length > 0) {
		return p.text;
	}
	// Fall back to `delta` (other SDK 6 unions; defensive against shape drift).
	if (typeof p.delta === "string" && p.delta.length > 0) {
		return p.delta;
	}
	return null;
}
