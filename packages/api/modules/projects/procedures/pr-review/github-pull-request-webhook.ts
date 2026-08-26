/**
 * What every pull-request webhook delivery has in common.
 *
 * This module used to hold a SHARED endpoint as well: one deployment-wide
 * `GITHUB_WEBHOOK_SECRET`, and a handler that resolved the repository URL out of
 * the payload to whichever projects had connected it. That endpoint is gone, and
 * the reason is worth writing down because it is not obvious and the feature was
 * already rebuilt once.
 *
 * The setup instructions gave that one secret to every customer admin who
 * connected a repository, so a signed delivery proved only that SOMEBODY holding
 * the deployment secret sent it — while the repository URL inside it was chosen
 * by whoever sent it. Anyone who had ever set the feature up could therefore
 * hand-craft a delivery naming another tenant's repository and have Fabric read
 * that tenant's source, spend their model credits, and write a comment into their
 * pull request under their own credential.
 *
 * A guard was tried first: refuse when the named repository resolves to more than
 * one tenant. It cut the blast radius from every tenant to one and could do no
 * better, because a shared secret cannot identify a sender at all. So the
 * endpoint is retired rather than guarded, and `project-pull-request-webhook`
 * replaces it — the project is named in the URL and the secret is that project's
 * own, so whose delivery this is never has to be inferred from attacker-chosen
 * content.
 */

/** What a webhook endpoint answers with. Never a stack trace, never a token. */
export interface PullRequestWebhookResult {
	status: number;
	handled: boolean;
	reason?: string;
	/** How many projects a handled delivery started a review for. */
	projects?: number;
}

/**
 * The actions worth a review.
 *
 * `opened` and `reopened` are obvious. `synchronize` is a new commit on the
 * branch, which is the case that matters most: a review of the first push is
 * stale the moment somebody addresses it, and the comment is edited in place
 * rather than repeated. Everything else GitHub sends about a pull request —
 * labels, assignees, milestones — changes no code.
 *
 * `ready_for_review` is the one that was missing, and its absence was silent: a
 * pull request opened as a draft is skipped by design, and GitHub sends no
 * `opened` or `synchronize` when the author later presses "Ready for review". So
 * draft → ready → merge got no review at all, ever — the workflow of anyone who
 * opens a draft first.
 */
export const REVIEWED_ACTIONS = new Set([
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
]);

/**
 * Every spelling of the repository URL worth trying, most specific first.
 *
 * `clone_url` carries a `.git` suffix and `html_url` does not; a project stored
 * whichever its connection flow produced, and the lookup is an exact match. So
 * both are tried, each with and without the suffix, before deciding the
 * repository is not connected.
 *
 * Still needed after the shared endpoint's removal: the per-project endpoint uses
 * it to confirm the delivery names a repository THAT project connected. The
 * difference is that a mismatch there is a refusal, rather than the start of a
 * search for somebody else who might own the repository.
 */
export function repositoryUrlCandidates(
	repository: { clone_url?: string; html_url?: string } | undefined,
): string[] {
	const seen = new Set<string>();
	for (const raw of [repository?.clone_url, repository?.html_url]) {
		const url = raw?.trim();
		if (!url) {
			continue;
		}
		const withoutSlash = url.replace(/\/+$/, "");
		seen.add(withoutSlash);
		seen.add(withoutSlash.replace(/\.git$/, ""));
		if (!withoutSlash.endsWith(".git")) {
			seen.add(`${withoutSlash}.git`);
		}
	}
	return [...seen];
}
