/**
 * Chunking by kind for files that have no AST grammar in the code index
 * (spec 2026-10-29 code-index-sync §6c).
 *
 * A repository holds more than code: READMEs, specs and ADRs read best cut at
 * their headings, and configuration reads best cut at its top-level keys.
 * Each kind keeps the line chunker's contract: chunks cover the whole file, in
 * order, with no gap and no overlap, and carry 1-based line ranges.
 *
 * Pure and deterministic: no grammar, no model.
 */

import { chunkCodeByLines, type LineChunk } from "./code-lines-chunker";

/** What a repository file is, for chunking and for search filters. */
export type RepositoryFileKind = "code" | "doc" | "config";

export interface RepositoryFileChunk extends LineChunk {
	/** Heading path at the start of the chunk (docs only), e.g. ["Setup", "Docker"]. */
	headings?: string[];
	/** Top-level keys the chunk holds (config only). */
	keys?: string[];
}

const DOC_EXTENSIONS = new Set([
	".md",
	".mdx",
	".markdown",
	".rst",
	".adoc",
	".txt",
]);
const CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".toml"]);

/** Target and hard cap per chunk, the same sizes the line chunker uses. */
const TARGET_CHARS = 1800;
const MAX_CHARS = 3000;
/** A section shorter than this joins the next one instead of standing alone. */
const MIN_SECTION_CHARS = 200;

export function repositoryFileKind(path: string): RepositoryFileKind {
	const dot = path.lastIndexOf(".");
	const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
	if (DOC_EXTENSIONS.has(ext)) {
		return "doc";
	}
	if (CONFIG_EXTENSIONS.has(ext)) {
		return "config";
	}
	return "code";
}

function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** A run of whole lines, [from, to) in 0-based line indexes. */
interface Block {
	from: number;
	to: number;
	headings?: string[];
	keys?: string[];
}

/**
 * Turn blocks into chunks: small blocks join their neighbours up to the
 * target, a block past the cap is cut by the line chunker.
 */
