import { diffInstructionManifests, listInstructionFiles } from "@repo/database";

/**
 * The path-level comparison of two coding-instruction versions that the
 * compare procedure and the since-last-visit digest both show. No bytes are
 * read: two file-list queries, then the one manifest diff the repository has
 * (`diffInstructionManifests`), so "changed" means exactly what it means to
 * the installed-copy diff MCP clients read.
 *
 * The caller has already loaded both snapshots tenant-scoped and checked
 * them readable; this only lists their files. `sha256` and `storageKey` are
 * read to compute the diff and never returned.
 */
export async function compareInstructionVersions(input: {
	fromSnapshotId: string;
	toSnapshotId: string;
	organizationId: string;
}) {
	const [fromFiles, toFiles] = await Promise.all([
		listInstructionFiles(input.fromSnapshotId, input.organizationId),
		listInstructionFiles(input.toSnapshotId, input.organizationId),
	]);
	const fromByPath = new Map(fromFiles.map((f) => [f.path, f]));
	const toByPath = new Map(toFiles.map((f) => [f.path, f]));
	const changes = diffInstructionManifests(fromFiles, toFiles);

	const added = changes.added.flatMap((path) => {
		const file = toByPath.get(path);
		return file
			? [
					{
						path: file.path,
						kind: file.kind,
						isText: file.isText,
						size: file.size,
					},
				]
			: [];
	});
	const removed = changes.removed.flatMap((path) => {
		const file = fromByPath.get(path);
		return file
			? [
					{
						path: file.path,
						kind: file.kind,
						isText: file.isText,
						size: file.size,
					},
				]
			: [];
	});
	const changed = changes.changed.flatMap((path) => {
		const before = fromByPath.get(path);
		const after = toByPath.get(path);
		return before && after
			? [
					{
						path: after.path,
						kind: after.kind,
						// Diffable only when BOTH sides are text: a file
						// that turned binary (or stopped being one) has no
						// honest line diff to render.
						isText: before.isText && after.isText,
						fromSize: before.size,
						toSize: after.size,
					},
				]
			: [];
	});

	return {
		added,
		removed,
		changed,
		// Everything the `to` version carries that this diff did not name.
		unchangedCount: toFiles.length - added.length - changed.length,
	};
}
