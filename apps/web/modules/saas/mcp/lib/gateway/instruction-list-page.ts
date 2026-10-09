import { createHash } from "node:crypto";

const INSTRUCTION_LIST_DEFAULT_LIMIT = 200;
const INSTRUCTION_LIST_MAX_LIMIT = 500;
const DESCRIPTION_MAX_CHARS = 160;

type ListedFile = {
	path: string;
	kind: string;
	name?: string | null;
	description?: string | null;
	size?: number;
};

type CompactInstructionFile = {
	path: string;
	kind: string;
	size?: number;
	name?: string;
	description?: string;
};

export type InstructionListPage = {
	files: CompactInstructionFile[];
	page: {
		returned: number;
		total: number;
		limit: number;
		nextCursor: string | null;
	};
	hint?: string;
};

type ListBinding = { generation: number; commitSha: string };

/**
 * A cursor is an offset into the sorted, prefix-filtered listing. The listing
 * is immutable at a commit, so the offset is stable there; the cursor is bound
 * to that commit and to the prefix (by digest, so a long prefix cannot grow
 * it), and its size does not depend on any path.
 */
function prefixDigest(prefix: string | undefined): string {
	return createHash("sha256")
		.update(normalizePrefix(prefix))
		.digest("hex")
		.slice(0, 16);
}

function encodeInstructionListCursor(
	binding: ListBinding,
	prefix: string | undefined,
	offset: number,
): string {
	return Buffer.from(
		JSON.stringify({
			g: binding.generation,
			c: binding.commitSha,
			f: prefixDigest(prefix),
			o: offset,
		}),
		"utf8",
	).toString("base64url");
}

function decodeInstructionListCursor(
	cursor: string,
): { binding: ListBinding; prefix: string; offset: number } | null {
	try {
		const value: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			typeof value === "object" &&
			value !== null &&
			"g" in value &&
			"c" in value &&
			"f" in value &&
			"o" in value &&
			typeof value.g === "number" &&
			typeof value.c === "string" &&
			typeof value.f === "string" &&
			typeof value.o === "number" &&
			Number.isInteger(value.o) &&
			value.o > 0
		) {
			return {
				binding: { generation: value.g, commitSha: value.c },
				prefix: value.f,
				offset: value.o,
			};
		}
	} catch {
		return null;
	}
	return null;
}

/** A folder or path prefix: `\` is `/` and edges are trimmed. */
function normalizePrefix(prefix: string | undefined): string {
	return (prefix ?? "")
		.split("\\")
		.join("/")
		.replace(/^\/+|\/+$/g, "");
}

/** A folder or path prefix matches whole segments. */
function matchesPrefix(path: string, prefix: string | undefined): boolean {
	const normalized = normalizePrefix(prefix);
	return (
		normalized === "" ||
		path === normalized ||
		path.startsWith(`${normalized}/`)
	);
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function compact(file: ListedFile): CompactInstructionFile {
	const entry: CompactInstructionFile = {
		path: file.path,
		kind: file.kind,
	};
	if (file.size !== undefined) {
		entry.size = file.size;
	}
	if (file.name && file.name !== basename(file.path)) {
		entry.name = file.name;
	}
	if (file.description) {
		entry.description =
			file.description.length > DESCRIPTION_MAX_CHARS
				? `${file.description.slice(0, DESCRIPTION_MAX_CHARS)}…`
				: file.description;
	}
	return entry;
}

const INSTRUCTION_LIST_CURSOR_MAX_CHARS = 2048;
const INSTRUCTION_LIST_PREFIX_MAX_CHARS = 512;

export function readInstructionListLimit(
	value: unknown,
): { limit: number } | { error: string } {
	if (value === undefined) return { limit: INSTRUCTION_LIST_DEFAULT_LIMIT };
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > INSTRUCTION_LIST_MAX_LIMIT
	) {
		return {
			error: `limit must be an integer between 1 and ${INSTRUCTION_LIST_MAX_LIMIT}.`,
		};
	}
	return { limit: value };
}

export function pageInstructionFiles(input: {
	files: readonly ListedFile[];
	limit: number;
	cursor: string | undefined;
	prefix: string | undefined;
	/** The commit this listing was read at: the cursor is bound to it. */
	binding: ListBinding;
}): InstructionListPage | { error: string } {
	if (
		input.cursor !== undefined &&
		input.cursor.length > INSTRUCTION_LIST_CURSOR_MAX_CHARS
	) {
		return {
			error: "cursor is too long. Use the nextCursor exactly as returned.",
		};
	}
	if (
		input.prefix !== undefined &&
		input.prefix.length > INSTRUCTION_LIST_PREFIX_MAX_CHARS
	) {
		return {
			error: `prefix must be at most ${INSTRUCTION_LIST_PREFIX_MAX_CHARS} characters.`,
		};
	}
	let offset = 0;
	if (input.cursor !== undefined) {
		const decoded = decodeInstructionListCursor(input.cursor);
		if (decoded === null) {
			return {
				error: "cursor is not valid. Use the nextCursor from the previous page, or omit it to start over.",
			};
		}
		if (
			decoded.binding.generation !== input.binding.generation ||
			decoded.binding.commitSha !== input.binding.commitSha
		) {
			return {
				error: "cursor was issued for a different commit. Pass generation and commitSha from the first response with it, or restart without a cursor.",
			};
		}
		if (decoded.prefix !== prefixDigest(input.prefix)) {
			return {
				error: "cursor was issued for a different prefix. Pass the same prefix, or restart without a cursor.",
			};
		}
		offset = decoded.offset;
	}
	const matching = input.files
		.filter((file) => matchesPrefix(file.path, input.prefix))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const remaining = matching.slice(offset);
	const slice = remaining.slice(0, input.limit);
	const nextCursor =
		remaining.length > slice.length
			? encodeInstructionListCursor(
					input.binding,
					input.prefix,
					offset + slice.length,
				)
			: null;
	return {
		files: slice.map(compact),
		page: {
			returned: slice.length,
			total: matching.length,
			limit: input.limit,
			nextCursor,
		},
		...(nextCursor === null
			? {}
			: {
					hint: `More results: ${remaining.length - slice.length} files follow. Pass cursor "${nextCursor}" together with generation ${input.binding.generation} and commitSha ${input.binding.commitSha} for the next page, or narrow with prefix (a folder path such as "docs/") or query.`,
				}),
	};
}
