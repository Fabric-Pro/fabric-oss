import type { GithubItem } from "@repo/database";

/**
 * Workflow-safe (type-only import) replication of the daily-brief release split.
 * PRs targeting `production` are wrapper merges; the shipped features are the
 * staging PRs merged at/before the latest prod merge in the window.
 */
export function splitReleasePrs(mergedGithub: GithubItem[]): {
	prodPrs: GithubItem[];
	stagingPrs: GithubItem[];
} {
	const occurredAtMs = (g: GithubItem) =>
		g.occurredAt instanceof Date
			? g.occurredAt.getTime()
			: new Date(g.occurredAt).getTime();

	let latestProdTime: number | undefined;
	const stagingMerged: GithubItem[] = [];
	for (const g of mergedGithub) {
		if (g.baseRef === "production") {
			const t = occurredAtMs(g);
			if (latestProdTime === undefined || t > latestProdTime) {
				latestProdTime = t;
			}
		} else {
			stagingMerged.push(g);
		}
	}

	const prodPrs: GithubItem[] = [];
	const stagingPrs: GithubItem[] = [];
	if (latestProdTime === undefined) {
		stagingPrs.push(...stagingMerged);
	} else {
		for (const s of stagingMerged) {
			(occurredAtMs(s) <= latestProdTime ? prodPrs : stagingPrs).push(s);
		}
	}
	return { prodPrs, stagingPrs };
}
