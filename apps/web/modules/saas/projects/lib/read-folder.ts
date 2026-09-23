import {
	buildIgnoreMatcher,
	classifyPath,
	createTreeCollisionGuard,
	FABRIC_IGNORE_FILE,
	type InstructionFileKind,
	isSecretFileName,
	resolveIgnoreGlobs,
	sha256Hex,
	validateRelativePath,
} from "@repo/instructions";

export type FolderEntry = {
	path: string;
	file: File;
	size: number;
	/**
	 * Null for an excluded entry: it is never sent to the server, so hashing
	 * it would only spend time reading bytes nobody uses — and a `node_modules`
	 * or build-output tree is usually most of what a picked folder holds.
	 */
	sha256: string | null;
	kind: InstructionFileKind;
	excluded: { rule: string; layer: string } | null;
	/**
	 * The `SECRET_FILE_PATTERNS` entry this path matches, when it is a file
	 * the server's secret gate rejects on its NAME (`.env`, `*.pem`, …).
	 *
	 * A preview, exactly like `excluded`: the server runs the same matcher
	 * in `verifyAndScanInstructionFiles` and is the only authority. Its
	 * purpose is to let someone drop the file from the folder before
	 * spending a full upload on a snapshot that will be rejected. Only the
	 * NAME gate is previewed — the content rules need the bytes, which is
	 * work the browser should not be doing.
	 */
	secretRule: string | null;
};

/**
 * One thing the person added to the upload dialog.
 *
 * A folder can be laid out two ways. With `keepName: false` its CONTENTS
 * become the upload's root (the original single-folder behaviour: pick
 * `repo/` and `repo/CLAUDE.md` is stored as `CLAUDE.md`). With
 * `keepName: true` the folder itself becomes a top-level directory, which is
 * the only way to upload `.claude/` and `.cursor/` side by side — and it
 * matters beyond layout, because `classifyPath` only recognises
 * `.claude/agents/x.md` as an AGENT when `.claude` is the FIRST segment.
 *
 * A `files` source holds individual files picked without a folder; each lands
 * at the root under its own name (a loose `CLAUDE.md` or `AGENTS.md`).
 */
export type PickedSource =
	| {
			id: string;
			kind: "folder";
			name: string;
			files: File[];
			keepName: boolean;
	  }
	| { id: string; kind: "files"; files: File[] };

/**
 * The picked sources would produce a tree no filesystem can hold: two paths
 * that are one file on a case-insensitive filesystem (`duplicate`), or one
 * name needed as both a file and a folder (`file-directory`, with
 * `conflictsWith` naming the other side). The server refuses such an upload
 * wholesale with the same guard, so the dialog refuses the change that would
 * create it instead, while the person can still see which path to fix.
 */
export class FolderPathCollisionError extends Error {
	constructor(
		public readonly kind: "duplicate" | "file-directory",
		public readonly path: string,
		public readonly conflictsWith: string | null = null,
	) {
		super(
			kind === "duplicate"
				? `Two added files would be stored as ${path}`
				: `${conflictsWith ?? path} and ${path} need one name as both a file and a folder`,
		);
		this.name = "FolderPathCollisionError";
	}
}

/**
 * Hash per `File` OBJECT, not per path. The dialog recomputes every entry
 * from every source on each add, remove or checkbox toggle (a newly added
 * root `.fabricignore` can change what every other source keeps), and without
 * this each of those would re-read and re-hash every kept file. A `WeakMap`
 * because the `File`s belong to the dialog's state: once it drops a source,
 * its cached hashes go with it.
 */
const hashCache = new WeakMap<File, Promise<string>>();

function hashFile(file: File): Promise<string> {
	const cached = hashCache.get(file);
	if (cached) {
		return cached;
	}
	const pending = file
		.arrayBuffer()
		.then((buf) => sha256Hex(new Uint8Array(buf)));
	hashCache.set(file, pending);
	// A failed read (the file changed or vanished on disk after it was
	// picked) must not poison the cache: the next recompute should try again.
	pending.catch(() => hashCache.delete(file));
	return pending;
}

/**
 * The path a file is stored under, before validation.
 *
 * `webkitRelativePath` always starts with the picked folder's own name (e.g.
 * `example-skills/CLAUDE.md`). A root-mode folder strips that segment so the
 * path is relative to the folder's contents; a `keepName` folder keeps it so
 * the folder name becomes the top-level directory. A browser that reports no
 * relative path still gets a sensible place for the file under the folder's
 * name rather than silently landing it at the root.
 */
