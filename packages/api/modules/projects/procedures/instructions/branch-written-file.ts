import { getInstructionFileByPath, loadGitIntent } from "@repo/database";
import { fileTypingFor } from "@repo/instructions";

/**
 * The stored file behind a blob Fabric wrote on a member's proposal branch:
 * what proposal `snapshotId` held at `path` (a native proposal's PUT, or an
 * upload-mode file), provided it is still the file the branch journal
 * recorded, by `sha256` when the journal has one. Null when Fabric no longer
 * holds those bytes. The branch editor's read and a reviewer's "before" side
 * of a branch-relative change both go through here, so they trust the same
 * bytes.
 */
export async function findBranchWrittenFile(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	path: string;
	sha256: string | null;
}) {
	const intent = await loadGitIntent({
		snapshotId: input.snapshotId,
		projectId: input.projectId,
		organizationId: input.organizationId,
	});
	const changed =
		intent?.status === "READY"
			? intent.gitIntentEntries.find(
					(file) =>
						file.path === input.path && file.operation === "PUT",
				)
			: undefined;
	const file = intent
		? changed &&
			changed.storageKey !== null &&
			changed.sha256 !== null &&
			changed.size !== null
			? {
					projectId: input.projectId,
					path: changed.path,
					sha256: changed.sha256,
					storageKey: changed.storageKey,
					size: changed.size,
					mimeType:
						changed.mimeType ??
						fileTypingFor(changed.path).mimeType,
					isText: changed.isText,
					mode: changed.mode,
				}
			: null
		: await getInstructionFileByPath(
				input.snapshotId,
				input.organizationId,
				input.path,
			);
	if (
		!file ||
		file.projectId !== input.projectId ||
		(input.sha256 !== null && file.sha256 !== input.sha256)
	) {
		return null;
	}
	return file;
}
