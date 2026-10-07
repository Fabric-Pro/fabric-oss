/**
 * Durable native repository-write intents.
 *
 * A GIT_INTENT is an operation receipt, not an instruction tree. It freezes
 * the configured repository revision and retains only the paths the caller
 * asked Fabric to change. The API stages PUT bytes before this transaction;
 * this query records their immutable references and seals the operation at
 * READY without entering the snapshot validation, publication, or inheritance
 * lifecycle.
 */
import { createHash } from "node:crypto";
import { db, Prisma } from "../client";
import type { ProjectInstructionFileKind } from "../generated/client";
import { migrationOfSettings } from "./instruction-migration-pointer";
import {
	activeProposalFilter,
	MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROJECT,
	MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER,
	withVersionRetry,
} from "./instructions";
import type { PullRequestFailure } from "./instruction-proposal-pull-requests";
import {
	canCreateProjectInstructions,
	canReadProjectInstructions,
} from "./projects/projects";

export const MAX_GIT_INTENT_ENTRIES = 50;

type GitIntentBase = {
	objectId: string;
	mode: number;
};

export type GitIntentPut = {
	op: "PUT";
	path: string;
	base: GitIntentBase | null;
	storageKey: string;
	sha256: string;
	size: number;
	mimeType: string;
	isText: boolean;
	mode: number;
	kind: ProjectInstructionFileKind;
};

export type GitIntentDelete = {
	op: "DELETE";
	path: string;
	base: GitIntentBase | null;
};

export type GitIntentEntry = GitIntentPut | GitIntentDelete;

export type AdmitGitIntentInput = {
	/** Generated before staged PUT bytes are written, so their keys are stable. */
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
	repositoryIntegrationId: string;
	syncId: string;
	rootPath: string;
	sourceRef: string;
	sourceCommitSha: string;
	repositoryGeneration: number;
	settingsFrozen: Prisma.InputJsonValue;
	delivery:
		| { kind: "COMMIT"; context: Prisma.InputJsonValue; message: string }
		| {
				kind: "PROPOSAL";
				context: Prisma.InputJsonValue;
				operationId: string;
				note: Prisma.InputJsonValue | null;
				blocked?: PullRequestFailure;
		  };
	entries: readonly GitIntentEntry[];
	/** Inline submissions have verified bytes; browser uploads seal after finalization. */
	validated: boolean;
};

export type AdmitGitIntentResult =
	| {
			ok: true;
			snapshotId: string;
			version: number;
			changeSetDigest: string;
			existing: boolean;
	  }
	| {
			ok: false;
			reason:
				| "direct_repository_required"
				| "empty_intent"
				| "duplicate_path"
				| "invalid_repository_pin"
				| "configuration_changed"
				| "permission_denied"
				| "read_only"
				| "proposer_limit"
				| "project_limit";
	  };

type LockedProject = {
	instructionSettings: Prisma.JsonValue;
	readOnlyMode: boolean;
};

function isRepositoryProject(settings: Prisma.JsonValue): boolean {
	return (
		typeof settings === "object" &&
		settings !== null &&
		!Array.isArray(settings) &&
		settings.sourceOfTruth === "REPOSITORY"
	);
}

function hasValidRepositoryPin(input: AdmitGitIntentInput): boolean {
	return (
		input.sourceRef.length > 0 &&
		/^[0-9a-f]{40}$/.test(input.sourceCommitSha) &&
		Number.isSafeInteger(input.repositoryGeneration) &&
		input.repositoryGeneration > 0
	);
}

function hasDistinctPaths(entries: readonly GitIntentEntry[]): boolean {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (entry.path.length === 0 || paths.has(entry.path)) {
			return false;
		}
		paths.add(entry.path);
	}
	return true;
}

function gitIntentDigest(input: AdmitGitIntentInput): string {
	const entries = [...input.entries]
		.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		)
		.map((entry) =>
			entry.op === "PUT"
				? {
						op: entry.op,
						path: entry.path,
						sha256: entry.sha256,
						mode: entry.mode,
						baseObjectId: entry.base?.objectId ?? null,
						baseMode: entry.base?.mode ?? null,
					}
				: {
						op: entry.op,
						path: entry.path,
						baseObjectId: entry.base?.objectId ?? null,
						baseMode: entry.base?.mode ?? null,
					},
		);
	return createHash("sha256")
		.update(
			JSON.stringify({
				generation: input.repositoryGeneration,
				integration: input.repositoryIntegrationId,
				ref: input.sourceRef,
				rootPath: input.rootPath,
				sha: input.sourceCommitSha,
				delivery: input.delivery.kind,
				message:
					input.delivery.kind === "COMMIT"
						? input.delivery.message
						: null,
				note:
					input.delivery.kind === "PROPOSAL"
						? input.delivery.note
						: null,
				entries,
			}),
		)
		.digest("hex");
}

