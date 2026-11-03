/**
 * Line-based code chunker for any language (spec 2026-10-29 code-index-sync
 * §6b).
 *
 * The AST chunker knows six languages. Everything else (C#, Kotlin, PHP,
 * Ruby, Swift, SQL, YAML, Razor, …) is cut here on boundaries every language
 * shows: blank lines, lines that start at the left margin (declarations) and
 * a closing brace at the left margin. Chunks cover the whole file, in order,
 * with no gap and no overlap, and each carries its 1-based line range, so
 * search finds any part of the file and a reader can cite exact lines.
 *
 * Pure and deterministic: no grammar, no model.
 */

export interface LineChunk {
	content: string;
	index: number;
	/** First line of the chunk, 1-based. */
	startLine: number;
	/** Last line of the chunk, 1-based, inclusive. */
	endLine: number;
}

export interface LineChunkOptions {
	/** Lines are gathered up to about this many characters. */
	targetChars?: number;
	/** A chunk never grows past this; one longer line is cut on its own. */
	maxChars?: number;
}

const DEFAULT_TARGET = 1800;
const DEFAULT_MAX = 3000;

/** How good a place it is to start a new chunk before this line (higher is better). */
function boundaryScore(line: string, previous: string | undefined): number {
	if (previous !== undefined && previous.trim() === "") {
		// After a blank line, a line at the margin is the best cut of all.
		return /^\S/.test(line) ? 3 : 2;
	}
	if (/^[}\])]/.test(previous ?? "")) {
		// Right after a block closed at the margin.
		return 2;
	}
	if (/^\S/.test(line) && !/^[}\])]/.test(line)) {
		return 1;
	}
	return 0;
}

/**
 * Split `text` into chunks that together are exactly the file. A chunk ends
 * at the best boundary once it reaches the target size, and is forced to end
 * at the max size.
 */
export function chunkCodeByLines(
	text: string,
	options: LineChunkOptions = {},
): LineChunk[] {
	const target = options.targetChars ?? DEFAULT_TARGET;
	const max = Math.max(options.maxChars ?? DEFAULT_MAX, target);
	if (text.length === 0) {
		return [];
	}
	// Keep each line's own terminator so the chunks join back to the file.
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const chunks: LineChunk[] = [];
	let start = 0;

	const push = (from: number, to: number) => {
		chunks.push({
			content: lines.slice(from, to).join(""),
			index: chunks.length,
			startLine: from + 1,
			endLine: to,
		});
	};

	while (start < lines.length) {
		let size = 0;
		let end = start;
		let bestCut = -1;
		let bestScore = -1;
		while (end < lines.length) {
			const line = lines[end] as string;
			if (size > 0 && size + line.length > max) {
				break;
			}
			size += line.length;
			end++;
			if (size >= target && end < lines.length) {
				const score = boundaryScore(
					lines[end] as string,
					lines[end - 1],
				);
				if (score > bestScore) {
					bestScore = score;
					bestCut = end;
				}
				if (score >= 3) {
					break;
				}
			}
		}
		// Past the target, cut at the best boundary seen; otherwise where the
		// size ran out (or at the end of the file).
		const cut =
			end < lines.length && bestCut > start && bestScore > 0
				? bestCut
				: end;
		push(start, cut);
		start = cut;
	}
	return chunks;
}

/** Why a repository file is not indexed, or null when it is. */
export type CodeFileSkipReason =
	| "too-large"
	| "minified"
	| "generated"
	| "binary"
	| "empty";

/** Files above this are left out: generated dumps, data, vendored bundles. */
export const MAX_INDEXED_CODE_FILE_BYTES = 1024 * 1024;

/** A line this long almost always means minified or generated output. */
const MINIFIED_LINE_CHARS = 1000;

const GENERATED_PATH = [
	/(^|\/)(obj|bin)\//i,
	/\.g\.(cs|i\.cs)$/i,
	/\.designer\.cs$/i,
	/\.generated\.[a-z0-9]+$/i,
	/(^|\/)generated\//i,
	/\.pb\.(go|cs)$/i,
	/_pb2\.py$/i,
	/(^|\/)package-lock\.json$/i,
	/(^|\/)pnpm-lock\.yaml$/i,
	/(^|\/)yarn\.lock$/i,
	/(^|\/)composer\.lock$/i,
	/(^|\/)Gemfile\.lock$/i,
	/(^|\/)Cargo\.lock$/i,
	/(^|\/)packages\.lock\.json$/i,
	/\.min\.[a-z0-9]+$/i,
];

/**
 * Whether a file's content is worth indexing. Paths and sizes the file walk
 * already skips (images, archives, node_modules, …) never reach here; this
 * catches what only the content shows.
 */
export function codeFileSkipReason(
	relativePath: string,
	text: string,
): CodeFileSkipReason | null {
	if (text.trim() === "") {
		return "empty";
	}
	if (Buffer.byteLength(text, "utf8") > MAX_INDEXED_CODE_FILE_BYTES) {
		return "too-large";
	}
	if (text.includes("\u0000")) {
		return "binary";
	}
	if (GENERATED_PATH.some((pattern) => pattern.test(relativePath))) {
		return "generated";
	}
	const lines = text.split("\n");
	const long = lines.filter((line) => line.length > MINIFIED_LINE_CHARS);
	if (long.length > 0 && long.length >= lines.length / 10) {
		return "minified";
	}
	return null;
}

/** 1-based line of a character offset into `text`. */
export function lineAtOffset(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text.charCodeAt(i) === 10) {
			line++;
		}
	}
	return line;
}
