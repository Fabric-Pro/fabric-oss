import { listInstructionFiles, loadGitIntent } from "@repo/database";
import {
	computeEffectiveDelta,
	type EffectiveDelta,
	type FileRow,
} from "./instruction-proposal-commit";
import { ProposalStepFailure } from "./instruction-proposal-boundary";

/** Native receipts contain only changed paths; uploaded snapshots retain their full-tree diff. */
export async function loadInstructionChangeDelta(operation: {
	id: string;
	projectId: string;
	organizationId: string;
	contentKind: "FULL_SNAPSHOT" | "GIT_INTENT";
	baseSnapshotId: string | null;
}): Promise<EffectiveDelta> {
	if (operation.contentKind === "FULL_SNAPSHOT") {
		const [base, changed] = await Promise.all([
			operation.baseSnapshotId
				? listInstructionFiles(
						operation.baseSnapshotId,
						operation.organizationId,
					)
				: Promise.resolve([]),
			listInstructionFiles(operation.id, operation.organizationId),
		]);
		return computeEffectiveDelta(base, changed);
	}
	const intent = await loadGitIntent({
		snapshotId: operation.id,
		projectId: operation.projectId,
		organizationId: operation.organizationId,
	});
	if (!intent || intent.status !== "READY") {
		throw new ProposalStepFailure({
			code: "CONFIGURATION_CHANGED",
			phase: "append",
			retryable: false,
		});
	}
	const delta: EffectiveDelta = { added: [], modified: [], deleted: [] };
	for (const entry of intent.gitIntentEntries) {
		if (entry.operation === "DELETE") {
			delta.deleted.push({ path: entry.path, mode: entry.baseMode });
			continue;
		}
		if (
			entry.sha256 === null ||
			entry.storageKey === null ||
			entry.mode === null
		) {
			throw new ProposalStepFailure({
				code: "STORAGE_FAILED",
				phase: "append",
				retryable: false,
			});
		}
		const row: FileRow = {
			path: entry.path,
			sha256: entry.sha256,
			storageKey: entry.storageKey,
			mode: entry.mode,
		};
		delta[entry.baseObjectId === null ? "added" : "modified"].push(row);
	}
	return delta;
}
