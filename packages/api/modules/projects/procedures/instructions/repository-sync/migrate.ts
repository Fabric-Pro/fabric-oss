/**
 * `projects.instructions.repositorySync.migrate` — "Move these instructions
 * into a repository" (Fizzy #2878 §9): an upload-backed project's published
 * tree becomes ONE commit on a branch of a connected repository, opened as a
 * pull request, and the project switches to syncing from that folder once the
 * pull request is merged.
 *
 * The move reuses what a member's proposal already is. Nothing here writes to
 * the repository: this call creates the pieces and starts the existing member
 * branch workflow, which pushes the commit and opens the pull request, and
 * whose settlement switches the project when it merges (see
 * `@repo/database`'s `instruction-migration`, the temporal settlement hooks
 * and `migration.ts` for the reads and the commands that follow).
 *
 * Order, each step refusing before anything is written:
 *
 *  1. the caller may CREATE and UPDATE (it writes the sync configuration and
 *     publishes a version's worth of files), and the folder is a folder;
 *  2. the project is upload-backed with a published, ready version that has
 *     files, and no move is open;
 *  3. the integration is the project's own and the branch exists (the same
 *     checks and errors `configure` gives);
 *  4. the branch tip is read, and a folder that already holds files is
 *     `FOLDER_NOT_EMPTY` (409), so the pull request can never overwrite what
 *     is there. Where the provider offers no listing, or it was cut short, the
 *     branch machinery's own per-path rule still refuses an overwrite, and the
 *     move shows as BLOCKED;
 *  5. under the project row lock, the sync row is created paused `MIGRATING`
 *     (uploads stay the source of truth) together with the `PROPOSING`
 *     pointer, and from then on every other way of changing the instructions
 *     is frozen;
 *  6. the proposal: the published files carried whole (inherited, so nothing is
 *     uploaded again) as a REPOSITORY proposal with no base, admitted against
 *     that row at the branch tip, its validation started, and the member
 *     branch joined and woken.
 *
 * A failure after step 5 closes the move out (`start_failed`: the sync row and
 * the pointer go, the proposal row is rejected if it was created), so a failed
 * start never leaves the project frozen. Audited
 * `project.instructions.repository_migration_started`.
 */
import { ORPCError } from "@orpc/client";
import {
	isRepositoryTreeProvider,
	listRepositoryCommits,
	listRepositoryTree,
	verifyRepositoryBranch,
} from "@repo/connectors";
import {
	abandonInstructionMigration,
	attachInstructionMigrationProposal,
	createDerivedInstructionSnapshot,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
	joinProposalBranch,
	listInstructionFiles,
	rejectAbandonedInstructionSnapshot,
	startInstructionMigration,
} from "@repo/database";
import {
	collisionKey,
	SNAPSHOT_LIMITS,
	snapshotPrefix,
} from "@repo/instructions";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { derivedSnapshotRefusal } from "../change-set";
import { finalizeInstructionSnapshot } from "../finalize";
import { requireHostingOrganizationId } from "../hosting-organization";
import { migrationOpenError } from "../migration-freeze";
import {
	admitInstructionProposal,
	commitTextRefused,
	repositoryDestination,
	uploadStartedAuditTemplate,
} from "../proposal-admission";
import {
	proposalBranchNaming,
	wakeProposalBranchWorkflow,
} from "../proposal-branch";
import {
	instructionSyncRefSchema,
	loadInstructionSyncIntegration,
	MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH,
	normalizeRootPath,
	repositoryReadError,
	resolveInstructionSyncCredential,
} from "./repository";

/** Directory prefixes of a repository path, shortest first: `a/b/c.md` names `a` and `a/b`. */
function directoriesOf(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_, n) => parts.slice(0, n + 1).join("/"));
}

/**
 * Whether the folder on the branch already holds files the move would meet.
 * A named folder (`rootPath` not empty) must hold no file at all. The
 * repository root cannot: nearly every repository has files there, so it is
 * refused only for a path the move would write over or a file-and-folder
 * clash with the published tree, compared on the same collision keys the
 * snapshot planner uses (case and Unicode normalisation folded).
 */
