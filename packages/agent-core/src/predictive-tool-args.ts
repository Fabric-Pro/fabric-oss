/**
 * Predictive tool-call argument accumulator.
 *
 * LangGraph's `messages` stream mode delivers a tool call's arguments as a
 * sequence of partial JSON string chunks (`tool_call_chunks`). Several agents
 * (document generators, prompt enhancer) accumulate these chunks and
 * regex-extract a single string field out of the still-incomplete JSON so the
 * frontend can show a live preview of the value being generated —
 * "predictive state" streaming.
 *
 * This class replaces the ad-hoc buffer + inline regex each agent used to
 * duplicate, fixing three problems the ad-hoc version had:
 *   1. The buffer was never reset between tool-call attempts within one
 *      stream, so a retried tool call (e.g. after a corrective ToolMessage)
 *      kept appending onto the previous attempt's leftover content.
 *   2. Extraction ran on every single chunk — a regex match plus five
 *      full-string `.replace` unescape passes over the entire accumulated
 *      buffer, for every token. On a large document this is O(n^2) over the
 *      stream.
 *   3. A single `active` flag can't survive interleaved PARALLEL tool calls
 *      (`parallel_tool_calls: true`): a named chunk for a different call
 *      would deactivate the target mid-stream, and that other call's
 *      continuation chunks (which also arrive with no `name`) could get
 *      appended into the target's buffer. `tool_call_chunks` carry an
 *      `index` identifying which call a chunk belongs to — see `push` for
 *      how it's used to disambiguate.
 */

/** Escapes regex metacharacters so a string can be interpolated into a RegExp literally. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PredictiveToolArgsAccumulator {
	private readonly toolName: string;
	private readonly argKey: string;
	private readonly argPattern: RegExp;
	private readonly minEmitIntervalMs: number;
	private readonly minGrowthChars: number;

	private buffer = "";
	private active = false;
	// The tool_call_chunks `index` of the call currently being accumulated,
	// when known. `undefined` means either no target call is active, or the
	// active call started without an index — in the latter case index-based
	// disambiguation is unavailable and every named chunk falls back to the
	// original any-name-resets behavior (see `push`).
	private activeIndex: number | undefined;
	private lastEmitted = "";
	private lastEmitTime = 0;
	private lastExtractedAtLength = 0;

	constructor(opts: {
		toolName: string;
		argKey: string;
		minEmitIntervalMs?: number;
		minGrowthChars?: number;
	}) {
		this.toolName = opts.toolName;
		this.argKey = opts.argKey;
		this.minEmitIntervalMs = opts.minEmitIntervalMs ?? 150;
		this.minGrowthChars = opts.minGrowthChars ?? 4096;
		// Mirrors the regex every call site hand-rolled, with argKey templated
		// in: match the key, then greedily capture unescaped/escaped-pair
		// characters up to the closing quote — or to end-of-buffer when the
		// value is still being streamed and has no closing quote yet. argKey
		// is escaped before interpolation — every current call site passes a
		// plain identifier, but an unescaped key containing regex
		// metacharacters (e.g. a future "doc.key[0]") would mismatch or throw.
		this.argPattern = new RegExp(
			`"${escapeRegExp(this.argKey)}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`,
		);
	}

	private reset(active: boolean, activeIndex: number | undefined) {
		this.buffer = "";
		this.lastEmitted = "";
		this.lastExtractedAtLength = 0;
		this.lastEmitTime = 0;
		this.active = active;
		this.activeIndex = activeIndex;
	}

	/**
	 * Feed one streamed tool_call_chunk. Returns the new partial arg content
	 * to emit, or null when throttled / unchanged / not the target tool.
	 * `now` is injected for testability (callers pass Date.now()).
	 */
	push(
		chunk: { name?: string; id?: string; args?: string; index?: number },
		now: number,
	): string | null {
		// A chunk carrying a non-empty `name` starts a NEW tool call —
		// OpenAI-compatible providers send `name: ""` on continuation deltas,
		// so an empty string is treated as a continuation, not a boundary.
		if (chunk.name) {
			if (chunk.name === this.toolName) {
				// Our target call is (re)starting. Reset unconditionally so
				// content from a prior attempt (e.g. a retried generation
				// within the same stream) never leaks into this one, and
				// clear lastEmitTime so the new call's first extraction isn't
				// throttled by a previous call's emit time.
				this.reset(true, chunk.index);
			} else if (
				chunk.index === undefined ||
				this.activeIndex === undefined
			) {
				// No usable index on either side — can't disambiguate
				// interleaved calls, so fall back to the original behavior:
				// any other tool starting ends whatever call was active.
				this.reset(false, undefined);
			} else if (chunk.index === this.activeIndex) {
				// The index we were tracking got reused by a different tool
				// — our target call at that index is over.
				this.reset(false, undefined);
			}
			// else: a different index started a different (non-target) call
			// in parallel — leave the target call's state untouched.
		}

		// Continuation chunks (no name, or an empty-string name) accumulate
		// only while a target call is active, and — when both sides know
		// their index — only for the SAME call the active buffer belongs to.
		// This is what keeps an interleaved parallel call's continuation
		// chunks (which also arrive with no name) out of the target buffer.
		const indexesKnown =
			chunk.index !== undefined && this.activeIndex !== undefined;
		if (
			!this.active ||
			!chunk.args ||
			(indexesKnown && chunk.index !== this.activeIndex)
		) {
			return null;
		}

		this.buffer += chunk.args;

		const grewEnough =
			this.buffer.length - this.lastExtractedAtLength >=
			this.minGrowthChars;
		const dueByTime = now - this.lastEmitTime >= this.minEmitIntervalMs;
		if (!grewEnough && !dueByTime) {
			return null;
		}
		this.lastExtractedAtLength = this.buffer.length;

		const match = this.buffer.match(this.argPattern);
		const rawValue = match?.[1];
		if (!rawValue) {
			return null;
		}

		// Unescape the partial JSON string value. The authoritative final
		// value arrives via the node's "updates" event once the tool call
		// completes and is JSON.parse'd properly — this partial value is a
		// preview only, so dropping a trailing incomplete escape sequence
		// (the `(?:[^"\\]|\\.)*` above already stops before a dangling `\`)
		// is safe: the next chunk's extraction will include it.
		const value = rawValue
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\r/g, "\r")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");

		if (value.length === 0 || value === this.lastEmitted) {
			return null;
		}

		this.lastEmitted = value;
		this.lastEmitTime = now;
		return value;
	}
}
