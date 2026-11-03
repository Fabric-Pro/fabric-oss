/**
 * Repository reads served from the code index (spec 2026-10-29
 * code-index-sync §6b): in RAG mode `code_tree` lists the indexed file
 * manifest and `code_file_get` returns the file text stored at index time,
 * so a read needs no provider call. A file the index does not hold yet is
 * left to the provider read by the caller.
 *
 * Also the line window every file read returns: a long file comes back as
 * its outline and first lines, and `startLine` / `endLine` read any part.
 */

import type {
	FileContentResult,
	RepositoryStructure,
	TreeEntry,
} from "@repo/connectors";

/** A file read without a range returns at most this many lines. */
export const FILE_WINDOW_LINES = 300;
/** Outline entries shown for a long file. */
const OUTLINE_LIMIT = 80;

/** The paths of a repository's indexed files, from its code index manifest. */
export function manifestPaths(fileManifest: unknown): string[] | null {
	if (!Array.isArray(fileManifest)) {
		return null;
	}
	const paths = fileManifest
		.map((entry) =>
			entry && typeof entry === "object" && "path" in entry
				? (entry as { path: unknown }).path
				: null,
		)
		.filter((path): path is string => typeof path === "string");
	return paths.length > 0 ? paths : null;
}

/**
 * A recursive listing of `paths` under `directory`, shaped as a provider's:
 * every file and every folder between it and the directory.
 */
export function indexedStructure(
	paths: string[],
	directory?: string,
): RepositoryStructure {
	const prefix = directory
		? `${directory.split("/").filter(Boolean).join("/")}/`
		: "";
	const files = paths.filter((path) => !prefix || path.startsWith(prefix));
	const directories = new Set<string>();
	for (const file of files) {
		const parts = file.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!prefix || `${dir}/`.startsWith(prefix)) {
				if (`${dir}/` !== prefix) {
					directories.add(dir);
				}
			}
		}
	}
	const entries: TreeEntry[] = [
		...[...directories].map((path) => ({
			path,
			type: "directory" as const,
		})),
		...files.map((path) => ({ path, type: "file" as const })),
	].sort((a, b) => a.path.localeCompare(b.path));
	return {
		entries,
		totalFiles: files.length,
		totalDirectories: directories.size,
		truncated: false,
	};
}

/** Lines that read as declarations, in most languages. */
const DECLARATION =
	/^\s{0,8}(?:export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|abstract\s+|sealed\s+|partial\s+|override\s+|virtual\s+|readonly\s+)*(?:class|interface|struct|record|enum|trait|impl|module|namespace|function|func|fn|def|type|const\s+\w+\s*=\s*(?:async\s*)?\(|[\w<>[\],?]+\s+\w+\s*\()\b/;

/** The declarations of a file with their lines, for reading a long file. */
export function fileOutline(lines: string[]): string[] {
	const outline: string[] = [];
	for (const [i, line] of lines.entries()) {
		if (
			DECLARATION.test(line) &&
			!/^\s*(?:return|if|for|while|switch|catch|else)\b/.test(line)
		) {
			outline.push(`${i + 1}: ${line.trim().slice(0, 160)}`);
			if (outline.length >= OUTLINE_LIMIT) {
				break;
			}
		}
	}
	return outline;
}

/** A positive whole number from a tool argument, or undefined. */
export function readLineArgument(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isInteger(n) && n > 0
		? n
		: undefined;
}

/**
 * The text a file read returns: the requested lines, numbered, or for a long
 * file without a range its outline and first lines, saying how to read on.
 */
export function fileWindow(
	content: string,
	range: { startLine?: number; endLine?: number },
): { text: string; note: string } {
	const lines = content.split("\n");
	if (lines.length > 1 && lines.at(-1) === "") {
		lines.pop();
	}
	const total = lines.length;
	const hasRange =
		range.startLine !== undefined || range.endLine !== undefined;
	if (!hasRange && total <= FILE_WINDOW_LINES) {
		return { text: content, note: "" };
	}
	const start = Math.min(range.startLine ?? 1, Math.max(total, 1));
	const end = Math.min(
		range.endLine ?? start + FILE_WINDOW_LINES - 1,
		total,
		start + FILE_WINDOW_LINES * 2 - 1,
	);
	const width = String(end).length;
	const numbered = lines
		.slice(start - 1, end)
		.map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
		.join("\n");
	const more =
		end < total
			? ` Read on with startLine=${end + 1} (and endLine as needed).`
			: "";
	if (hasRange) {
		return {
			text: numbered,
			note: `Lines ${start}–${end} of ${total}.${more}`,
		};
	}
	const outline = fileOutline(lines);
	return {
		text: numbered,
		note: `Lines ${start}–${end} of ${total}.${more}${
			outline.length > 0
				? `\n\nOutline (line: declaration):\n${outline.join("\n")}`
				: ""
		}`,
	};
}

/** A stored index file as the provider read returns one. */
export function indexedFileResult(file: {
	path: string;
	content: string;
	sizeBytes: number;
}): FileContentResult {
	return {
		path: file.path,
		content: file.content,
		size: file.sizeBytes,
		encoding: "utf-8",
		isBinary: false,
		isTruncated: false,
	};
}
