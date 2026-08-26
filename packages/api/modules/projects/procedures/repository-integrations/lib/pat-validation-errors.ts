/**
 * User-facing sentences for repo-scoped PAT validation failures, shared by the
 * connect path and the attach-PAT-to-existing-row path so both tell one story
 * about what a code host's answer meant (Fizzy #2252 AC3: the remedy must
 * match the cause).
 */

export function gitHubPatValidationMessage(status: number | undefined): string {
	switch (status) {
		case 401:
			return "GitHub rejected this token as invalid or expired — check the token and try again.";
		case 403:
			return "GitHub authenticated this token but refused this repository — it is missing read access (needs repo / Actions: read), or the app is not installed on it.";
		case 404:
			return "GitHub can't find this repository for this token — check the URL; a private repository also answers 404 when the token cannot see it.";
		default:
			return `GitHub returned status ${status}`;
	}
}

export function gitLabPatValidationMessage(status: number | undefined): string {
	return status === 401 || status === 403
		? "GitLab token can't read this repository. Use a token with the read_api scope (classic PAT) or the Project: Read + Pipeline: Read permissions (fine-grained PAT)."
		: `GitLab returned status ${status}`;
}
