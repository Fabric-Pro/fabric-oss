/**
 * Bound the report agent loop's returned `gatheredData` to a byte budget so it
 * always fits under Temporal's activity-result blob limit.
 *
 * ROOT CAUSE: `executeAgentDataGatheringLoop` returns
 * `gatheredData` compiled from FULL, unsummarized tool outputs. For a large
 * board this crosses Temporal Cloud's ~2 MiB per-payload gRPC limit; the server
 * rejects the activity completion with "Complete result exceeds size limit."
 * (non-retryable) and the whole report fails. The 12 000-char summarization in
 * the loop only trims what is fed back to the LLM as context — not the returned
 * payload.
 *
 * This trims the RETURN payload (report still generates, marked partial) rather
 * than failing. It mirrors the orchestrator's own budget
 * (`MCP_APP_TOTAL_BUDGET = 1_500_000` in
 * `workflows/orchestrator/phases/completion.ts`) which exists for the same
 * "don't blow Temporal's 2MB payload limit" reason.
 *
 * Pure and deterministic (stable key/array ordering, no Date/Math.random/IO), so
 * it is unit-testable in isolation. Called ONLY from the activity
 * (`report-agent-loop.ts`) — never imported into the workflow bundle — so using
 * `Buffer` here is safe (unlike the workflow-safe `report-data-gate.ts`).
 */

import { isSettledCard } from "./report-board-facts";
import {
	cardMinimalFields,
	cardSteeringFields,
	isCardListTool,
	isPlainObject,
	projectCardForContext,
	slimCardForBudget,
} from "./report-card-pages";
import {
	BOARD_FACTS_KEY,
	COVERAGE_KEY,
	PULL_REQUEST_FACTS_KEY,
} from "./report-data-gate";

/**
 * Default cap for the serialized `gatheredData` payload. Temporal Cloud's
 * per-payload blob limit is 2 MiB (2 097 152 B); ~600 KB of headroom covers the
 * rest of the `AgentLoopResult` envelope (mcpDiagnostics, streamDiagnostics,
 * toolsUsed, error, usage) plus JSON→Payload encoding overhead.
 */
export const DEFAULT_GATHERED_DATA_MAX_BYTES = 1_500_000;

/**
 * Keys the cascade keeps ahead of any record: they describe the whole board in a
 * few kilobytes, however little of the card list fits.
 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
	BOARD_FACTS_KEY,
	COVERAGE_KEY,
	PULL_REQUEST_FACTS_KEY,
]);

/**
 * Cap for a report's card lists, which all go into the analysis prompt. The board
 * facts carry the counts, so the cards need only be good enough to name and
 * describe. The output budget's clamp assumes 2 characters per token, so it reads
 * this as 300,000 tokens: within a 400,000-token context window with the full
 * output ceiling and about 130 KB left for the rest of the prompt. A board of
 * 2,300 cards fits with every card kept, open cards slim and the rest at their
 * steering fields.
 */
export const REPORT_CARD_PAYLOAD_MAX_BYTES = 600_000;

/**
 * Total description text kept on cards fetched on their own while card lists are
 * being shortened. Cards past this total shorten like any other. About 40 cards
 * of 1,000 characters.
 */
export const FETCHED_CARD_TEXT_MAX_BYTES = 40_000;

/** Each rung keeps every card and removes more of what is on it. */
const CARD_LADDER: ReadonlyArray<{
	note: string;
	appliesTo?: (card: unknown) => boolean;
	shrink: (card: unknown) => unknown;
}> = [
	{
		note: "shortened cards to their projected fields",
		shrink: projectCardForContext,
	},
	{
		note: "shortened cards to their slim fields",
		shrink: slimCardForBudget,
	},
	{
		note: "shortened closed and postponed cards to their steering fields",
		appliesTo: isSettledCard,
		shrink: cardSteeringFields,
	},
	{
		note: "shortened cards to their steering fields",
		shrink: cardSteeringFields,
	},
	{
		note: "shortened cards to their minimal fields",
		shrink: cardMinimalFields,
	},
];

