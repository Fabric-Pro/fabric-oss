/**
 * The freeze a move from uploads into the repository puts on a project's
 * coding instructions (Fizzy #2878 §9).
 *
 * While the move is open (`PROPOSING`, which covers the pull request being
 * opened, open, blocked or merged and not yet settled, and `SWITCHING`) the
 * published version is the one the pull request carries and the sync row it
 * will be read through is paused, so anything that changed either would make
 * the pull request wrong or the switch lie: an upload, an edit or a proposal
 * against the uploads, a publish or approval, a commit, new ignore rules, a
 * re-configure, switching back to upload mode, and a manual sync. Each is
 * refused with one answer, `CONFLICT` with `data.reason` `MIGRATION_OPEN`,
 * carrying the move's state and its pull request, so a client can say what to
 * wait for. The move ends by being merged and synced, canceled, or its pull
 * request being closed, and nothing here needs undoing: the pointer's
 * presence is the freeze.
 *
 * The refusal `assertNoOpenMigration` gives is a statement about the settings
 * row read for it, taken BEFORE the write it guards, so it is only the fast
 * answer. The writers that must not be raced decide the same thing again under
 * the project row's lock (`InstructionMigrationOpenError` from the settings and
 * configuration writers, a `migration_open` refusal from publish and approve),
 * and `withMigrationFreeze` and `migrationOpenFromRefusal` turn those into the
 * same `MIGRATION_OPEN` answer, so a move that started in between is refused
 * rather than overwritten.
 */
import { ORPCError } from "@orpc/client";
import {
	getMemberProposalBranch,
	getProjectInstructionSettings,
	InstructionMigrationOpenError,
	type InstructionMigrationPointer,
} from "@repo/database";

/** The move's pull request as an error shows it: where it is, when it has been opened. */
type MigrationPullRequest = { url: string; externalId: string } | null;

async function pullRequestOf(
	pointer: InstructionMigrationPointer,
	i: { projectId: string; organizationId: string },
): Promise<MigrationPullRequest> {
	if (pointer.branchId === null) {
		return null;
	}
	const branch = await getMemberProposalBranch({
		branchId: pointer.branchId,
		projectId: i.projectId,
		organizationId: i.organizationId,
	});
	return branch?.pullRequestUrl && branch.pullRequestExternalId
		? {
				url: branch.pullRequestUrl,
				externalId: branch.pullRequestExternalId,
			}
		: null;
}

/** The refusal for a project whose move is open. */
export async function migrationOpenError(
	pointer: InstructionMigrationPointer,
	i: { projectId: string; organizationId: string },
): Promise<
	ORPCError<
		"CONFLICT",
		{
			reason: "MIGRATION_OPEN";
			state: InstructionMigrationPointer["state"];
			pullRequest: MigrationPullRequest;
		}
	>
> {
	return new ORPCError("CONFLICT", {
		message:
			"This project's coding instructions are being moved into its repository. Changes are paused until that pull request is merged and synced, or canceled.",
		data: {
			reason: "MIGRATION_OPEN",
			state: pointer.state,
			pullRequest: await pullRequestOf(pointer, i),
		},
	});
}

/**
 * Runs a write whose database function decides the freeze under the project
 * lock, and answers the move's refusal (`InstructionMigrationOpenError`) as
 * `MIGRATION_OPEN`, the same answer `assertNoOpenMigration` gives before it.
 */
export async function withMigrationFreeze<T>(
	i: { projectId: string; organizationId: string },
	write: () => Promise<T>,
): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (error instanceof InstructionMigrationOpenError) {
			throw await migrationOpenError(error.pointer, i);
		}
		throw error;
	}
}

/**
 * The `MIGRATION_OPEN` answer for a publish or approval the database refused
 * as `migration_open`, which carries the pointer the lock found.
 */
export async function migrationOpenFromRefusal(
	refusal: { migration?: InstructionMigrationPointer },
	i: { projectId: string; organizationId: string },
): Promise<Awaited<ReturnType<typeof migrationOpenError>>> {
	const pointer =
		refusal.migration ??
		(await getProjectInstructionSettings(i.projectId, i.organizationId))
			.migration;
	if (!pointer) {
		// The refusal named a move that has ended since: nothing is open, and
		// the honest answer is to try again.
		throw new ORPCError("CONFLICT", {
			message:
				"A move of this project's coding instructions just ended. Try again.",
			data: { reason: "MIGRATION_CHANGED" },
		});
	}
	return migrationOpenError(pointer, i);
}

/**
 * Refuses (`MIGRATION_OPEN`) when `snapshotId` is the proposal of the move
 * that is open: deleting it would take the rows the move's pull request is
 * made of out from under its branch. Any other snapshot may still be deleted.
 */
export async function assertNotMigrationSnapshot(i: {
	projectId: string;
	organizationId: string;
	snapshotId: string;
}): Promise<void> {
	const settings = await getProjectInstructionSettings(
		i.projectId,
		i.organizationId,
	);
	if (settings.migration && settings.migration.snapshotId === i.snapshotId) {
		throw await migrationOpenError(settings.migration, i);
	}
}

/**
 * Refuses (`MIGRATION_OPEN`) when the project has a move open. `onlyWhile`
 * narrows it to one state: a manual sync is refused only while the move is
 * `PROPOSING` (its row is paused and the folder holds nothing yet), and is the
 * way to hurry a `SWITCHING` one along.
 */
export async function assertNoOpenMigration(
	i: { projectId: string; organizationId: string },
	options: { onlyWhile?: InstructionMigrationPointer["state"] } = {},
): Promise<void> {
	const settings = await getProjectInstructionSettings(
		i.projectId,
		i.organizationId,
	);
	if (
		settings.migration &&
		(options.onlyWhile === undefined ||
			settings.migration.state === options.onlyWhile)
	) {
		throw await migrationOpenError(settings.migration, i);
	}
}