export function folderIsNotEmpty(i: {
	rootPath: string;
	tipFiles: readonly string[];
	publishedPaths: readonly string[];
}): boolean {
	if (i.rootPath !== "") {
		const prefix = `${i.rootPath}/`;
		return i.tipFiles.some((path) => path.startsWith(prefix));
	}
	const files = new Set(i.publishedPaths.map(collisionKey));
	const folders = new Set(
		i.publishedPaths.flatMap(directoriesOf).map(collisionKey),
	);
	return i.tipFiles.some(
		(path) =>
			files.has(collisionKey(path)) ||
			folders.has(collisionKey(path)) ||
			directoriesOf(path).some((dir) => files.has(collisionKey(dir))),
	);
}

function conflict(
	reason: string,
	message: string,
): ORPCError<"CONFLICT", { reason: string }> {
	return new ORPCError("CONFLICT", { message, data: { reason } });
}

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE), and INSTRUCTION_UPDATE
 * asserted in the handler (the move configures the sync and carries the
 * published version into a repository).
 */
export const migrateRepositorySyncProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/repository-sync/migrate",
		tags: ["Projects", "Instructions"],
		summary: "Move uploaded coding instructions into a repository",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			repositoryIntegrationId: z.string().min(1),
			ref: instructionSyncRefSchema,
			rootPath: z.string().max(MAX_INSTRUCTION_SYNC_ROOT_PATH_LENGTH),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.INSTRUCTION_UPDATE,
		);
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const tenant = { projectId: input.projectId, organizationId };
		const rootPath = normalizeRootPath(input.rootPath);
		if (rootPath === null) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The folder must be a relative path inside the repository.",
				data: { code: "INVALID_ROOT_PATH" },
			});
		}

		const settings = await getProjectInstructionSettings(
			input.projectId,
			organizationId,
		);
		if (settings.migration) {
			throw await migrationOpenError(settings.migration, tenant);
		}
		if (settings.sourceOfTruth === "REPOSITORY") {
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"This project's coding instructions already come from a repository.",
				data: { reason: "NOT_UPLOAD_SOURCED" },
			});
		}
		const published = await getPublishedInstructionSnapshot(
			input.projectId,
		);
		if (
			!published ||
			published.organizationId !== organizationId ||
			published.status !== "READY"
		) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"This project has no published coding instructions to move yet.",
				data: { reason: "NOTHING_PUBLISHED" },
			});
		}
		const files = await listInstructionFiles(published.id, organizationId);
		if (files.length === 0) {
			throw new ORPCError("NOT_FOUND", {
				message:
					"This project has no published coding instructions to move yet.",
				data: { reason: "NOTHING_PUBLISHED" },
			});
		}

		const integration = await loadInstructionSyncIntegration({
			repositoryIntegrationId: input.repositoryIntegrationId,
			projectId: input.projectId,
		});
		const { token, refreshFault } = await resolveInstructionSyncCredential(
			integration,
			{ userId: context.user.id, organizationId },
		);
		const repository = {
			provider: integration.provider,
			token,
			repositoryUrl: integration.repositoryUrl,
			owner: integration.repositoryOwner,
			repo: integration.repositoryName,
			azureOrganization: integration.azureOrganization,
			...(integration.provider === "GITLAB" &&
			integration.authMethod === "PAT"
				? { gitlabAuth: "private-token" as const }
				: {}),
		};
		const outcome = await verifyRepositoryBranch({
			...repository,
			branch: input.ref,
		});
		if (outcome !== "exists") {
			throw repositoryReadError(outcome, {
				ref: input.ref,
				refreshFault,
				unreachableMessage:
					"Couldn't reach the repository to check the branch. Try again.",
			});
		}
		// The branch's newest commit (the whole repository's history, not the
		// folder's): the one the move's commit is built on.
		const history = await listRepositoryCommits({
			...repository,
			branch: input.ref,
			path: "",
			page: 1,
		});
		if (!history.ok) {
			throw repositoryReadError(history.outcome, {
				ref: input.ref,
				refreshFault,
				unreachableMessage:
					"Couldn't reach the repository to read the branch. Try again.",
			});
		}
		const tip = history.commits[0]?.sha;
		if (tip === undefined) {
			throw repositoryReadError("not-found", {
				ref: input.ref,
				refreshFault,
				unreachableMessage:
					"Couldn't reach the repository to read the branch. Try again.",
			});
		}
		if (isRepositoryTreeProvider(integration.provider)) {
			const tree = await listRepositoryTree({
				...repository,
				provider: integration.provider,
				branch: input.ref,
			});
			if (!tree.ok && tree.outcome !== "unsupported") {
				throw repositoryReadError(tree.outcome, {
					ref: input.ref,
					refreshFault,
					unreachableMessage:
						"Couldn't reach the repository to list its folders. Try again.",
				});
			}
			if (
				tree.ok &&
				folderIsNotEmpty({
					rootPath,
					tipFiles: tree.entries
						.filter((entry) => entry.type === "file")
						.map((entry) => entry.path),
					publishedPaths: files.map((file) => file.path),
				})
			) {
				throw conflict(
					"FOLDER_NOT_EMPTY",
					rootPath === ""
						? "The repository already has files where these instructions would go. Choose an empty folder."
						: `The folder "${rootPath}" already has files on "${input.ref}". Choose an empty folder.`,
				);
			}
		}

		const started = await startInstructionMigration({
			...tenant,
			userId: context.user.id,
			repositoryIntegrationId: integration.id,
			ref: input.ref,
			rootPath,
		});
		if (!started.ok) {
			switch (started.reason) {
				case "project_not_found":
					throw new ORPCError("NOT_FOUND", {
						message: "Project not found",
					});
				case "migration_open":
					throw conflict(
						"MIGRATION_OPEN",
						"A move of this project's coding instructions into a repository is already open.",
					);
				case "not_upload_sourced":
					throw new ORPCError("PRECONDITION_FAILED", {
						message:
							"This project's coding instructions already come from a repository.",
						data: { reason: "NOT_UPLOAD_SOURCED" },
					});
				case "nothing_published":
					throw new ORPCError("NOT_FOUND", {
						message:
							"This project has no published coding instructions to move yet.",
						data: { reason: "NOTHING_PUBLISHED" },
					});
				case "sync_exists":
					throw conflict(
						"SYNC_CONFIGURED",
						"This project already has a repository sync configuration. Switch to upload mode first.",
					);
				default: {
					const unreachable: never = started.reason;
					return unreachable;
				}
			}
		}
		const syncId = started.sync.id;
		let snapshotId: string | null = null;
		try {
			const admission = await admitInstructionProposal({
				...tenant,
				userId: context.user.id,
				mode: "migration",
				baseCommitSha: tip,
				proposerName: context.user.name,
				fileCount: files.length,
			});
			if (admission.destination !== "REPOSITORY") {
				throw new Error(
					"A move was admitted somewhere other than a repository",
				);
			}
			if (admission.blocked) {
				return commitTextRefused("ATTRIBUTION_REJECTED");
			}
			const created = await createDerivedInstructionSnapshot({
				...tenant,
				userId: context.user.id,
				baseSnapshotId: started.publishedSnapshotId,
				publishOnReady: false,
				proposal: true,
				migration: true,
				changes: [],
				limits: {
					maxFiles: SNAPSHOT_LIMITS.maxFiles,
					maxTotalBytes: SNAPSHOT_LIMITS.maxTotalBytes,
				},
				baseKeyPrefix: snapshotPrefix(
					input.projectId,
					started.publishedSnapshotId,
				),
				note: admission.note,
				destination: repositoryDestination(
					admission,
					uploadStartedAuditTemplate(context, {
						organizationId,
						projectId: input.projectId,
						baseSnapshotId: started.publishedSnapshotId,
						baseVersion: published.version,
						putCount: files.length,
						deleteCount: 0,
						via: "migration",
					}),
				),
			});
			if (!created.ok) {
				if (created.reason === "duplicate_proposal") {
					throw conflict(
						"MIGRATION_OPEN",
						"A move of this project's coding instructions into a repository is already open.",
					);
				}
				throw derivedSnapshotRefusal(created.reason, created.detail);
			}
			snapshotId = created.id;
			if (
				!(await attachInstructionMigrationProposal({
					...tenant,
					syncId,
					snapshotId,
				}))
			) {
				throw conflict(
					"MIGRATION_CANCELED",
					"The move was canceled while it was being prepared.",
				);
			}
			const branchId = await startMoveBranch({
				...tenant,
				syncId,
				snapshotId,
			});
			await finalizeInstructionSnapshot({
				snapshot: { id: snapshotId, status: "RECEIVING" },
				...tenant,
				userId: context.user.id,
			});
			recordAuditFromRequest(context, {
				action: "project.instructions.repository_migration_started",
				category: "project",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "project_instruction_repository_sync",
					id: syncId,
					name: `${integration.repositoryOwner}/${integration.repositoryName}`,
				},
				metadata: {
					provider: integration.provider,
					ref: input.ref,
					folder: rootPath,
					fileCount: files.length,
					snapshotId,
					branchId,
				},
			});
			return {
				state: "PROPOSING" as const,
				branchId,
				snapshotId,
			};
		} catch (error) {
			await closeOutFailedStart({ ...tenant, syncId, snapshotId });
			throw error;
		}
	});