/**
 * Floor for the effective gathered-data budget. The last-resort marker
 * (`{_truncated,_reason,_approxBytes}`) serializes to ~81 B, and wrapping it
 * under a top-level tool-name key adds a little more; a budget below this floor
 * cannot hold even one minimal contentful record. We clamp up to it so the
 * `finalBytes ≤ maxBytes` guarantee holds for every input (mirrors
 * `capRenderedReport`'s floor). Production callers clamp to ≥100 KB anyway
 * (`readGatheredDataMaxBytes`), so this only guards direct/pathological callers.
 */
export const MIN_GATHERED_DATA_BUDGET_BYTES = 256;

/** String fields longer than this are truncated first (Stage A). */
export const MAX_FIELD_CHARS = 1000;

/** Depth guard for the recursive string walk (defensive vs pathological nesting). */
const MAX_WALK_DEPTH = 200;

export interface BoundResult {
	/** The bounded data (the same reference when nothing was trimmed). */
	data: Record<string, unknown>;
	/** True when any trimming happened. */
	trimmed: boolean;
	/**
	 * True when a record is gone rather than shortened. Shortening fields keeps
	 * the run complete; losing records makes it partial.
	 */
	recordsDropped: boolean;
	/** Serialized UTF-8 byte size of the input. */
	originalBytes: number;
	/** Serialized UTF-8 byte size of `data` (≤ the effective budget — see `boundGatheredData`). */
	finalBytes: number;
	/** Human-readable list of what was trimmed (for logs + diagnostics). */
	notes: string[];
}

/** UTF-8 byte length of a value's JSON. Unserializable → Infinity (force trim). */
function byteLen(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/** Recursively truncate every string longer than `maxFieldChars` in place. */
function truncateStringsDeep(
	value: unknown,
	maxFieldChars: number,
	counter: { n: number },
	depth: number,
): unknown {
	if (typeof value === "string") {
		if (value.length > maxFieldChars) {
			counter.n++;
			const omitted = value.length - maxFieldChars;
			return `${value.slice(0, maxFieldChars)}…[truncated ${omitted} chars]`;
		}
		return value;
	}
	if (depth >= MAX_WALK_DEPTH) {
		return value;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			value[i] = truncateStringsDeep(
				value[i],
				maxFieldChars,
				counter,
				depth + 1,
			);
		}
		return value;
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		for (const key of Object.keys(obj)) {
			obj[key] = truncateStringsDeep(
				obj[key],
				maxFieldChars,
				counter,
				depth + 1,
			);
		}
		return obj;
	}
	return value;
}

/**
 * The cards whose full description survives shortening, in list order, up to
 * `FETCHED_CARD_TEXT_MAX_BYTES` in total.
 */
function selectFetchedCardsToKeep(
	cardLists: unknown[][],
	fetchedCardIds: ReadonlySet<string>,
): Set<string> {
	const kept = new Set<string>();
	let total = 0;
	for (const card of cardLists.flat()) {
		if (
			!isPlainObject(card) ||
			!fetchedCardIds.has(String(card.id)) ||
			typeof card.description !== "string"
		) {
			continue;
		}
		const size = Buffer.byteLength(card.description, "utf8");
		if (total + size <= FETCHED_CARD_TEXT_MAX_BYTES) {
			kept.add(String(card.id));
			total += size;
		}
	}
	return kept;
}

/**
 * Bound `gatheredData` so its serialized size never exceeds `maxBytes`, and its
 * card lists never exceed `maxCardBytes` when that is given.
 *
 * Cascade (each stage re-measures; returns as soon as it fits):
 *   1. Under budget → return the input unchanged (`trimmed: false`).
 *   2. Stage A — truncate long string fields (drops `description_html` / comment
 *      blobs; keeps ids/status/title/dates). Only the card lists when they alone
 *      are over.
 *   3. Card ladder — shrink cards in a card list one rung at a time (projected,
 *      slim, closed and postponed cards to steering, all to steering, minimal),
 *      so a large board keeps all its cards. `fetchedCardIds` names the cards
 *      fetched on their own, which keep their description through stage A and
 *      every rung, within `FETCHED_CARD_TEXT_MAX_BYTES`.
 *   4. Stage B — cap the largest card lists until they fit `maxCardBytes`, then
 *      the largest top-level arrays (drop tail items; never below one item, so a
 *      data-bearing run is never zeroed).
 *   5. Stage C — drop the largest top-level keys until one data key remains,
 *      then compact that last key's value to a tiny marker if it still exceeds
 *      the budget (never empties the payload — a data-bearing run stays
 *      non-empty).
 *
 * `_board_facts`, `_coverage` and `_pull_request_facts` are reserved: stages A
 * to C leave them alone, and they go only if they alone exceed the budget.
 *
 * The effective budget is `max(maxBytes, MIN_GATHERED_DATA_BUDGET_BYTES)`, so
 * `finalBytes ≤ maxBytes` holds for every realistic input (the minimal marker
 * fits under the floor). Never mutates the caller's object (clones before
 * trimming).
 */
