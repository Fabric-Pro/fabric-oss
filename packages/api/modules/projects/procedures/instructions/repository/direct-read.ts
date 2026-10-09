/** Direct pinned tree and file reads. No snapshot, storage or import layer. */
import { ORPCError } from "@orpc/client";
import {
	listRepositoryTreeAtCommit,
	type RepositoryTreeEntry,
} from "@repo/connectors";
import {
	buildIgnoreMatcher,
	classifyPath,
	createTreeCollisionGuard,
	type ExcludedPath,
	isSecretFileName,
	MAX_EXCLUDED_PATHS,
	SNAPSHOT_LIMITS,
	validateRelativePath,
} from "@repo/instructions";
import { directTreeCache } from "./direct-cache";
import {
	type DirectRepositoryPin,
	type DirectRepositorySource,
	directRelativeRepositoryPath,
	directRepositoryPath,
	directRepositoryReadError,
	readDirectRepositoryFileAtCommit,
	resolveDirectRepositoryIgnore,
} from "./direct-source";
import { inOrder } from "./settle";

/** A direct listing remains useful and bounded even for very large repositories. */
/**
 * As many files as the connector lists at all (its own entry cap), so a
 * listing is `incomplete` only when the provider or the connector truncated
 * it, never because this layer cut a tree the provider returned whole. The
 * cached tree is weighed per entry, so a tree this size holds one third of
 * the tree cache.
 */
const MAX_DIRECT_REPOSITORY_FILES = 20_000;

export type DirectRepositoryFile = {
	path: string;
	kind: ReturnType<typeof classifyPath>;
	blobId?: string;
	size?: number;
	mode?: string;
};

function notFound(): ORPCError<"NOT_FOUND", { code: string }> {
	return new ORPCError("NOT_FOUND", {
		message: "File not found",
		data: { code: "REPOSITORY_FILE_NOT_FOUND" },
	});
}

function listedFile(
	entry: RepositoryTreeEntry,
	source: DirectRepositorySource,
	matcher: ReturnType<typeof buildIgnoreMatcher>,
): DirectRepositoryFile | ExcludedPath | null | "invalid" {
	if (entry.type !== "file") {
		return null;
	}
	const path = directRelativeRepositoryPath(source, entry.path);
	if (path === null || path === "") {
		return null;
	}
	const checked = validateRelativePath(path);
	if (!checked.ok) {
		return "invalid";
	}
	const secret = isSecretFileName(checked.path);
	const ignored = matcher(checked.path);
	if (entry.regular === false || secret || ignored) {
		return {
			path: checked.path,
			rule:
				entry.regular === false
					? "Non-regular Git entry"
					: secret
						? "Secret file name"
						: (ignored?.rule ?? "Repository exclusion"),
		};
	}
	return {
		path: checked.path,
		kind: classifyPath(checked.path),
		...(entry.blobId === undefined ? {} : { blobId: entry.blobId }),
		...(entry.size === undefined ? {} : { size: entry.size }),
		...(entry.mode === undefined ? {} : { mode: entry.mode }),
	};
}

async function listTree(
	source: DirectRepositorySource,
	pin: DirectRepositoryPin,
) {
	const cached = directTreeCache.get(source, [pin.commitSha]);
	if (cached !== undefined) {
		return cached;
	}
	const tree = await listRepositoryTreeAtCommit({
		...source.repository,
		sha: pin.commitSha,
	});
	if (tree.ok) {
		directTreeCache.set(source, [pin.commitSha], tree);
	}
	return tree;
}

export async function listDirectRepositoryFiles(input: {
	source: DirectRepositorySource;
	pin: DirectRepositoryPin;
}): Promise<{
	files: DirectRepositoryFile[];
	incomplete: boolean;
	refusal: "invalid_tree" | null;
	excludedCount: number;
	excludedPaths: ExcludedPath[];
}> {
	// The ignore rules and the tree are independent reads of the same commit;
	// the ignore rules still fail first.
	const [ignore, tree] = await inOrder(
		resolveDirectRepositoryIgnore(input.source, input.pin),
		listTree(input.source, input.pin),
	);
	if (!tree.ok) {
		if (tree.outcome === "unsupported") {
			throw directRepositoryReadError(input.source, "unreachable");
		}
		throw directRepositoryReadError(input.source, tree.outcome);
	}
	const matcher = buildIgnoreMatcher(ignore);
	const files: DirectRepositoryFile[] = [];
	const excludedPaths: ExcludedPath[] = [];
	let excludedCount = 0;
	const treeGuard = createTreeCollisionGuard();
	for (const entry of tree.entries) {
		const file = listedFile(entry, input.source, matcher);
		if (file === null) {
			continue;
		}
		if (file === "invalid" || treeGuard.add(file.path) !== null) {
			return {
				files: [],
				incomplete: true,
				refusal: "invalid_tree",
				excludedCount: 0,
				excludedPaths: [],
			};
		}
		if ("rule" in file) {
			excludedCount++;
			if (excludedPaths.length < MAX_EXCLUDED_PATHS)
				excludedPaths.push(file);
			continue;
		}
		files.push(file);
		if (files.length > MAX_DIRECT_REPOSITORY_FILES) {
			files.pop();
			return {
				files,
				incomplete: true,
				refusal: null,
				excludedCount,
				excludedPaths,
			};
		}
	}
	return {
		files,
		incomplete: tree.truncated,
		refusal: null,
		excludedCount,
		excludedPaths,
	};
}

function decodeText(bytes: Uint8Array): string | null {
	if (bytes.includes(0)) {
		return null;
	}
	try {
		return new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
	} catch {
		return null;
	}
}

export type DirectRepositoryFileRead =
	| { state: "found"; text: string; textLength: number; size: number }
	| { state: "binary"; size: number }
	| { state: "absent" | "tooLarge" };

export async function readDirectRepositoryFile(input: {
	source: DirectRepositorySource;
	pin: DirectRepositoryPin;
	path: string;
}): Promise<DirectRepositoryFileRead> {
	const checked = validateRelativePath(input.path);
	if (!checked.ok || isSecretFileName(checked.path)) {
		throw notFound();
	}
	// The ignore rules and the file are read together. A file the rules hide
	// is never returned, and the ignore failure still wins over the read's.
	const [ignore, read] = await inOrder(
		resolveDirectRepositoryIgnore(input.source, input.pin),
		readDirectRepositoryFileAtCommit(
			input.source,
			input.pin,
			directRepositoryPath(input.source, checked.path),
			SNAPSHOT_LIMITS.maxInlineTextBytes,
		),
	);
	if (buildIgnoreMatcher(ignore)(checked.path)) {
		throw notFound();
	}
	if (!read.ok) {
		throw directRepositoryReadError(
			input.source,
			read.outcome === "unsupported" ? "unreachable" : read.outcome,
		);
	}
	if (read.state === "absent" || read.state === "tooLarge") {
		return read;
	}
	const text = decodeText(read.bytes);
	return text === null
		? { state: "binary", size: read.bytes.length }
		: {
				state: "found",
				text,
				textLength: Array.from(text).length,
				size: read.bytes.length,
			};
}
