/**
 * Pure release-note exclusion filtering for the Daily Brief workflow.
 *
 * Runtime-dependency-free (the only import is type-only, erased at compile) so
 * the sandboxed workflow can import it without pulling in non-deterministic
 * APIs (no `new Date()`, no `Math.random()`, no I/O).
 */
import type { GithubItem } from "@repo/database";

export type ReleaseNoteExclusion = {
	kind: "pr" | "story";
	repoFullName: string | null;
	prNumber: number | null;
	storyIdentifier: string | null;
};

const STORY_ID_RE = /\b([A-Z]+-\d+)\b/;

/** Extracts the effective PR keys and story ids from an exclusion set — rows with a
 *  malformed/unknown kind (missing `repoFullName`/`prNumber`/`storyIdentifier`) are
 *  dropped. Shared by `filterExcludedMergedPrs` and `exclusionSignature` so the two
 *  can never drift: a row only affects the signature if it also affects filtering. */
function effectiveExclusionKeys(exclusions: ReleaseNoteExclusion[]): {
	prKeys: Set<string>;
	storyIds: Set<string>;
} {
	const prKeys = new Set<string>();
	const storyIds = new Set<string>();
	for (const e of exclusions) {
		if (e.kind === "pr" && e.repoFullName && e.prNumber != null) {
			prKeys.add(`${e.repoFullName}#${e.prNumber}`);
		} else if (e.kind === "story" && e.storyIdentifier) {
			storyIds.add(e.storyIdentifier);
		}
	}
	return { prKeys, storyIds };
}

export function filterExcludedMergedPrs(
	github: GithubItem[],
	exclusions: ReleaseNoteExclusion[],
): GithubItem[] {
	if (exclusions.length === 0) {
		return github;
	}
	const { prKeys, storyIds } = effectiveExclusionKeys(exclusions);
	const isExcluded = (pr: GithubItem): boolean => {
		if (pr.baseRef === "production") {
			return false; // release-anchor invariant
		}
		if (prKeys.has(`${pr.repoFullName}#${pr.prNumber}`)) {
			return true;
		}
		const m = pr.title.match(STORY_ID_RE);
		return m != null && storyIds.has(m[1]);
	};
	return github.filter((g) => g.kind !== "pr_merged" || !isExcluded(g));
}

/** Order-independent signature of an exclusion set — used by the workflow to detect
 *  whether the set changed mid-generation (freshness/convergence guarantee). */
export function exclusionSignature(exclusions: ReleaseNoteExclusion[]): string {
	const { prKeys, storyIds } = effectiveExclusionKeys(exclusions);
	return [
		...[...prKeys].map((k) => `pr:${k}`),
		...[...storyIds].map((s) => `story:${s}`),
	]
		.sort()
		.join("|");
}