export function boundGatheredData(
	gatheredData: Record<string, unknown>,
	opts: {
		maxBytes?: number;
		maxFieldChars?: number;
		maxCardBytes?: number;
		fetchedCardIds?: ReadonlySet<string>;
	} = {},
): BoundResult {
	const maxBytes = Math.max(
		MIN_GATHERED_DATA_BUDGET_BYTES,
		opts.maxBytes ?? DEFAULT_GATHERED_DATA_MAX_BYTES,
	);
	const maxFieldChars = opts.maxFieldChars ?? MAX_FIELD_CHARS;
	const maxCardBytes = opts.maxCardBytes ?? maxBytes;
	const cardListKeys = Object.keys(gatheredData).filter(
		(key) => isCardListTool(key) && Array.isArray(gatheredData[key]),
	);

	const originalJson = (() => {
		try {
			return JSON.stringify(gatheredData) ?? "null";
		} catch {
			return null;
		}
	})();
	const originalBytes =
		originalJson === null
			? Number.POSITIVE_INFINITY
			: Buffer.byteLength(originalJson, "utf8");

	const cardBytes = (source: Record<string, unknown>) =>
		cardListKeys.reduce((sum, key) => sum + byteLen(source[key]), 0);

	if (originalBytes <= maxBytes && cardBytes(gatheredData) <= maxCardBytes) {
		return {
			data: gatheredData,
			trimmed: false,
			recordsDropped: false,
			originalBytes,
			finalBytes: originalBytes,
			notes: [],
		};
	}

	const notes: string[] = [];
	let recordsDropped = false;
	// Clone so the caller's object is never mutated. Reuse the measured JSON when
	// possible; fall back to structuredClone for unserializable-but-cloneable data.
	const data: Record<string, unknown> =
		originalJson !== null
			? JSON.parse(originalJson)
			: (structuredClone(gatheredData) as Record<string, unknown>);

	const fetchedCardsToKeep = selectFetchedCardsToKeep(
		cardListKeys.map((key) => data[key] as unknown[]),
		opts.fetchedCardIds ?? new Set<string>(),
	);
	// Read the description first: Stage A rewrites strings in place.
	const shrinkCard = (card: unknown, shrink: (card: unknown) => unknown) => {
		const description =
			isPlainObject(card) && fetchedCardsToKeep.has(String(card.id))
				? card.description
				: undefined;
		const shrunk = shrink(card);
		return description !== undefined && isPlainObject(shrunk)
			? { ...shrunk, description }
			: shrunk;
	};

	// Stage A — truncate long string fields.
	const counter = { n: 0 };
	const truncate = (value: unknown) =>
		truncateStringsDeep(value, maxFieldChars, counter, 0);
	for (const key of cardListKeys) {
		data[key] = (data[key] as unknown[]).map((card) =>
			shrinkCard(card, truncate),
		);
	}
	if (byteLen(data) > maxBytes) {
		for (const key of Object.keys(data)) {
			if (!RESERVED_KEYS.has(key) && !cardListKeys.includes(key)) {
				data[key] = truncate(data[key]);
			}
		}
	}
	if (counter.n > 0) {
		notes.push(
			`truncated ${counter.n} long string field(s) to ${maxFieldChars} chars`,
		);
	}

	// Card ladder — shorten every card before any card is given up. `_board_facts`
	// already holds the counts, so what a card loses here is detail, not coverage.
	for (const rung of CARD_LADDER) {
		if (
			cardListKeys.length === 0 ||
			(byteLen(data) <= maxBytes && cardBytes(data) <= maxCardBytes)
		) {
			break;
		}
		for (const key of cardListKeys) {
			data[key] = (data[key] as unknown[]).map((card) =>
				!rung.appliesTo || rung.appliesTo(card)
					? shrinkCard(card, rung.shrink)
					: card,
			);
		}
		notes.push(rung.note);
	}

	// Stage B — cap the largest of `keys`' arrays. Never reduce an array below one
	// item (only arrays with >1 item are candidates), so trimming for size can
	// never zero out the records a run actually gathered — a run that gathered
	// abundant data must not be misread as "no usable data" and hard-failed
	// (that is the #1750 class of failure this fix exists to prevent).
	const capLargestArray = (keys: string[]): boolean => {
		let bestKey: string | null = null;
		let bestSize = -1;
		for (const key of keys) {
			const value = data[key];
			if (Array.isArray(value) && value.length > 1) {
				const size = byteLen(value);
				if (
					size > bestSize ||
					(size === bestSize && (bestKey === null || key < bestKey))
				) {
					bestSize = size;
					bestKey = key;
				}
			}
		}
		if (bestKey === null) {
			return false; // no array with >1 item left to reduce
		}
		const arr = data[bestKey] as unknown[];
		const before = arr.length;
		const remove = Math.max(1, Math.floor(before * 0.2));
		arr.length = Math.max(1, before - remove); // keep at least one record
		recordsDropped = true;
		const omitted = before - arr.length;
		const existing = notes.find((n) => n.startsWith(`capped ${bestKey}:`));
		if (existing) {
			// Update the running tally for repeated reductions of the same array.
			const total =
				Number(existing.match(/\((\d+) omitted\)/)?.[1] ?? 0) + omitted;
			notes[notes.indexOf(existing)] =
				`capped ${bestKey}: → ${arr.length} items (${total} omitted)`;
		} else {
			notes.push(
				`capped ${bestKey}: ${before} → ${arr.length} items (${omitted} omitted)`,
			);
		}
		return true;
	};
	let guard = 0;
	while (cardBytes(data) > maxCardBytes && guard++ < 100_000) {
		if (!capLargestArray(cardListKeys)) {
			break;
		}
	}
	guard = 0;
	while (byteLen(data) > maxBytes && guard++ < 100_000) {
		if (!capLargestArray(Object.keys(data))) {
			break; // → Stage C
		}
	}

	// Stage C — drop the largest top-level keys, but never the last data key, so
	// the payload never becomes `{}` when the input had content.
	//
	// Other `_`-prefixed keys (gathering metadata such as `_board_fix`) are dropped
	// BEFORE any data key, regardless of size. Within each class the largest key
	// still goes first, ties broken by key name, so the cascade stays
	// deterministic.
	const droppableKeys = () =>
		Object.keys(data).filter((key) => !RESERVED_KEYS.has(key));
	guard = 0;
	while (
		byteLen(data) > maxBytes &&
		droppableKeys().length > 1 &&
		guard++ < 100_000
	) {
		let bestKey: string | null = null;
		let bestSize = -1;
		let bestIsMeta = false;
		for (const key of droppableKeys()) {
			const size = byteLen(data[key]);
			const isMeta = key.startsWith("_");
			const better =
				bestKey === null
					? true
					: isMeta !== bestIsMeta
						? isMeta
						: size > bestSize ||
							(size === bestSize && key < bestKey);
			if (better) {
				bestSize = size;
				bestKey = key;
				bestIsMeta = isMeta;
			}
		}
		if (bestKey === null) {
			break;
		}
		delete data[bestKey];
		recordsDropped ||= !bestIsMeta;
		notes.push(
			`dropped key ${bestKey} (~${bestSize} bytes) to fit size budget`,
		);
	}

	// Last resort: a single remaining key whose value still exceeds the budget
	// (pathological — a single record too large to fit even after Stage A) is
	// compacted to a tiny marker. This keeps the payload non-empty (still one
	// contentful record for the no-usable-data gate) AND under budget.
	const compactToMarker = (key: string) => {
		const approx = byteLen(data[key]);
		data[key] = {
			_truncated: true,
			_reason: "record exceeds size budget",
			_approxBytes: approx,
		};
		recordsDropped = true;
		notes.push(
			`compacted key ${key} (~${approx} bytes) to a marker to fit size budget`,
		);
	};
	const remaining = droppableKeys();
	if (byteLen(data) > maxBytes && remaining.length === 1) {
		compactToMarker(remaining[0] as string);
	}

	// Reserved keys go only when they alone are over budget, which takes a
	// pathologically small budget: production floors it at 100 KB.
	while (byteLen(data) > maxBytes && Object.keys(data).length > 1) {
		const reserved = Object.keys(data)
			.filter((key) => RESERVED_KEYS.has(key))
			.sort(
				(a, b) =>
					byteLen(data[b]) - byteLen(data[a]) || (a < b ? -1 : 1),
			)[0];
		if (reserved === undefined) {
			break;
		}
		delete data[reserved];
		notes.push(`dropped reserved key ${reserved} to fit size budget`);
	}
	const lastKeys = Object.keys(data);
	if (byteLen(data) > maxBytes && lastKeys.length === 1) {
		compactToMarker(lastKeys[0] as string);
	}

	const finalBytes = byteLen(data);
	return {
		data,
		trimmed: true,
		recordsDropped,
		originalBytes,
		finalBytes,
		notes,
	};
}

