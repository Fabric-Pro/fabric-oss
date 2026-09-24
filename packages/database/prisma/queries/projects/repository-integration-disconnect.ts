/**
 * The repository-integration disconnect (design 2026-09-23 §5.1): every sync
 * that reads from a `ProjectRepositoryIntegration` is released in the SAME
 * transaction as the integration delete — the coding-instructions sync
 * (Fizzy #2538) and the Living Memory sync (Fizzy #2657) — so a project is
 * never left configured against an integration that no longer exists.
 *
 * Lock order: the project row first, then the Living Memory configuration
 * row (lock 1 of `./context-repository-sync`). The project lock is
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`, on purpose: a sync run holds lock 1
 * while it inserts rows carrying a project foreign key (its receipt, every
 * synced `ProjectContext`), and each such insert takes `FOR KEY SHARE` on the
 * project row. `FOR UPDATE` here would conflict with that and close a cycle
 * (run holds lock 1 and waits for the project; disconnect holds the project
 * and waits for lock 1) that Postgres would break with `40P01` on every
 * disconnect during an apply batch. `FOR NO KEY UPDATE` does not conflict
 * with `FOR KEY SHARE`, so the run's inserts proceed and no cycle forms. It
 * still conflicts with the `FOR UPDATE` a concurrent coding-instructions
 * `configure` takes on the same row, which is what this lock is for.
 */

import { db } from "../../client";
import { releaseInstructionRepositorySyncForIntegration } from "../instruction-repository-sync";
import {
	CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS,
	type ReleasedContextRepositorySync,
	releaseContextRepositorySyncForIntegration,
} from "./context-repository-sync";

export interface DeleteRepoIntegrationReleasingSyncsResult {
	deletedIntegration: boolean;
	/** The coding-instructions sync released, flipping the project to UPLOAD. */
	releasedInstructionSync: { organizationId: string } | null;
	/** The Living Memory sync released, its managed rows kept as synced files. */
	releasedContextSync: ReleasedContextRepositorySync | null;
}

export async function deleteRepoIntegrationReleasingSyncs(input: {
	integrationId: string;
	projectId: string;
}): Promise<DeleteRepoIntegrationReleasingSyncsResult> {
	return db.$transaction(
		async (tx) => {
			// Lock first, so a concurrent coding-instructions `configure`
			// cannot attach the integration between the reads below and the
			// delete. NO KEY: see the header for why not `FOR UPDATE`.
			await tx.$queryRaw`
				SELECT "id" FROM "project" WHERE "id" = ${input.projectId} FOR NO KEY UPDATE
			`;
			const releasedInstructionSync =
				await releaseInstructionRepositorySyncForIntegration(tx, input);
			const releasedContextSync =
				await releaseContextRepositorySyncForIntegration(tx, input);
			const { count } = await tx.projectRepositoryIntegration.deleteMany({
				where: { id: input.integrationId, projectId: input.projectId },
			});
			return {
				deletedIntegration: count > 0,
				releasedInstructionSync,
				releasedContextSync,
			};
		},
		{ timeout: CONTEXT_SYNC_TRANSACTION_TIMEOUT_MS },
	);
}
