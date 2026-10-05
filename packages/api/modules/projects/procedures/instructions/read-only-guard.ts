import { ORPCError } from "@orpc/client";
import { isProjectReadOnly } from "@repo/database";
import {
	READ_ONLY_MODE_ERROR_CODE,
	READ_ONLY_MODE_MESSAGE,
} from "@repo/utils/read-only-mode";

/**
 * Read-only mode's contract is "any write against a connected external
 * source": a commit or a revert on a repository-backed project's synced branch
 * is one, so it is refused at the door with the same typed error the PM-sync
 * push and the coding-run start give (`data.errorCode`
 * `PROJECT_READ_ONLY`, CONFLICT). The activity that does the push checks
 * again immediately before it writes, so a project switched to Read-only mode
 * after the request was accepted stops too.
 *
 * Called before anything else is read for the request: a refused write spends
 * no credential and asks the provider nothing.
 */
export async function assertRepositoryWritable(
	projectId: string,
): Promise<void> {
	if (await isProjectReadOnly(projectId)) {
		throw new ORPCError("CONFLICT", {
			message: READ_ONLY_MODE_MESSAGE,
			data: { errorCode: READ_ONLY_MODE_ERROR_CODE },
		});
	}
}