function composePath(source: PickedSource, file: File): string {
	if (source.kind === "files") {
		return file.name;
	}
	const rel =
		(file as File & { webkitRelativePath?: string }).webkitRelativePath ||
		`${source.name}/${file.name}`;
	if (source.keepName) {
		return rel;
	}
	const i = rel.indexOf("/");
	return i >= 0 ? rel.slice(i + 1) : rel;
}

/**
 * Reads the dialog's picked sources entirely client-side: composes each
 * file's stored path (see `PickedSource`), classifies it with the same
 * `@repo/instructions` taxonomy the server uses, previews the ignore rules
 * that will apply (an uploaded `.fabricignore` wins over the project's saved
 * globs, which win over the built-in defaults — see `resolveIgnoreGlobs`),
 * and hashes only the files those rules KEEP. Excluded files are never sent
 * to the server (`uploadSnapshot`), so their bytes are not read at all.
 *
 * The rules come from a `.fabricignore` at the COMPOSED root, exact match —
 * the same `FABRIC_IGNORE_FILE` the server reads. A `.fabricignore` inside a
 * folder whose name is kept (`.claude/.fabricignore`) is therefore ordinary
 * content, exactly as it would be for the server.
 *
 * This preview decides what is SENT, but never what is stored: the server
 * re-validates and re-applies ignore rules independently in
 * `begin-snapshot.ts`, and may still leave out a file this kept (see
 * `uploadSnapshot`'s `serverExcludedPaths`).
 *
 * A path `validateRelativePath` rejects (traversal, absolute, control
 * characters, too long/deep) is silently omitted from the preview — the
 * server would reject the whole upload for the same reason, but surfacing
 * every possible rejection reason client-side is not this preview's job.
 *
 * Throws `FolderPathCollisionError` when the kept paths cannot coexist as
 * one tree — a duplicate spelling or a file/folder name clash, judged by
 * `createTreeCollisionGuard`, the same guard `begin-snapshot.ts` runs. It is
 * run over every kept path, not only pairs from different sources, so the
 * dialog refuses exactly what the server would. Excluded paths are not
 * judged, for the server's reason — the question is about the resulting
 * tree, and two sources that both carry an excluded `node_modules/` collide
 * in nothing that is uploaded.
 */
export async function readFolderFiles(
	sources: PickedSource[],
	projectGlobs?: string[] | null,
): Promise<{ entries: FolderEntry[]; fabricIgnoreText: string | null }> {
	const candidates: Array<{ file: File; path: string }> = [];
	for (const source of sources) {
		for (const file of source.files) {
			const v = validateRelativePath(composePath(source, file));
			if (v.ok) {
				candidates.push({ file, path: v.path });
			}
		}
	}

	// Two root `.fabricignore` files would leave no single answer to "which
	// rules apply", so that collision is refused before either is read.
	const ignoreFiles = candidates.filter((c) => c.path === FABRIC_IGNORE_FILE);
	if (ignoreFiles.length > 1) {
		throw new FolderPathCollisionError("duplicate", FABRIC_IGNORE_FILE);
	}
	const ignoreFile = ignoreFiles[0];
	const fabricIgnoreText = ignoreFile ? await ignoreFile.file.text() : null;
	const isIgnored = buildIgnoreMatcher(
		resolveIgnoreGlobs({ fabricIgnoreText, projectGlobs }),
	);

	const judged = candidates.map((c) => ({
		...c,
		excluded: isIgnored(c.path),
	}));

	const tree = createTreeCollisionGuard();
	for (const c of judged) {
		if (c.excluded) {
			continue;
		}
		const collision = tree.add(c.path);
		if (collision) {
			throw new FolderPathCollisionError(
				collision.kind,
				collision.path,
				collision.kind === "file-directory"
					? collision.conflictsWith
					: null,
			);
		}
	}

	const entries: FolderEntry[] = [];
	for (const { file, path, excluded } of judged) {
		entries.push({
			path,
			file,
			size: file.size,
			sha256: excluded ? null : await hashFile(file),
			kind: classifyPath(path),
			excluded,
			secretRule: isSecretFileName(path),
		});
	}
	return { entries, fabricIgnoreText };
}