/**
 * Default cap for a rendered report string. The rendered markdown/HTML ALSO
 * travels through Temporal history (it is the return of `renderInstanceReport`
 * and the input of `storeInstanceArtifact`), so a data-heavy template — e.g. a
 * `data` section that pretty-prints the full source, or several sections
 * embedding the same source — can exceed the ~2 MiB blob limit even after the
 * gathered data was bounded. 1.5 MB leaves room
 * for the `wrapInHtml` wrapper the workflow adds afterward.
 */
export const DEFAULT_RENDERED_REPORT_MAX_BYTES = 1_500_000;

export interface CapResult {
	text: string;
	truncated: boolean;
	originalBytes: number;
	finalBytes: number;
}

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character, preferring to cut at the last newline in the kept
 * portion so we break between rendered lines rather than mid-element.
 */
function truncateToBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return text;
	}
	// Largest char index whose slice fits in maxBytes (binary search).
	let lo = 0;
	let hi = text.length;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	let cut = lo;
	// Don't end on a lone high surrogate (would encode as a replacement char).
	if (cut > 0 && cut < text.length) {
		const code = text.charCodeAt(cut - 1);
		if (code >= 0xd800 && code <= 0xdbff) {
			cut -= 1;
		}
	}
	const slice = text.slice(0, cut);
	const lastNewline = slice.lastIndexOf("\n");
	// Prefer a newline boundary, but only if it doesn't discard too much.
	return lastNewline > cut * 0.5 ? slice.slice(0, lastNewline) : slice;
}

