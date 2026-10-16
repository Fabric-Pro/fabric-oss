/**
 * One Living Memory write, from its receipt to how it ended (ADR-022). The
 * write workflow runs this in ONE activity that owns every read of the
 * repository and every git write; the receipt is written by the workflow's own
 * record activity, not here.
 *
 * Order of evidence, each step before anything is written:
 *
 * 1. The receipt must be `PENDING`; otherwise there is nothing to do.
 * 2. Live re-check (`checkMemoryWriteStillAllowed`): the target, the sync, the
 *    project, the member's right and the folder, against what the receipt froze.
 * 3. The staged bytes are read back and must be exactly the size and SHA-256
 *    the write named: a signed upload URL stays usable until it expires, so
 *    what admission scanned is verified again, not trusted.
 * 4. The commit text is rendered once, with the attribution every Fabric commit
 *    has and the write's trailers.
 * 5. Under the integration's fresh credential, a blobless clone of the synced
 *    branch, the bytes hashed into it, and the git half (`pushMemoryWrite`):
 *    the tip checks, the batch as one commit, the push or the pull request.
 *
 * A retry of the activity is recovered, not repeated: a commit of this write
 * already on the branch, or its own branch already pushed, is found by the
 * write's trailer. When the live checks refuse a retry, a commit an earlier
 * attempt already pushed is still a fact they do not undo, so it is looked for
 * before the refusal is answered.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { config } from "@repo/config";
import {
	getMemoryWriteForRun,
	getProjectRepoIntegration,
	type MemoryWriteRunRow,
} from "@repo/database";
import { renderMemoryWriteText } from "@repo/instructions/pull-request-text";
import {
	repositoryIdentity,
	repositoryKey,
} from "@repo/integrations/instruction-pull-requests";
import type {
	MemoryWriteOutcome,
	MemoryWriteRefusalCode,
} from "../../lib/memory-write/outcome";
import {
	isMemoryWriteStagingKeyOf,
	readStagedBytes,
} from "../../lib/memory-write/staging";
import { selectedPathContaining } from "../../lib/memory-write/target-rules";
import type {
	MemoryWriteStepResult,
	MemoryWriteWorkflowInput,
} from "../../lib/memory-write-types";
import {
	type BranchCredential,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import { fetchSyncedTip, initBranchWorkspace } from "./instruction-branch-git";
import { hashBlob } from "./instruction-branch-support";
import {
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import { gitCall } from "./instruction-proposal-operation";
import { findLandedWriteCommit } from "./memory-write-git";
import {
	checkMemoryWriteStillAllowed,
	type LiveMemoryWriteState,
} from "./memory-write-live";
import type { HashedWriteEntry } from "./memory-write-plan";
import { MemoryWriteRefused, pushMemoryWrite } from "./memory-write-push";

const fail = (
	code: ProposalStepFailure["code"],
	retryable: boolean,
	phase: ProposalStepFailure["phase"],
) => new ProposalStepFailure({ code, phase, retryable });

const refused = (code: MemoryWriteRefusalCode): MemoryWriteStepResult => ({
	kind: "outcome",
	outcome: { status: "REFUSED", code },
});

type StagedFile = {
	entry: MemoryWriteRunRow["entries"][number];
	bytes: Buffer;
};

/**
 * Reads back the staged bytes of every PUT and checks them against what the
 * write named. `changed` lists the paths whose bytes are not those: a key that
 * is not this project's staging key, an object that is gone, one of another
 * size or hash. A storage fault is a retryable failure, not a mismatch.
 */
async function readStagedFiles(
	write: MemoryWriteRunRow,
	signal: AbortSignal,
): Promise<{ files: StagedFile[]; changed: string[] }> {
	const files: StagedFile[] = [];
	const changed: string[] = [];
	for (const entry of write.entries) {
		if (entry.op !== "PUT") {
			continue;
		}
		assertMayContinue(signal);
		const { stagedKey, bytes, sha256 } = entry;
		if (
			stagedKey === null ||
			bytes === null ||
			sha256 === null ||
			!isMemoryWriteStagingKeyOf(write.projectId, stagedKey)
		) {
			changed.push(entry.path);
			continue;
		}
		let read: Awaited<ReturnType<typeof readStagedBytes>>;
		try {
			read = await readStagedBytes({ key: stagedKey, bytes, sha256 });
		} catch (error) {
			if (signal.aborted) {
				throw error;
			}
			throw fail("STORAGE_FAILED", true, "append");
		}
		if (read.ok) {
			files.push({ entry, bytes: read.bytes });
		} else {
			changed.push(entry.path);
		}
	}
	return { files, changed };
}

/** The destination the credential helper acts under, built from the live integration. */
function destinationOf(write: MemoryWriteRunRow, state: LiveMemoryWriteState) {
	const { integration } = state.sync;
	const repository = repositoryIdentity(
		integration.provider,
		integration.repositoryUrl,
	);
	if (repository === null) {
		throw fail("REPOSITORY_UNAVAILABLE", true, "prepare");
	}
	return {
		integrationId: write.repositoryIntegrationId,
		syncId: state.sync.id,
		repositoryKey: repositoryKey(repository),
		provider: repository.provider,
		repository,
		targetRef: write.ref,
		rootPath: "",
	};
}

function branchOf(
	write: MemoryWriteRunRow,
	destination: ReturnType<typeof destinationOf>,
) {
	return {
		id: write.id,
		projectId: write.projectId,
		organizationId: write.organizationId,
		userId: write.userId,
		destination,
	};
}

