/**
 * A three-way line merge, in the diff3 style git uses, with no dependency.
 *
 * Rebasing a stale proposal asks, per file, what the proposal changed since
 * its base and what the published version changed since the same base, and
 * keeps both when they touch different lines. This module answers that for
 * text, and `mergeInstructionPath` answers the per-file question around it:
 * which side changed, and whether the change can be carried at all.
 *
 * The published CLI cannot depend on this package, so it carries a copy at
 * `packages/cli/src/lib/instructions/three-way-merge.ts`, and
 * `three-way-merge-agrees-with-cli.test.ts` runs both on the same cases.
 * Keep the two files identical apart from this paragraph.
 *
 * Browser-safe: no Node module is used.
 */

/** One side of a file at one version. Null as a whole: the file is absent. */
export type MergeSide = {
	/** Any stable identity of the bytes, compared for equality only. */
	hash: string;
	/** The file as text, or null when it is binary or cannot be read as text. */
	text: string | null;
} | null;

export type MergeLabels = {
	/** Names the proposal's side in a conflict block. */
	ours: string;
	/** Names the published side in a conflict block. */
	theirs: string;
};

export type ConflictReason =
	/** Both sides changed the same lines differently. */
	| "content"
	/** One side deleted the file and the other changed it. */
	| "delete-edit"
	/** Both sides changed a file that cannot be merged as text. */
	| "binary";

export type PathMergeResult =
	/** Both sides already hold the same version: nothing is left to carry. */
	| { kind: "unchanged" }
	/** Only the proposal changed the file: its version is carried as it is. */
	| { kind: "take-ours" }
	/** Only the published side changed the file: the proposal no longer touches it. */
	| { kind: "take-theirs" }
	/** Both changed it, on different lines: the merged text is carried. */
	| { kind: "merged"; text: string }
	/**
	 * Both changed it and the changes cannot be combined. `text` holds the
	 * file with conflict markers when it can be shown as text, and is null
	 * for a binary file.
	 */
	| { kind: "conflict"; reason: ConflictReason; text: string | null };

export type TextMergeResult = {
	/** The merged text, with conflict markers when `conflicts` is above zero. */
	text: string;
	conflicts: number;
};

const CONFLICT_MARKER_START = "<<<<<<<";
const CONFLICT_MARKER_SEPARATOR = "=======";
const CONFLICT_MARKER_END = ">>>>>>>";

function sameSide(a: MergeSide, b: MergeSide): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.hash === b.hash;
}

/**
 * Decides one path of a rebase from its three versions.
 *
 * The order of the checks matters: equal results win over everything, so a
 * change both sides made identically is never a conflict, and a side that
 * did not move gives way to the side that did.
 */
export function mergeInstructionPath(input: {
	base: MergeSide;
	ours: MergeSide;
	theirs: MergeSide;
	labels: MergeLabels;
}): PathMergeResult {
	const { base, ours, theirs, labels } = input;
	if (sameSide(ours, theirs)) {
		return { kind: "unchanged" };
	}
	if (sameSide(base, theirs)) {
		return { kind: "take-ours" };
	}
	if (sameSide(base, ours)) {
		return { kind: "take-theirs" };
	}
	if (ours === null || theirs === null) {
		const present = ours ?? theirs;
		if (present === null || present.text === null) {
			return { kind: "conflict", reason: "delete-edit", text: null };
		}
		return {
			kind: "conflict",
			reason: "delete-edit",
			text: conflictBlock(
				ours === null ? [] : splitLines(present.text),
				theirs === null ? [] : splitLines(present.text),
				labels,
				lineEndingOf(present.text),
			).join(""),
		};
	}
	if (
		ours.text === null ||
		theirs.text === null ||
		(base !== null && base.text === null)
	) {
		return { kind: "conflict", reason: "binary", text: null };
	}
	const merged = threeWayMerge(
		base?.text ?? "",
		ours.text,
		theirs.text,
		labels,
	);
	return merged.conflicts === 0
		? { kind: "merged", text: merged.text }
		: { kind: "conflict", reason: "content", text: merged.text };
}

