/**
 * Payload elision helpers for Temporal boundaries (Fizzy #1997).
 *
 * Companions to `payload-size-guard.ts`. The guard fails loudly past the
 * gRPC frame; these helpers let a boundary DEGRADE instead of fail when the
 * data is bulk-but-dispensable: a board listing whose card bodies push the
 * return past the frame still completes, carrying every card's identity and
 * a truncated body, rather than stalling the whole sync the way the
 * unguarded completion rejection did (#1741 class).
 *
 * Pure and dependency-free so both activities and the workflow sandbox can
 * import them.
 */

import { measureSerializedBytes } from "./payload-size-guard";

/** Description length caps tried in order before dropping bodies entirely. */
export const DESCRIPTION_CAP_LADDER = [8000, 2000, 500, 200] as const;

/** Marker appended to an elided field so a shortened value is self-evident. */
export const ELISION_MARKER = "\n[truncated to fit payload budget]";

export interface SlimmableWorkItem {
	description?: string | null;
	/** Raw provider payload — re-fetchable per item via the get tool, so it is
	 *  the LAST thing dropped (after every description rung fails to fit). */
	raw?: unknown;
}

export interface SlimmedWorkItems<T> {
	items: T[];
	/** Serialized size of the returned items array. */
	bytes: number;
	/** False only when even fully-stripped items exceed the budget — the
	 *  caller should treat that as a guard violation, not degrade further. */
	fits: boolean;
	/** Items whose description was shortened or marker-replaced. */
	elidedDescriptions: number;
	/** Items whose `raw` provider payload was dropped. */
	droppedRaw: number;
}

function truncateDescription(value: string, cap: number): string {
	if (value.length <= cap) {
		return value;
	}
	return value.slice(0, cap) + ELISION_MARKER;
}

/**
 * Provider junk (null elements) is dropped once, here — every later pass
 * works on `T[]`. The single cast is the "we just checked there are no
 * nulls" fast path; the filter branch carries the real guarantee.
 */
function withoutNulls<T extends SlimmableWorkItem>(
	items: Array<T | null>,
): T[] {
	if (!items.some((item) => item == null)) {
		return items as T[];
	}
	return items.filter((item): item is T => item != null);
}

/**
 * Bound a listing of work-item summaries to a serialized byte budget by
 * progressively shortening `description`, then dropping `raw`, across all
 * items uniformly. Identity fields (id/title/state/labels/urls) are never
 * touched — the result stays a complete listing, just with lighter bodies.
 *
 * Passes: as-is → each {@link DESCRIPTION_CAP_LADDER} cap → descriptions
 * replaced with the elision marker AND `raw` stripped. The first pass that
 * fits wins; if none fit the last pass is returned with `fits: false`.
 * Null elements (junk from providers) are dropped once at entry.
 */
export function slimWorkItemSummaries<T extends SlimmableWorkItem>(
	items: Array<T | null>,
	budgetBytes: number,
): SlimmedWorkItems<T> {
	const safeItems = withoutNulls(items);
	const originalBytes = measureSerializedBytes(safeItems);
	if (originalBytes <= budgetBytes) {
		return {
			items: safeItems,
			bytes: originalBytes,
			fits: true,
			elidedDescriptions: 0,
			droppedRaw: 0,
		};
	}

	const countElided = (before: Array<T>, after: Array<T>): number =>
		before.filter(
			(item, i) =>
				(item.description ?? null) !== (after[i].description ?? null),
		).length;

	let last: { items: T[]; bytes: number } = {
		items: safeItems,
		bytes: originalBytes,
	};

	for (const cap of DESCRIPTION_CAP_LADDER) {
		const next = safeItems.map((item) => ({
			...item,
			description: item.description
				? truncateDescription(item.description, cap)
				: item.description,
		}));
		const bytes = measureSerializedBytes(next);
		if (bytes <= budgetBytes) {
			return {
				items: next,
				bytes,
				fits: true,
				elidedDescriptions: countElided(safeItems, next),
				droppedRaw: 0,
			};
		}
		last = { items: next, bytes };
	}

	// Last resort: replace bodies AND drop raw payloads entirely. The
	// description becomes the elision marker rather than vanishing so the
	// loss stays visible and downstream re-fetch triggers (which match on the
	// marker) still fire. Body-less items keep their null — stamping them
	// would fake a "truncated" body and spuriously fire re-fetches.
	const stripped = safeItems.map((item) => ({
		...item,
		description: item.description
			? ELISION_MARKER.trimStart()
			: item.description,
		raw: undefined,
	}));
	const strippedBytes = measureSerializedBytes(stripped);
	return {
		items: stripped,
		bytes: strippedBytes,
		fits: strippedBytes <= budgetBytes,
		elidedDescriptions: countElided(last.items, stripped),
		droppedRaw: safeItems.filter((item) => item.raw !== undefined).length,
	};
}

