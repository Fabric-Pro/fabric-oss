import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { createId } from "@paralleldrive/cuid2";
import { config } from "@repo/config";
import {
	type AdmitGitIntentInput,
	admitGitIntent,
	findExistingGitIntent,
	type GitIntentEntry,
	readMemberBranchDeletedPaths,
	readMemberBranchWrittenPaths,
} from "@repo/database";
import {
	BRANCH_DELETED_OBJECT_ID,
	scanTextForSecrets,
	snapshotKey,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import type { AuditRequestContext } from "../../../../lib/audit";
import { validateInstructionChanges } from "./change-set";
import { startDirectCommitWorkflow } from "./direct-commit-workflow";
import { admitInstructionProposal } from "./proposal-admission";
import { startAdmittedProposalPullRequest } from "./proposal-pull-request";
import { listDirectRepositoryFiles } from "./repository/direct-read";
import {
	assertDirectRepositoryPin,
	assertDirectRepositorySourceCurrent,
	loadDirectRepositorySource,
	resolveDirectRepositoryIgnore,
} from "./repository/direct-source";

const SKILLS_BUCKET = config.storage.bucketNames.skills;

export type NativeChange =
	| { op: "put"; path: string; content: Buffer }
	| { op: "delete"; path: string };

export type NativeInstructionChangeInput = {
	projectId: string;
	organizationId: string;
	userId: string;
	nativeBase: { generation: number; commitSha: string };
	mode: "proposal" | "commit";
	changes: readonly NativeChange[];
	note?: unknown;
	message?: string;
	audit: AuditRequestContext;
	via: string;
};

export type NativeInstructionChangeResult = {
	mode: "proposal" | "commit";
	snapshotId: string;
	version: number;
	nativeBase: { generation: number; commitSha: string };
	putCount: number;
	deleteCount: number;
	status: "READY";
	proposalStatus: "PENDING" | null;
};

function refusal(reason: string, message: string): never {
	throw new ORPCError("PRECONDITION_FAILED", {
		message,
		data: { reason },
	});
}

function decodeText(bytes: Buffer): string | null {
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

/**
 * Admits an inline native operation without constructing an instruction
 * snapshot tree. PUT bytes are immutable changed-path objects; deletes carry
 * only the Git object they were based on.
 */
export async function submitGitIntentChange(
	input: NativeInstructionChangeInput,
): Promise<NativeInstructionChangeResult> {
	const source = await loadDirectRepositorySource({
		projectId: input.projectId,
		userId: input.userId,
	});
	try {
		await assertDirectRepositoryPin(source, input.nativeBase);
		const [ignore, listed] = await Promise.all([
			resolveDirectRepositoryIgnore(source, input.nativeBase),
			listDirectRepositoryFiles({ source, pin: input.nativeBase }),
		]);
		if (listed.incomplete || listed.refusal !== null) {
			refusal(
				"REPOSITORY_TREE_INCOMPLETE",
				"The repository tree could not be read completely. Refresh and try again.",
			);
		}

		const raw = input.changes.map((change) =>
			change.op === "put"
				? {
						op: "put" as const,
						path: change.path,
						size: change.content.byteLength,
						sha256: createHash("sha256")
							.update(change.content)
							.digest("hex"),
					}
				: { op: "delete" as const, path: change.path },
		);
		const { changes, putCount, deleteCount } = validateInstructionChanges({
			projectId: input.projectId,
			changes: raw,
			settingsFrozen: {
				layer: ignore.layer,
				ignoreGlobs: ignore.globs,
			},
		});
		const bytesByPath = new Map<string, Buffer>();
		const textPaths = new Set<string>();
		for (const [index, change] of input.changes.entries()) {
			const validated = changes[index];
			if (change.op === "put" && validated?.op === "put") {
				const text = decodeText(change.content);
				if (text !== null) {
					textPaths.add(validated.path);
					if (scanTextForSecrets(text, { limit: 0 }).total > 0) {
						throw new ORPCError("UNPROCESSABLE_CONTENT", {
							message: "A changed file cannot be accepted.",
							data: { reason: "CONTENT_REJECTED" },
						});
					}
				}
				bytesByPath.set(validated.path, change.content);
			}
		}

		const filesByPath = new Map(
			listed.files.map((file) => [file.path, file]),
		);
		// A path may be a file Fabric wrote on the caller's OWN proposal branch.
		// A proposal may then delete or edit it there even when the published
		// version lacks it, and the entry freezes the branch's blob so a
		// reviewer sees the change against what the branch held. A published
		// file the branch deleted has no blob, and putting it back freezes
		// that instead. A direct commit targets the synced branch, never a
		// member's, so it reads no branch.
		const proposedPaths =
			input.mode === "proposal"
				? changes.map((change) => change.path)
				: [];
		const onBranch = await readMemberBranchWrittenPaths({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			paths: proposedPaths,
		});
		const deletedOnBranch = await readMemberBranchDeletedPaths({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			paths: proposedPaths.filter((path) => filesByPath.has(path)),
		});
		const snapshotId = createId();
		const entries: GitIntentEntry[] = changes.map((change, index) => {
			const base = filesByPath.get(change.path);
			const branchFile = onBranch.get(change.path);
			const branchTarget = branchFile
				? { branchObjectId: branchFile.objectId }
				: change.op === "put" && deletedOnBranch.has(change.path)
					? { branchObjectId: BRANCH_DELETED_OBJECT_ID }
					: {};
			let baseEntry: { objectId: string; mode: number } | null = null;
			if (base) {
				if (base.blobId === undefined || base.mode === undefined) {
					refusal(
						"REPOSITORY_BASE_UNAVAILABLE",
						"The changed file's Git identity is unavailable. Refresh and try again.",
					);
				}
				baseEntry = {
					objectId: base.blobId,
					mode: Number.parseInt(base.mode, 8),
				};
			}
			if (change.op === "delete") {
				if (baseEntry === null && branchFile === undefined) {
					refusal(
						"REPOSITORY_BASE_UNAVAILABLE",
						"That file is no longer in the repository.",
					);
				}
				return {
					op: "DELETE",
					path: change.path,
					base: baseEntry,
					...branchTarget,
				};
			}
			const bytes = bytesByPath.get(change.path);
			if (!bytes) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Validated change bytes were unavailable.",
				});
			}
			return {
				op: "PUT",
				path: change.path,
				base: baseEntry,
				storageKey: snapshotKey(
					input.projectId,
					snapshotId,
					`intent-${index}`,
				),
				sha256: change.sha256,
				size: change.size,
				mimeType: change.mimeType,
				isText: textPaths.has(change.path),
				// An edit keeps the file's mode: the branch's for a file only
				// the branch holds, so an executable stays executable.
				mode: baseEntry?.mode ?? branchFile?.mode ?? 0o100644,
				kind: change.kind,
				...branchTarget,
			};
		});

		const admission = await admitInstructionProposal({
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			mode: input.mode,
			nativeBase: input.nativeBase,
			note: input.note,
			proposerName: input.audit.user?.name,
			fileCount: entries.length,
			...(input.mode === "commit"
				? { message: input.message ?? "" }
				: {}),
		});
		if (admission.destination === "FABRIC") {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Repository admission returned an uploaded destination.",
			});
		}

		const admissionInput: AdmitGitIntentInput = {
			snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			repositoryIntegrationId: source.integrationId,
			syncId:
				admission.destination === "REPOSITORY"
					? admission.syncId
					: admission.context.syncId,
			rootPath: source.rootPath,
			sourceRef: source.ref,
			sourceCommitSha: input.nativeBase.commitSha,
			repositoryGeneration: input.nativeBase.generation,
			settingsFrozen: { layer: ignore.layer, ignoreGlobs: ignore.globs },
			delivery:
				admission.destination === "REPOSITORY"
					? {
							kind: "PROPOSAL",
							context: admission.context,
							operationId: admission.operationId,
							note: admission.note,
							...(admission.blocked
								? { blocked: admission.blocked }
								: {}),
						}
					: {
							kind: "COMMIT",
							context: admission.context,
							message: admission.context.message,
						},
			entries,
			validated: true,
		};
		const existing = await findExistingGitIntent(admissionInput);
		if (existing) {
			if (admission.destination === "REPOSITORY" && !admission.blocked) {
				await startAdmittedProposalPullRequest({
					snapshotId: existing.id,
					projectId: input.projectId,
					organizationId: input.organizationId,
					operationId: admission.operationId,
				});
			} else if (admission.destination === "REPOSITORY_COMMIT") {
				await startDirectCommitWorkflow({
					snapshotId: existing.id,
					organizationId: input.organizationId,
				});
			}
			return {
				mode: input.mode,
				snapshotId: existing.id,
				version: existing.version,
				nativeBase: input.nativeBase,
				putCount,
				deleteCount,
				status: "READY",
				proposalStatus: input.mode === "proposal" ? "PENDING" : null,
			};
		}

		const storage = getStorageProvider();
		const stagedKeys = entries.flatMap((entry) =>
			entry.op === "PUT" ? [entry.storageKey] : [],
		);
		let stagedKeysDiscarded = false;
		const discardStagedKeys = async () => {
			if (!stagedKeysDiscarded && stagedKeys.length > 0) {
				await storage.deleteObjects(stagedKeys, {
					bucket: SKILLS_BUCKET,
				});
				stagedKeysDiscarded = true;
			}
		};
		let admitted = false;
		try {
			for (const entry of entries) {
				if (entry.op === "PUT") {
					const bytes = bytesByPath.get(entry.path);
					if (!bytes) {
						throw new ORPCError("INTERNAL_SERVER_ERROR", {
							message: "Validated change bytes were unavailable.",
						});
					}
					await storage.uploadFile(entry.storageKey, bytes, {
						bucket: SKILLS_BUCKET,
						contentType: entry.mimeType,
					});
				}
			}
			await assertDirectRepositorySourceCurrent({
				projectId: input.projectId,
				userId: input.userId,
				source,
			});

			const result = await admitGitIntent(admissionInput);
			if (!result.ok) {
				await discardStagedKeys();
				refusal(
					"GIT_INTENT_REFUSED",
					"The repository change could not be admitted. Refresh and try again.",
				);
			}
			admitted = !result.existing;
			if (result.existing) {
				await discardStagedKeys();
			}
			if (admission.destination === "REPOSITORY" && !admission.blocked) {
				await startAdmittedProposalPullRequest({
					snapshotId: result.snapshotId,
					projectId: input.projectId,
					organizationId: input.organizationId,
					operationId: admission.operationId,
				});
			}
			if (admission.destination === "REPOSITORY_COMMIT") {
				await startDirectCommitWorkflow({
					snapshotId: result.snapshotId,
					organizationId: input.organizationId,
				});
			}
			return {
				mode: input.mode,
				snapshotId: result.snapshotId,
				version: result.version,
				nativeBase: input.nativeBase,
				putCount,
				deleteCount,
				status: "READY",
				proposalStatus: input.mode === "proposal" ? "PENDING" : null,
			};
		} catch (error) {
			if (!admitted) {
				await discardStagedKeys().catch(() => {});
			}
			throw error;
		}
	} finally {
		await assertDirectRepositorySourceCurrent({
			projectId: input.projectId,
			userId: input.userId,
			source,
		});
	}
}