/**
 * Finds an already admitted operation before an inline retry writes its
 * immutable PUT objects again. The admission transaction repeats this check
 * under the project lock, so this is an optimization only; concurrent first
 * attempts remain safe.
 */
export function findExistingGitIntent(input: AdmitGitIntentInput) {
	const changeSetDigest = gitIntentDigest(input);
	return db.projectInstructionSnapshot.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			contentKind: "GIT_INTENT",
			changeSetDigest,
			status: { notIn: ["REJECTED", "FAILED"] },
			createdAt: { gte: new Date(Date.now() - 2 * 60 * 60_000) },
		},
		orderBy: { version: "desc" },
		select: { id: true, version: true },
	});
}

/**
 * Creates and seals one native repository operation in a single transaction.
 * The project lock makes the repository-mode admission decision and version
 * allocation describe the same project state.
 */
export async function admitGitIntent(
	input: AdmitGitIntentInput,
): Promise<AdmitGitIntentResult> {
	if (input.entries.length === 0) {
		return { ok: false, reason: "empty_intent" };
	}
	if (
		input.entries.length > MAX_GIT_INTENT_ENTRIES ||
		!hasDistinctPaths(input.entries)
	) {
		return { ok: false, reason: "duplicate_path" };
	}
	if (!hasValidRepositoryPin(input)) {
		return { ok: false, reason: "invalid_repository_pin" };
	}

	const changeSetDigest = gitIntentDigest(input);
	return withVersionRetry(() =>
		db.$transaction(async (tx): Promise<AdmitGitIntentResult> => {
			const locked = await tx.$queryRaw<LockedProject[]>`
			SELECT p."instructionSettings", p."readOnlyMode"
			FROM "project" p
			WHERE p."id" = ${input.projectId}
				AND p."organizationId" = ${input.organizationId}
			FOR NO KEY UPDATE OF p
		`;
			const project = locked[0];
			if (
				!project ||
				!isRepositoryProject(project.instructionSettings) ||
				migrationOfSettings(project.instructionSettings)
			) {
				return { ok: false, reason: "direct_repository_required" };
			}
			const sync = await tx.projectInstructionRepositorySync.findFirst({
				where: {
					id: input.syncId,
					projectId: input.projectId,
					organizationId: input.organizationId,
					generation: input.repositoryGeneration,
					repositoryIntegrationId: input.repositoryIntegrationId,
					ref: input.sourceRef,
					rootPath: input.rootPath,
					repositoryIntegration: {
						status: "ACTIVE",
						projectId: input.projectId,
					},
				},
				select: { allowReaderProposals: true },
			});
			if (!sync) return { ok: false, reason: "configuration_changed" };
			const canCreate = await canCreateProjectInstructions(
				input.projectId,
				input.userId,
				tx,
			);
			if (
				!canCreate &&
				!(
					input.delivery.kind === "PROPOSAL" &&
					sync.allowReaderProposals &&
					(await canReadProjectInstructions(
						input.projectId,
						input.userId,
						tx,
					))
				)
			) {
				return { ok: false, reason: "permission_denied" };
			}
			if (input.delivery.kind === "COMMIT" && project.readOnlyMode) {
				return { ok: false, reason: "read_only" };
			}
			const existing = await tx.projectInstructionSnapshot.findFirst({
				where: {
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					contentKind: "GIT_INTENT",
					changeSetDigest,
					createdAt: { gte: new Date(Date.now() - 2 * 60 * 60_000) },
					status: { notIn: ["REJECTED", "FAILED"] },
				},
				orderBy: { version: "desc" },
				select: { id: true, version: true },
			});
			if (existing)
				return {
					ok: true,
					snapshotId: existing.id,
					version: existing.version,
					changeSetDigest,
					existing: true,
				};
			const active: Prisma.ProjectInstructionSnapshotWhereInput =
				input.delivery.kind === "PROPOSAL"
					? activeProposalFilter()
					: {
							proposalDestination: "REPOSITORY_COMMIT",
							commitOutcome: { equals: Prisma.AnyNull },
							status: { notIn: ["REJECTED", "FAILED"] },
							createdAt: {
								gte: new Date(Date.now() - 24 * 60 * 60_000),
							},
						};
			const activeWhere: Prisma.ProjectInstructionSnapshotWhereInput = {
				projectId: input.projectId,
				organizationId: input.organizationId,
				...active,
			};
			if (
				(await tx.projectInstructionSnapshot.count({
					where: { ...activeWhere, userId: input.userId },
				})) >= MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROPOSER
			)
				return { ok: false, reason: "proposer_limit" };
			if (
				(await tx.projectInstructionSnapshot.count({
					where: activeWhere,
				})) >= MAX_ACTIVE_INSTRUCTION_PROPOSALS_PER_PROJECT
			)
				return { ok: false, reason: "project_limit" };
			const [sequence] =
				input.delivery.kind === "PROPOSAL"
					? await tx.$queryRaw<
							Array<{ value: bigint }>
						>`SELECT nextval('project_instruction_proposal_intent_seq') AS value`
					: [];
			if (input.delivery.kind === "PROPOSAL" && !sequence)
				throw new Error(
					"The proposal intent sequence returned no value",
				);

			const latest = await tx.projectInstructionSnapshot.aggregate({
				where: {
					projectId: input.projectId,
					organizationId: input.organizationId,
				},
				_max: { version: true },
			});
			const snapshot = await tx.projectInstructionSnapshot.create({
				data: {
					id: input.snapshotId,
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					version: (latest._max.version ?? 0) + 1,
					source: "REPOSITORY",
					contentKind: "GIT_INTENT",
					status: "RECEIVING",
					repositoryIntegrationId: input.repositoryIntegrationId,
					sourceRef: input.sourceRef,
					sourceCommitSha: input.sourceCommitSha,
					repositoryGeneration: input.repositoryGeneration,
					repositoryBaseSha: input.sourceCommitSha,
					settingsFrozen: input.settingsFrozen,
					publishOnReady: false,
					fileCount: 0,
					storedBytes: 0,
					changeSetDigest,
					...(input.delivery.kind === "COMMIT"
						? {
								proposalDestination: "REPOSITORY_COMMIT",
								commitContext: input.delivery.context,
							}
						: {
								proposalDestination: "REPOSITORY",
								proposalStatus: "PENDING",
								proposalNote:
									input.delivery.note ?? Prisma.DbNull,
								pullRequestOperationId:
									input.delivery.operationId,
								pullRequestContext: input.delivery.context,
								proposalIntentOrder: sequence?.value,
								pullRequestState: input.delivery.blocked
									? "BLOCKED"
									: "QUEUED",
								pullRequestFailure: input.delivery.blocked,
							}),
					commitOutcome: Prisma.DbNull,
					gitIntentEntries: {
						create: input.entries.map((entry) =>
							entry.op === "PUT"
								? {
										organizationId: input.organizationId,
										userId: input.userId,
										operation: "PUT",
										path: entry.path,
										baseObjectId:
											entry.base?.objectId ?? null,
										baseMode: entry.base?.mode ?? null,
										storageKey: entry.storageKey,
										sha256: entry.sha256,
										size: entry.size,
										mimeType: entry.mimeType,
										isText: entry.isText,
										mode: entry.mode,
										kind: entry.kind,
									}
								: {
										organizationId: input.organizationId,
										userId: input.userId,
										operation: "DELETE",
										path: entry.path,
										baseObjectId:
											entry.base?.objectId ?? null,
										baseMode: entry.base?.mode ?? null,
									},
						),
					},
				},
				select: { id: true, version: true },
			});
			if (input.validated) {
				await tx.projectInstructionSnapshot.update({
					where: { id: snapshot.id },
					data: { status: "READY", readyAt: new Date() },
				});
			}
			return {
				ok: true,
				snapshotId: snapshot.id,
				version: snapshot.version,
				changeSetDigest,
				existing: false,
			};
		}),
	);
}

/** A tenant-scoped native operation and its immutable changed-path intent. */
export function loadGitIntent(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}) {
	return db.projectInstructionSnapshot.findFirst({
		where: {
			id: input.snapshotId,
			projectId: input.projectId,
			organizationId: input.organizationId,
			contentKind: "GIT_INTENT",
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			version: true,
			status: true,
			repositoryIntegrationId: true,
			sourceRef: true,
			sourceCommitSha: true,
			repositoryGeneration: true,
			repositoryBaseSha: true,
			settingsFrozen: true,
			proposalDestination: true,
			proposalStatus: true,
			commitContext: true,
			commitOutcome: true,
			gitIntentEntries: {
				orderBy: { path: "asc" },
				select: {
					id: true,
					operation: true,
					path: true,
					baseObjectId: true,
					baseMode: true,
					storageKey: true,
					sha256: true,
					size: true,
					mimeType: true,
					isText: true,
					mode: true,
					kind: true,
				},
			},
		},
	});
}

export type GitIntentOperation = NonNullable<
	Awaited<ReturnType<typeof loadGitIntent>>
>;
