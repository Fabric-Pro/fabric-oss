import { getProjectRepositoryBranch } from "@repo/database";

/**
 * The branch a coding run targets, for activities that build its prompt.
 *
 *  1. the run's own `targetBranch` (a task's choice, or what the start
 *     procedure resolved) always wins;
 *  2. for a run in a repository the input names, that repository's connected
 *     integration branch (its provider default unless someone chose another);
 *  3. otherwise the project's stored branch, then its first-connected
 *     repository's branch;
 *  4. "main", only when none of these is known.
 *
 * Activity code: reads the database, never called from a workflow.
 */
export async function resolveRunTargetBranch(input: {
	projectId: string;
	targetBranch?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	projectDefaultBranch?: string | null;
}): Promise<string> {
	if (input.targetBranch) {
		return input.targetBranch;
	}
	const repository =
		input.repositoryOwner && input.repositoryName
			? { owner: input.repositoryOwner, name: input.repositoryName }
			: null;
	if (repository) {
		const branch = await getProjectRepositoryBranch(
			input.projectId,
			repository,
		);
		if (branch) {
			return branch;
		}
	}
	return (
		input.projectDefaultBranch ||
		(await getProjectRepositoryBranch(input.projectId)) ||
		"main"
	);
}
