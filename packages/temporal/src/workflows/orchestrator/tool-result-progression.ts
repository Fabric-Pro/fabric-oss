/**
 * Pure helpers that keep a tool result usable for the model's next step in
 * the iterative loop. No imports, no I/O, clocks or randomness: safe inside
 * the Temporal workflow sandbox, and the same input always gives the same
 * output, so replay rebuilds identical activity inputs.
 */

/**
 * Fabric reads that return one page of a long body plus `truncated` /
 * `nextOffset` (activities/shared/project-document-reads.ts).
 */
export const PAGED_BODY_READ_TOOLS: ReadonlySet<string> = new Set([
	"fabric_get_project_document",
	"fabric_get_project_source",
]);

/**
 * Cap the page a paged body read asks for at `maxLength` characters. A
 * missing or non-numeric `maxLength` becomes the cap; a smaller one is kept.
 * The read's own default (15,000) is larger than the loop's result cap, so
 * without this a default read was summarized and lost its `nextOffset`.
 */
export function fitPagedBodyReadArgs(
	args: Record<string, unknown>,
	maxLength: number,
): Record<string, unknown> {
	const requested =
		typeof args.maxLength === "number" && Number.isFinite(args.maxLength)
			? Math.trunc(args.maxLength)
			: undefined;
	return {
		...args,
		maxLength:
			requested !== undefined && requested >= 1
				? Math.min(requested, maxLength)
				: maxLength,
	};
}

/**
 * Keys that tell a caller how to fetch more. One must be present for a note;
 * their values are kept exactly (up to {@link MAX_CONTINUATION_VALUE}).
 */
const CONTINUATION_KEYS = new Set([
	"truncated",
	"isTruncated",
	"hasMore",
	"has_more",
	"hasNextPage",
	"has_next_page",
	"nextOffset",
	"next_offset",
	"nextCursor",
	"next_cursor",
	"cursor",
	"endCursor",
	"end_cursor",
	"nextPageToken",
	"next_page_token",
	"nextPage",
	"next_page",
	"nextLink",
	"next_link",
	"next",
	"@odata.nextLink",
]);

/** Optional position keys, kept only while the note has room. */
const POSITION_KEYS = new Set([
	"offset",
	"returnedLength",
	"contentLength",
	"total",
	"totalCount",
	"total_count",
	"page",
	"limit",
]);

/** Longest continuation value kept as is; a longer one is marked instead. */
const MAX_CONTINUATION_VALUE = 2_048;
/** Longest position string kept (positions are normally numbers). */
const MAX_POSITION_STRING = 200;
/** At most this many fields in one note. */
const MAX_NOTE_FIELDS = 12;
/** Hard bound on the whole note, in characters. */
export const MAX_CONTINUATION_NOTE_CHARS = 2_500;
/**
 * Ceiling the note may grow to so continuation tokens survive in their
 * rendered (JSON-escaped) form: a 2,048-character token of quotes renders at
 * about twice that. Half the loop's result cap; the caller reserves the
 * note's real length, so content + note + label still fit.
 */
export const MAX_CONTINUATION_NOTE_HARD_CHARS = 6_000;

type FieldValue = string | number | boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tooLongMarker(length: number): string {
	return `[continuation token too long to keep (${length} characters); narrow the request so the result fits on fewer pages]`;
}

function isContinuationPath(path: string): boolean {
	return CONTINUATION_KEYS.has(path.slice(path.lastIndexOf(".") + 1));
}

/** Top level and one nested level only: deeper objects are not read. */
function collectFields(
	value: Record<string, unknown>,
	prefix: string,
	nested: boolean,
	continuation: Array<[string, FieldValue]>,
	position: Array<[string, FieldValue]>,
): void {
	for (const [key, field] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (CONTINUATION_KEYS.has(key)) {
			if (typeof field === "number" || typeof field === "boolean") {
				continuation.push([path, field]);
			} else if (typeof field === "string") {
				continuation.push([
					path,
					field.length <= MAX_CONTINUATION_VALUE
						? field
						: tooLongMarker(field.length),
				]);
			}
		} else if (POSITION_KEYS.has(key)) {
			if (
				typeof field === "number" ||
				typeof field === "boolean" ||
				(typeof field === "string" &&
					field.length <= MAX_POSITION_STRING)
			) {
				position.push([path, field]);
			}
		} else if (!nested && isPlainObject(field)) {
			collectFields(field, path, true, continuation, position);
		}
	}
}

function fieldsOf(value: unknown): Record<string, FieldValue> | null {
	if (!isPlainObject(value)) {
		return null;
	}
	const continuation: Array<[string, FieldValue]> = [];
	const position: Array<[string, FieldValue]> = [];
	collectFields(value, "", false, continuation, position);
	if (continuation.length === 0) {
		return null;
	}
	// Continuation fields first; optional position fields fill what is left.
	return Object.fromEntries(
		[...continuation, ...position].slice(0, MAX_NOTE_FIELDS),
	);
}

