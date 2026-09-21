export type GitLabContainerOption = { fullName: string; name: string };

/**
 * Pick the default GitLab REST container for a project's PM settings.
 *
 * Priority:
 *   1. A previously saved container id that matches a fetched repo by
 *      `fullName` (owner/name path).
 *   2. The codebase repo's `owner/name` path that matches a fetched repo
 *      by `fullName`.
 *   3. null — the saved value (if numeric) won't match the REST list, and we
 *      don't have a codebase row to fall back to, so the user picks manually.
 *
 * The REST container list keys repos by `owner/name`, so a numeric saved id
 * (produced by `enableGitLabPMForProject`'s numeric-preferred resolver) will
 * miss in step 1 — step 2 covers the same project anyway because the codebase
 * row hands us the path directly.
 */
export function pickDefaultGitLabContainer(
	containers: GitLabContainerOption[],
	savedContainerId: string | null,
	codebaseFullName: string | null,
): string | null {
	if (savedContainerId) {
		const direct = containers.find((c) => c.fullName === savedContainerId);
		if (direct) {
			return direct.fullName;
		}
	}
	if (codebaseFullName) {
		const byPath = containers.find((c) => c.fullName === codebaseFullName);
		if (byPath) {
			return byPath.fullName;
		}
	}
	return null;
}

type GitLabRestRepo = { fullName: string; numericId?: number | null };
type GitLabRestContainerOption = { id: string; name: string; label?: string };

const NUMERIC_CONTAINER = /^[1-9]\d*$/;

/**
 * Build the GitLab REST picker's options (spec D1.1b, Fizzy #2304).
 *
 * The REST listing keys repos by `owner/name`, but the GitLab OAuth auto-wire
 * saves the NUMERIC project id — and a save that rewrote `'123'` to
 * `'group/project'` for the same project would read, server-side, as a
 * container change that switches the hourly poll off. So when
 * `keepSavedContainer` is set (the initial load of a project already on GitLab
 * REST):
 *   - the repo whose `numericId` equals a saved numeric container keeps that
 *     numeric value as its option id, so selecting it saves the value unchanged
 *     and every other repo saves its own path;
 *   - a saved numeric container the listing does not include (for example
 *     beyond its 100-repo page) stays selectable as an explicit "Current
 *     project" option instead of being replaced by another repo.
 *
 * `savedOptionId` is the option that represents the saved container, or null.
 * A re-pick of the tool may carry another tool's container, so it passes
 * `keepSavedContainer: false` and gets plain path options.
 */
export function buildGitLabRestContainerOptions(args: {
	repos: readonly GitLabRestRepo[];
	savedContainerId: string | null;
	savedContainerName: string | null;
	keepSavedContainer: boolean;
}): { options: GitLabRestContainerOption[]; savedOptionId: string | null } {
	const saved = args.keepSavedContainer ? args.savedContainerId : null;
	const numericSaved =
		saved !== null && NUMERIC_CONTAINER.test(saved) ? saved : null;
	const options: GitLabRestContainerOption[] = [];
	let savedOptionId: string | null = null;

	for (const repo of args.repos) {
		if (
			numericSaved !== null &&
			repo.numericId != null &&
			String(repo.numericId) === numericSaved
		) {
			options.push({ id: numericSaved, name: repo.fullName });
			savedOptionId = numericSaved;
			continue;
		}
		options.push({ id: repo.fullName, name: repo.fullName });
		if (saved !== null && repo.fullName === saved) {
			savedOptionId = saved;
		}
	}

	if (numericSaved !== null && savedOptionId === null) {
		const savedName = args.savedContainerName?.trim() || null;
		options.unshift({
			id: numericSaved,
			name: savedName ?? numericSaved,
			label: `Current project (${savedName ?? `GitLab project ${numericSaved}`})`,
		});
		savedOptionId = numericSaved;
	}

	return { options, savedOptionId };
}
