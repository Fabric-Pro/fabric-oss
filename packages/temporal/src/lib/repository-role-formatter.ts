/**
 * Formats connected repositories and their role tags for system prompt injection.
 */

import type { ProjectRepositoryRole } from "@repo/database";

export function formatRepositoryRoleMap(
	repos: ProjectRepositoryRole[],
): string {
	if (repos.length === 0) {
		return "";
	}
	const hasTags = repos.some((r) => r.roleTag);
	if (!hasTags) {
		return `Repositories: ${repos.map((r) => r.url).join(", ")}`;
	}
	const lines = repos.map((r) =>
		r.roleTag ? `- ${r.url} [Role: ${r.roleTag}]` : `- ${r.url}`,
	);
	return `Repositories:\n${lines.join("\n")}`;
}
