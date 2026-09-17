import {
	buildIgnoreMatcher,
	classifyPath,
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
	sha256: string;
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
 * Strips the picked folder's own top-level segment
 * (`webkitRelativePath` always starts with it, e.g.
 * `example-skills/CLAUDE.md`) so every downstream path is relative to the
 * folder's *contents*, matching what the server expects and what
 * `validateRelativePath` normalizes.
 */
function relativePath(f: File): string {
	const rel =
		(f as File & { webkitRelativePath?: string }).webkitRelativePath ||
		f.name;
	const i = rel.indexOf("/");
	return i >= 0 ? rel.slice(i + 1) : rel;
}

/**
 * Reads a picked folder's files entirely client-side: strips the folder
 * name, hashes every file with Web Crypto, classifies it with the same
 * `@repo/instructions` taxonomy the server uses, and previews the ignore
 * rules that will apply (an uploaded `.fabricignore` wins over the
 * project's saved globs, which win over the built-in defaults — see
 * `resolveIgnoreGlobs`). This preview never decides anything: the server
 * re-validates and re-applies ignore rules independently in
 * `begin-snapshot.ts`, so a mismatch here only affects what the dialog
 * shows, never what gets stored.
 *
 * A path `validateRelativePath` rejects (traversal, absolute, control
 * characters, too long/deep) is silently omitted from the preview — the
 * server would reject the whole upload for the same reason, but surfacing
 * every possible rejection reason client-side is not this preview's job.
 */
export async function readFolderFiles(
	input: FileList | File[],
	projectGlobs?: string[] | null,
): Promise<{ entries: FolderEntry[]; fabricIgnoreText: string | null }> {
	const files = Array.from(input);
	const withPaths = files.map((file) => ({ file, rel: relativePath(file) }));
	const ignoreFile = withPaths.find((x) => x.rel === ".fabricignore");
	const fabricIgnoreText = ignoreFile ? await ignoreFile.file.text() : null;
	const isIgnored = buildIgnoreMatcher(
		resolveIgnoreGlobs({ fabricIgnoreText, projectGlobs }),
	);

	const entries: FolderEntry[] = [];
	for (const { file, rel } of withPaths) {
		const v = validateRelativePath(rel);
		if (!v.ok) {
			continue;
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		entries.push({
			path: v.path,
			file,
			size: file.size,
			sha256: await sha256Hex(bytes),
			kind: classifyPath(v.path),
			excluded: isIgnored(v.path),
			secretRule: isSecretFileName(v.path),
		});
	}
	return { entries, fabricIgnoreText };
}
