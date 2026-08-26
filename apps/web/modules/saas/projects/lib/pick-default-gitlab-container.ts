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