/** Clones the synced branch into the credential's workspace: blobless, one branch, no checkout. */
function cloneSynced(credential: BranchCredential, ref: string) {
	return gitCall("prepare", credential, () =>
		initBranchWorkspace({
			url: credential.url,
			targetRef: ref,
			dir: credential.workDir,
			env: credential.env,
			signal: credential.signal,
		}),
	);
}

/**
 * A commit of this write on the branch although the live checks now refuse
 * it: an earlier attempt pushed it and lost the acknowledgement. Looked for
 * only on a retry of a direct push; anything that stops the look (the
 * integration is gone, the credential cannot be had) means no commit is known,
 * and the refusal stands.
 */
async function landedAfterRefusal(
	write: MemoryWriteRunRow,
	signal: AbortSignal,
): Promise<string | null> {
	try {
		const integration = await getProjectRepoIntegration(
			write.repositoryIntegrationId,
			write.projectId,
		);
		const repository = integration
			? repositoryIdentity(
					integration.provider,
					integration.repositoryUrl,
				)
			: null;
		if (repository === null) {
			return null;
		}
		// The credential helper's destination schema asks for a sync id; the sync
		// may be gone by now, and nothing here reads it, so the target stands in.
		const destination = {
			integrationId: write.repositoryIntegrationId,
			syncId: write.targetId,
			repositoryKey: repositoryKey(repository),
			provider: repository.provider,
			repository,
			targetRef: write.ref,
			rootPath: "",
		};
		return await withBranchRepoCredential(
			{ branch: branchOf(write, destination), phase: "append", signal },
			async (credential) => {
				await cloneSynced(credential, write.ref);
				const git = {
					dir: credential.workDir,
					env: credential.env,
					signal: credential.signal,
				};
				const tip = await gitCall("append", credential, () =>
					fetchSyncedTip({
						...git,
						branch: write.ref,
						allowedRef: write.ref,
					}),
				);
				if (tip.kind === "absent") {
					return null;
				}
				return gitCall("append", credential, () =>
					findLandedWriteCommit({
						...git,
						tip: tip.sha,
						writeId: write.id,
						since: new Date(write.createdAt.getTime() - 60_000),
					}),
				);
			},
		);
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}
		return null;
	}
}

export type ExecuteMemoryWriteInput = {
	input: MemoryWriteWorkflowInput;
	signal: AbortSignal;
	/** Temporal's attempt number of the running activity, 1 for the first. */
	attempt: number;
};

export async function executeMemoryWrite(
	i: ExecuteMemoryWriteInput,
): Promise<MemoryWriteStepResult> {
	const { input, signal } = i;
	const write = await getMemoryWriteForRun({
		writeId: input.writeId,
		projectId: input.projectId,
		organizationId: input.organizationId,
	});
	if (!write || write.status !== "PENDING") {
		return { kind: "stopped" };
	}

	const live = await checkMemoryWriteStillAllowed(write);
	if (!live.ok) {
		if (i.attempt > 1 && write.mode === "DIRECT_PUSH") {
			const sha = await landedAfterRefusal(write, signal);
			if (sha !== null) {
				return {
					kind: "outcome",
					outcome: {
						status: "COMMITTED",
						sha,
						ref: write.ref,
						fileCount: write.entries.length,
					},
				};
			}
		}
		return refused(live.code);
	}
	const { state } = live;

	const { files, changed } = await readStagedFiles(write, signal);
	if (changed.length > 0) {
		return refused("STAGED_BYTES_CHANGED");
	}

	const text = renderMemoryWriteText({
		message: write.message,
		proposerName: state.userName ?? "",
		mailFrom: config.mails.from,
		writeId: write.id,
		agentId: write.oauthClientId,
	});
	if (!text.ok) {
		return refused(
			text.code === "ATTRIBUTION_REJECTED"
				? "ATTRIBUTION_REJECTED"
				: "MESSAGE_REJECTED",
		);
	}

	const selection = {
		paths: state.sync.paths,
		excludedPaths: state.sync.excludedPaths,
	};
	const selected = selectedPathContaining(selection, write.folder);
	if (selected === null) {
		return refused("TARGET_STALE");
	}

	const destination = destinationOf(write, state);
	return withBranchRepoCredential(
		{ branch: branchOf(write, destination), phase: "append", signal },
		async (credential): Promise<MemoryWriteStepResult> => {
			await cloneSynced(credential, write.ref);

			const blobByPath = new Map<string, string>();
			for (const { entry, bytes } of files) {
				assertMayContinue(signal);
				blobByPath.set(
					entry.path,
					await gitCall("append", credential, () =>
						hashBlob({
							dir: credential.workDir,
							bytes,
							env: credential.env,
							signal: credential.signal,
						}),
					),
				);
			}
			const entries: HashedWriteEntry[] = write.entries.map((entry) => ({
				path: entry.path,
				op: entry.op,
				ifMatchOid: entry.ifMatchOid,
				blobOid: blobByPath.get(entry.path) ?? null,
			}));

			const outcome: MemoryWriteOutcome = await pushMemoryWrite({
				credential,
				write: {
					id: write.id,
					ref: write.ref,
					mode: write.mode,
					createdAt: write.createdAt,
				},
				text,
				entries,
				selected,
				leftOut: state.sync.excludedPaths,
				assertStillAllowed: async () => {
					const again = await checkMemoryWriteStillAllowed(write);
					if (!again.ok) {
						throw new MemoryWriteRefused(again.code);
					}
				},
			});
			return { kind: "outcome", outcome };
		},
	);
}