/**
 * Cap a rendered report string to a byte budget so the render activity's return
 * (and the artifact-store input) always fit under Temporal's payload limit. When
 * over budget, the tail is dropped and a visible truncation notice is appended.
 * Pure and deterministic.
 */
export function capRenderedReport(
	text: string,
	opts: { maxBytes?: number; isHtml?: boolean } = {},
): CapResult {
	const maxBytes = Math.max(
		1,
		opts.maxBytes ?? DEFAULT_RENDERED_REPORT_MAX_BYTES,
	);
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= maxBytes) {
		return {
			text,
			truncated: false,
			originalBytes,
			finalBytes: originalBytes,
		};
	}
	const notice = opts.isHtml
		? '\n<p class="report-partial-notice"><strong>⚠️ Report truncated</strong> — this report was too large to store in full and was cut to fit. Narrow the date range or data scope for the complete report.</p>'
		: "\n\n> ⚠️ **Report truncated** — this report was too large to store in full and was cut to fit. Narrow the date range or data scope for the complete report.\n";
	const noticeBytes = Buffer.byteLength(notice, "utf8");
	// Pathologically small budget — smaller than the notice itself. Return a
	// hard-truncated notice (still multi-byte-safe) so `finalBytes ≤ maxBytes`
	// holds unconditionally, even if the notice text is later lengthened past the
	// budget. Prod never hits this (default budget is 1.5 MB), but the contract
	// must not depend on a coincidental notice-vs-budget margin.
	if (noticeBytes >= maxBytes) {
		const clamped = truncateToBytes(notice, maxBytes);
		return {
			text: clamped,
			truncated: true,
			originalBytes,
			finalBytes: Buffer.byteLength(clamped, "utf8"),
		};
	}
	const body = truncateToBytes(text, maxBytes - noticeBytes);
	const out = body + notice;
	return {
		text: out,
		truncated: true,
		originalBytes,
		finalBytes: Buffer.byteLength(out, "utf8"),
	};
}
