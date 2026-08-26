/**
 * Pure PR-author coordinate map for the publishing-suggestion workflow.
 *
 * Runtime-dependency-free (NO imports at all) so the sandboxed workflow can
 * import it without pulling in non-deterministic APIs (no `new Date()`, no
 * `Math.random()`, no I/O) — exactly like `daily-brief-release-note-exclusions`.
 *
 * The daily-brief collector normalizes GitHub, GitLab AND ADO pull requests
 * into one `pullRequests` array, but ONLY GitHub items carry `authorGithubId`.
 * `GithubItem` has no provider discriminator, so a `repoFullName#prNumber`
 * coordinate cannot be provider-qualified: a project with a GitHub `acme/app#17`
 * AND a GitLab/ADO `acme/app#17` collides on one key. Crediting the GitHub
 * author to a topic that actually cites the NON-GitHub PR would attribute it to
 * the wrong real person.
 *
 * So this map is FAIL-CLOSED on an ambiguous coordinate (mirrors the resolver's
 * FR-A6 fail-closed discipline): a coordinate is credited ONLY when
 *   (a) exactly ONE distinct `authorGithubId` value appears at it, AND
 *   (b) NO item at that coordinate lacks `authorGithubId`.
 * Otherwise the key is dropped entirely (credit nobody).
 *
 * A single GitHub PR legitimately emits several items across `kind`s
 * (pr_opened/pr_merged/…) all carrying the SAME `authorGithubId` — that is NOT
 * a collision and stays credited.
 *
 * Deterministic (insertion-ordered `Map`/`Record`, one value per key ever set)
 * → replay-safe, and it adds no workflow command.
 */
export function buildPrAuthorGithubIdByPr(
	pullRequests: ReadonlyArray<{
		repoFullName: string;
		prNumber: number;
		authorGithubId?: string;
	}>,
): Record<string, string> {
	// Per coordinate: the set of distinct PRESENT author ids, plus whether any
	// item at that coordinate lacked an id (an id-less, non-GitHub PR).
	const idsByKey = new Map<string, Set<string>>();
	const sawIdlessByKey = new Set<string>();
	for (const pr of pullRequests) {
		const key = `${pr.repoFullName}#${pr.prNumber}`;
		if (pr.authorGithubId != null) {
			let ids = idsByKey.get(key);
			if (!ids) {
				ids = new Set<string>();
				idsByKey.set(key, ids);
			}
			ids.add(pr.authorGithubId);
		} else {
			sawIdlessByKey.add(key);
		}
	}

	const map: Record<string, string> = {};
	for (const [key, ids] of idsByKey) {
		// Credit iff exactly one distinct id AND no id-less item at the key.
		if (ids.size === 1 && !sawIdlessByKey.has(key)) {
			for (const id of ids) {
				map[key] = id;
			}
		}
	}
	return map;
}