/**
 * The pagination fields of a full tool result, read from its text when that
 * is a JSON object, else from the raw result object (or an MCP result's
 * `structuredContent`). Null when the result carries no continuation key.
 */
export function extractContinuationFields(
	resultText: string,
	rawResult: unknown,
): Record<string, FieldValue> | null {
	const trimmed = resultText.trim();
	if (trimmed.startsWith("{")) {
		try {
			const fromText = fieldsOf(JSON.parse(trimmed));
			if (fromText) {
				return fromText;
			}
		} catch {
			// Not JSON (or cut short) — fall through to the raw result.
		}
	}
	const fromRaw = fieldsOf(rawResult);
	if (fromRaw) {
		return fromRaw;
	}
	return isPlainObject(rawResult)
		? fieldsOf(rawResult.structuredContent)
		: null;
}

function noteText(fields: Record<string, FieldValue>): string {
	return `\n\n[Host note: the full result was too long to show as is. Its pagination fields, copied exactly: ${JSON.stringify(fields)}. Use them to request the next part.]`;
}

/**
 * Appended after a summarized or truncated result that had pagination.
 * Optional position fields are dropped first to keep the note within
 * {@link MAX_CONTINUATION_NOTE_CHARS}. Continuation tokens (each at most
 * 2,048 raw characters) are kept exactly even when JSON escaping renders
 * them longer: the note may grow to {@link MAX_CONTINUATION_NOTE_HARD_CHARS}
 * for them. Past that, the longest token is replaced by a marker, then
 * trailing fields are dropped.
 */
export function formatContinuationNote(
	fields: Record<string, FieldValue>,
): string {
	const entries = Object.entries(fields);
	const build = () => noteText(Object.fromEntries(entries));
	let note = build();
	while (note.length > MAX_CONTINUATION_NOTE_CHARS) {
		let lastPosition = -1;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (!isContinuationPath(entries[i][0])) {
				lastPosition = i;
				break;
			}
		}
		if (lastPosition < 0) {
			break;
		}
		entries.splice(lastPosition, 1);
		note = build();
	}
	while (
		note.length > MAX_CONTINUATION_NOTE_HARD_CHARS &&
		entries.length > 0
	) {
		let longest = -1;
		for (let i = 0; i < entries.length; i++) {
			const value = entries[i][1];
			if (
				typeof value === "string" &&
				!value.startsWith("[continuation token too long") &&
				(longest < 0 ||
					JSON.stringify(value).length >
						JSON.stringify(entries[longest][1]).length)
			) {
				longest = i;
			}
		}
		if (longest >= 0) {
			entries[longest] = [
				entries[longest][0],
				tooLongMarker(String(entries[longest][1]).length),
			];
		} else {
			entries.pop();
		}
		note = build();
	}
	return entries.length > 0 ? note : "";
}

/**
 * `text` cut so that it plus its truncation marker is at most `limit`
 * characters (the marker counts toward the limit).
 */
export function truncateWithinLimit(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	// The marker's digits are at most those of text.length, so sizing it
	// with that bound keeps the total within the limit.
	const markerFor = (omitted: number) =>
		`\n... [TRUNCATED: ${omitted} chars omitted]`;
	const room = limit - markerFor(text.length).length;
	if (room <= 0) {
		// No room for the marker itself: a plain cut still honours the limit.
		return text.slice(0, Math.max(0, limit));
	}
	return text.slice(0, room) + markerFor(text.length - room);
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (isPlainObject(value)) {
		// No prototype: an own "__proto__" key stays an ordinary key instead
		// of setting the prototype (which silently dropped it).
		const sorted: Record<string, unknown> = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortKeysDeep(value[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * JSON with object keys sorted at every depth (array order kept), so two
 * values with the same content serialize identically.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value)) ?? "";
}

/** Name plus key-order-independent args: two identical requests match. */
export function canonicalToolCallKey(
	name: string,
	args: Record<string, unknown>,
): string {
	return `${name}\u0000${canonicalJson(args ?? {})}`;
}

/** 32-bit FNV-1a over UTF-16 code units, from a given offset basis. */
function fnv1a(text: string, basis: number): string {
	let hash = basis >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * A compact identity for a result's text: its length and two independent
 * 32-bit hashes, so the loop need not keep every full result to compare.
 */
export function fingerprintObservation(text: string): string {
	return `${text.length}:${fnv1a(text, 0x811c9dc5)}:${fnv1a(text, 0x01000193)}`;
}

/** Prefixed to a result identical to an earlier same call in this turn. */
export function formatRepeatedObservationNote(firstIteration: number): string {
	return `[Host note: this call and its result repeat the observation from iteration ${firstIteration} of this turn; repeating it will not produce new information.]\n`;
}