function packBlocks(
	lines: string[],
	blocks: Block[],
	minChars: number,
): RepositoryFileChunk[] {
	const chunks: RepositoryFileChunk[] = [];
	const size = (from: number, to: number) =>
		lines.slice(from, to).reduce((sum, line) => sum + line.length, 0);
	const push = (chunk: Omit<RepositoryFileChunk, "index">) => {
		chunks.push({ ...chunk, index: chunks.length });
	};

	let open: Block | null = null;
	const flush = () => {
		if (!open) {
			return;
		}
		const block = open;
		open = null;
		if (size(block.from, block.to) <= MAX_CHARS) {
			push({
				content: lines.slice(block.from, block.to).join(""),
				startLine: block.from + 1,
				endLine: block.to,
				headings: block.headings,
				keys: block.keys,
			});
			return;
		}
		for (const part of chunkCodeByLines(
			lines.slice(block.from, block.to).join(""),
			{ targetChars: TARGET_CHARS, maxChars: MAX_CHARS },
		)) {
			push({
				content: part.content,
				startLine: block.from + part.startLine,
				endLine: block.from + part.endLine,
				headings: block.headings,
				keys: block.keys,
			});
		}
	};

	for (const block of blocks) {
		if (!open) {
			open = { ...block };
			continue;
		}
		const current: Block = open;
		const openSize = size(current.from, current.to);
		const joined = openSize + size(block.from, block.to);
		if (openSize < minChars || joined <= TARGET_CHARS) {
			open = {
				from: current.from,
				to: block.to,
				headings: current.headings,
				keys:
					current.keys || block.keys
						? [...(current.keys ?? []), ...(block.keys ?? [])]
						: undefined,
			};
			continue;
		}
		flush();
		open = { ...block };
	}
	flush();
	return chunks;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Markdown and plain docs: a new block at every heading outside code fences. */
export function chunkDocByHeadings(text: string): RepositoryFileChunk[] {
	const lines = splitLines(text);
	if (lines.length === 0) {
		return [];
	}
	const blocks: Block[] = [];
	let path: string[] = [];
	let from = 0;
	let inFence = false;
	let blockHeadings: string[] = [];

	lines.forEach((raw, i) => {
		const line = raw.replace(/\r?\n$/, "");
		if (FENCE.test(line)) {
			inFence = !inFence;
			return;
		}
		const match = inFence ? null : line.slice(0, 500).match(HEADING);
		if (!match) {
			return;
		}
		if (i > from) {
			blocks.push({ from, to: i, headings: blockHeadings });
		}
		const level = (match[1] as string).length;
		path = [...path.slice(0, level - 1), match[2] as string];
		blockHeadings = path;
		from = i;
	});
	blocks.push({ from, to: lines.length, headings: blockHeadings });

	return packBlocks(lines, blocks, MIN_SECTION_CHARS).map((chunk) =>
		chunk.headings && chunk.headings.length > 0
			? chunk
			: { ...chunk, headings: undefined },
	);
}

/** The key a top-level line opens, or null when it opens none. */
function topLevelKey(
	line: string,
	format: { jsonIndent: string | null; inTomlTable: boolean },
	json: boolean,
): { key: string; table?: boolean } | null {
	if (json) {
		// Keys directly inside the root object, at its own indent only.
		const match = line.match(/^(\s+)"([^"]+)"\s*:/);
		return match && match[1] === format.jsonIndent
			? { key: match[2] as string }
			: null;
	}
	if (/^\s|^#|^---|^\.\.\./.test(line)) {
		return null;
	}
	const table = line.match(/^\[\[?([^\]]+)\]\]?/);
	if (table) {
		return { key: table[1] as string, table: true };
	}
	// Inside a TOML table a bare key belongs to the table, not the file.
	if (format.inTomlTable) {
		return null;
	}
	const key = line.match(/^["']?([\w.\-/@$ ]+?)["']?\s*[:=]/);
	return key ? { key: (key[1] as string).trim() } : null;
}

/** YAML, TOML and JSON: a new block at each top-level key. */
export function chunkConfigByKeys(
	text: string,
	path: string,
): RepositoryFileChunk[] {
	const lines = splitLines(text);
	if (lines.length === 0) {
		return [];
	}
	const lower = path.toLowerCase();
	const json = lower.endsWith(".json");
	// The root object's keys sit at the indent of the first key in the file.
	const firstKey = json
		? lines.map((line) => line.match(/^(\s+)"[^"]+"\s*:/)).find(Boolean)
		: null;
	const format = {
		jsonIndent: firstKey ? (firstKey[1] as string) : null,
		inTomlTable: false,
	};
	const blocks: Block[] = [];
	let from = 0;
	let keys: string[] | undefined;

	lines.forEach((raw, i) => {
		const found = topLevelKey(raw.replace(/\r?\n$/, ""), format, json);
		if (found === null) {
			return;
		}
		if (found.table && lower.endsWith(".toml")) {
			format.inTomlTable = true;
		}
		if (i > from) {
			blocks.push({ from, to: i, keys });
		}
		from = i;
		keys = [found.key];
	});
	blocks.push({ from, to: lines.length, keys });

	return packBlocks(lines, blocks, 0);
}

/**
 * Chunk one repository file by its kind. Code is cut by the line chunker
 * here; the caller tries the AST chunker first where a grammar exists.
 */
export function chunkRepositoryFile(
	path: string,
	text: string,
): { kind: RepositoryFileKind; chunks: RepositoryFileChunk[] } {
	const kind = repositoryFileKind(path);
	if (kind === "doc") {
		return { kind, chunks: chunkDocByHeadings(text) };
	}
	if (kind === "config") {
		return { kind, chunks: chunkConfigByKeys(text, path) };
	}
	return { kind, chunks: chunkCodeByLines(text) };
}