/** Whether a text still holds a conflict block a merge wrote. */
export function hasConflictMarkers(text: string): boolean {
	for (const line of splitLines(text)) {
		if (
			line.startsWith(CONFLICT_MARKER_START) ||
			line.startsWith(CONFLICT_MARKER_END)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Merges two texts that both descend from `base`, line by line.
 *
 * Regions where all three agree are stable. Between them, a region only one
 * side changed takes that side; a region both changed identically takes
 * either; anything else is a conflict, written as git writes one.
 */
export function threeWayMerge(
	base: string,
	ours: string,
	theirs: string,
	labels: MergeLabels,
): TextMergeResult {
	const o = splitLines(base);
	const a = splitLines(ours);
	const b = splitLines(theirs);
	const toA = matchMap(o, a);
	const toB = matchMap(o, b);
	const eol = lineEndingOf(ours);
	const out: string[] = [];
	let conflicts = 0;
	let lo = 0;
	let la = 0;
	let lb = 0;
	const emitUnstable = (o2: number, a2: number, b2: number) => {
		const baseSlice = o.slice(lo, o2);
		const oursSlice = a.slice(la, a2);
		const theirsSlice = b.slice(lb, b2);
		if (sameLines(oursSlice, baseSlice)) {
			out.push(...theirsSlice);
		} else if (sameLines(theirsSlice, baseSlice)) {
			out.push(...oursSlice);
		} else if (sameLines(oursSlice, theirsSlice)) {
			out.push(...oursSlice);
		} else {
			conflicts += 1;
			out.push(...conflictBlock(oursSlice, theirsSlice, labels, eol));
		}
	};
	for (;;) {
		let i = 0;
		while (
			lo + i < o.length &&
			toA[lo + i] === la + i &&
			toB[lo + i] === lb + i
		) {
			i += 1;
		}
		if (i > 0) {
			out.push(...o.slice(lo, lo + i));
			lo += i;
			la += i;
			lb += i;
			continue;
		}
		if (lo === o.length && la === a.length && lb === b.length) {
			break;
		}
		let sync = lo;
		while (sync < o.length && (toA[sync] === -1 || toB[sync] === -1)) {
			sync += 1;
		}
		if (sync === o.length) {
			emitUnstable(o.length, a.length, b.length);
			break;
		}
		const nextA = toA[sync] ?? -1;
		const nextB = toB[sync] ?? -1;
		emitUnstable(sync, nextA, nextB);
		lo = sync;
		la = nextA;
		lb = nextB;
	}
	return { text: out.join(""), conflicts };
}

/** Lines with their own terminators kept, so the merge rewrites nothing. */
function splitLines(text: string): string[] {
	const lines: string[] = [];
	let start = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) {
			lines.push(text.slice(start, i + 1));
			start = i + 1;
		}
	}
	if (start < text.length) {
		lines.push(text.slice(start));
	}
	return lines;
}

function lineEndingOf(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

function sameLines(x: readonly string[], y: readonly string[]): boolean {
	return x.length === y.length && x.every((line, i) => line === y[i]);
}

function terminated(lines: readonly string[], eol: string): string[] {
	const last = lines.at(-1);
	if (last === undefined || last.endsWith("\n")) {
		return [...lines];
	}
	return [...lines.slice(0, -1), last + eol];
}

function conflictBlock(
	ours: readonly string[],
	theirs: readonly string[],
	labels: MergeLabels,
	eol: string,
): string[] {
	return [
		`${CONFLICT_MARKER_START} ${labels.ours}${eol}`,
		...terminated(ours, eol),
		`${CONFLICT_MARKER_SEPARATOR}${eol}`,
		...terminated(theirs, eol),
		`${CONFLICT_MARKER_END} ${labels.theirs}${eol}`,
	];
}

/**
 * For each line of `from`, the index of the line of `to` it is matched with
 * in a longest common subsequence, or -1. Matches only ever increase.
 */
function matchMap(from: readonly string[], to: readonly string[]): number[] {
	const map = new Array<number>(from.length).fill(-1);
	let prefix = 0;
	while (
		prefix < from.length &&
		prefix < to.length &&
		from[prefix] === to[prefix]
	) {
		map[prefix] = prefix;
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < from.length - prefix &&
		suffix < to.length - prefix &&
		from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
	) {
		map[from.length - 1 - suffix] = to.length - 1 - suffix;
		suffix += 1;
	}
	const ids = new Map<string, number>();
	const idOf = (line: string) => {
		let id = ids.get(line);
		if (id === undefined) {
			id = ids.size;
			ids.set(line, id);
		}
		return id;
	};
	const x = from.slice(prefix, from.length - suffix).map(idOf);
	const y = to.slice(prefix, to.length - suffix).map(idOf);
	for (const [i, j] of myersMatches(x, y)) {
		map[prefix + i] = prefix + j;
	}
	return map;
}

/**
 * The most edits the line matcher searches before it gives up. The trace is
 * O(D²), so this bounds its memory to a few megabytes. Two versions further
 * apart than this are matched as having no line in common, which turns every
 * region both sides changed into a conflict: slower to resolve, never wrong.
 */
const MAX_EDIT_DISTANCE = 2000;

/**
 * Myers' O((N+M)D) shortest edit script, returning the matched index pairs.
 * Each step keeps only the diagonals it can reach, so the trace is O(D²).
 */
function myersMatches(
	a: readonly number[],
	b: readonly number[],
): Array<[number, number]> {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) {
		return [];
	}
	const max = n + m;
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d += 1) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			const down =
				k === -d ||
				(k !== d &&
					(v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
			let x = down
				? (v[offset + k + 1] ?? 0)
				: (v[offset + k - 1] ?? 0) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x += 1;
				y += 1;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
		if (found !== -1) {
			break;
		}
	}
	if (found === -1) {
		return [];
	}
	const pairs: Array<[number, number]> = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d -= 1) {
		const prev = trace[d];
		if (prev === undefined) {
			break;
		}
		const at = (k: number) => prev[k + d + 1] ?? 0;
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const prevK = down ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x -= 1;
			y -= 1;
			pairs.push([x, y]);
		}
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		x -= 1;
		y -= 1;
		pairs.push([x, y]);
	}
	return pairs.reverse();
}