/**
 * Serialized byte budget for ONE MCP tool result crossing back from
 * `executeMcpTool`. Well under the guard so several tool calls can share a
 * workflow iteration without stacking up against the frame; aligned in
 * spirit with the orchestrator's own total-output budgets.
 */
export const MCP_TOOL_RESULT_MAX_BYTES = 512 * 1024;

export interface TruncatedMcpOutput {
	output: unknown;
	/** True when any text block was shortened to fit. */
	truncated: boolean;
	originalBytes: number;
	/** Bytes elided across all shortened text blocks (0 when not truncated). */
	elidedBytes: number;
}

interface McpContentBlock {
	type?: string;
	text?: string;
}

function mcpContentBlocks(output: unknown): McpContentBlock[] | null {
	if (!output || typeof output !== "object") {
		return null;
	}
	const content = (output as Record<string, unknown>).content;
	return Array.isArray(content) ? (content as McpContentBlock[]) : null;
}

/** A conservative shape check — good enough to refuse cutting, not to parse. */
function isJsonShaped(text: string): boolean {
	const start = text.trimStart()[0];
	return start === "{" || start === "[";
}

/**
 * Bound an MCP tool result by shortening its `content[].text` blocks until
 * the serialized output fits `budgetBytes`. Structure is preserved exactly —
 * block order, types, and non-text blocks are copied untouched.
 *
 * A block whose text is JSON-shaped ({@link isJsonShaped}) is NEVER cut:
 * programmatic consumers `JSON.parse` these (e.g. PM listing pages), and a
 * mid-document cut turns a working sync into corrupt data — which downstream
 * can be misread far worse than a failure (a broken page parsed as "no
 * items" has deleted whole boards' worth of synced stories). JSON-shaped
 * oversize is left for the caller's size guard to fail loudly instead.
 *
 * Returns the input untouched (`truncated: false`) when it already fits, has
 * no recognizable `content` array, or only offers JSON-shaped text to cut;
 * the caller's size guard then decides whether that is fatal.
 */
export function truncateMcpTextOutput(
	output: unknown,
	budgetBytes: number,
): TruncatedMcpOutput {
	const originalBytes = measureSerializedBytes(output);
	const blocks = mcpContentBlocks(output);
	if (originalBytes <= budgetBytes || !blocks) {
		return { output, truncated: false, originalBytes, elidedBytes: 0 };
	}

	const textBytes = (text: string): number =>
		Buffer.byteLength(JSON.stringify(text), "utf8");

	// Everything except the variable-length text itself must fit within the
	// budget for truncation to have room to work.
	const fixedOverhead =
		originalBytes -
		blocks.reduce(
			(sum, b) =>
				sum + (typeof b.text === "string" ? textBytes(b.text) : 0),
			0,
		);
	if (fixedOverhead >= budgetBytes) {
		return { output, truncated: false, originalBytes, elidedBytes: 0 };
	}

	let remaining = budgetBytes - fixedOverhead;
	let truncated = false;
	let elidedBytes = 0;
	// Set when a block that WOULD be cut turns out to be JSON-shaped: cutting
	// it corrupts a programmatic consumer's payload, so the whole output is
	// passed through untouched and the caller's size guard decides instead.
	let jsonCutVetoed = false;
	const nextBlocks: McpContentBlock[] = blocks.map((block) => {
		if (typeof block.text !== "string" || remaining <= 0) {
			if (typeof block.text === "string" && remaining <= 0) {
				// Budget exhausted — later text blocks are elided wholesale.
				if (isJsonShaped(block.text)) {
					jsonCutVetoed = true;
					return block;
				}
				const full = textBytes(block.text);
				elidedBytes += full;
				truncated = true;
				return {
					...block,
					text: ELISION_MARKER.trimStart(),
				};
			}
			return block;
		}
		const full = textBytes(block.text);
		if (full <= remaining) {
			remaining -= full;
			return block;
		}
		if (isJsonShaped(block.text)) {
			jsonCutVetoed = true;
			return block;
		}
		// Cut proportionally to remaining bytes; JSON-string overhead means
		// char count ≈ byte count for ASCII, and the loop below converges.
		let cut = Math.max(
			0,
			Math.floor((block.text.length * remaining) / full),
		);
		let candidate = block.text.slice(0, cut) + ELISION_MARKER;
		while (cut > 0 && textBytes(candidate) > remaining) {
			cut = Math.floor(cut / 2);
			candidate = block.text.slice(0, cut) + ELISION_MARKER;
		}
		elidedBytes += full - textBytes(candidate);
		remaining -= textBytes(candidate);
		truncated = true;
		return { ...block, text: candidate };
	});

	if (jsonCutVetoed) {
		return { output, truncated: false, originalBytes, elidedBytes: 0 };
	}

	return {
		output: { ...(output as Record<string, unknown>), content: nextBlocks },
		truncated,
		originalBytes,
		elidedBytes,
	};
}