/**
 * Joins the member's accepting branch with the move's proposal, records the
 * branch on the pointer and wakes the branch's workflow (the member branch
 * start, `startAdmittedBranchProposal`, which does not say which branch it
 * joined). A proposal the join leaves unjoined is the sweeper's to attach, and
 * the answer's `branchId` is then null.
 */
async function startMoveBranch(i: {
	projectId: string;
	organizationId: string;
	syncId: string;
	snapshotId: string;
}): Promise<string | null> {
	try {
		const joined = await joinProposalBranch({
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
			naming: proposalBranchNaming,
		});
		if (joined.kind !== "joined" && joined.kind !== "already") {
			return null;
		}
		await attachInstructionMigrationProposal({
			projectId: i.projectId,
			organizationId: i.organizationId,
			syncId: i.syncId,
			branchId: joined.branchId,
		});
		await wakeProposalBranchWorkflow({
			branchId: joined.branchId,
			projectId: i.projectId,
			organizationId: i.organizationId,
			correlation: true,
		});
		return joined.branchId;
	} catch (error) {
		console.error(
			"[instructions] could not join or wake the branch of a move into the repository; the sweeper will attach it",
			{ snapshotId: i.snapshotId },
			error,
		);
		return null;
	}
}

/**
 * A start that failed after the move opened: the proposal row, if it was
 * created, is closed out the way an inline submit's compensation does, and the
 * move ends (`start_failed`, no audit row: it never opened). Best effort and
 * unable to mask the real failure; what it cannot finish, the pointer's own
 * cancel can.
 */
async function closeOutFailedStart(i: {
	projectId: string;
	organizationId: string;
	syncId: string;
	snapshotId: string | null;
}): Promise<void> {
	try {
		if (i.snapshotId !== null) {
			await rejectAbandonedInstructionSnapshot({
				snapshotId: i.snapshotId,
				projectId: i.projectId,
				organizationId: i.organizationId,
				source: "migration_start_failed",
			});
		}
		await abandonInstructionMigration({
			projectId: i.projectId,
			organizationId: i.organizationId,
			syncId: i.syncId,
			reason: "start_failed",
		});
	} catch (error) {
		console.error(
			"[instructions] could not close out a move that failed to start",
			error,
		);
	}
}
