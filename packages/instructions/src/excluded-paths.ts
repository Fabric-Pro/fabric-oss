/**
 * The files a version left out, kept at ingest so the Coding Instructions tab
 * can list them beside the count and name the rule that excluded each one.
 *
 * `excludedCount` on the snapshot stays the authoritative number: a pick can
 * leave out far more files than are worth storing a name for (a `node_modules/`
 * tree), so the list stops at `MAX_EXCLUDED_PATHS` and a reader compares its
 * length with the count to know whether it is whole.
 */
import { z } from "zod";

export const MAX_EXCLUDED_PATHS = 500;

export const excludedPathSchema = z.object({
	path: z.string().min(1).max(4096),
	rule: z.string().max(1024),
});

export type ExcludedPath = z.infer<typeof excludedPathSchema>;

/**
 * The lists joined in order, one entry per path (the first wins) and no more
 * than `MAX_EXCLUDED_PATHS` in all. Order is kept so what the server judged
 * comes before what a client reported.
 */
export function mergeExcludedPaths(
	...lists: ReadonlyArray<readonly ExcludedPath[] | undefined>
): ExcludedPath[] {
	const merged: ExcludedPath[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		for (const entry of list ?? []) {
			if (merged.length >= MAX_EXCLUDED_PATHS) {
				return merged;
			}
			if (seen.has(entry.path)) {
				continue;
			}
			seen.add(entry.path);
			merged.push({ path: entry.path, rule: entry.rule });
		}
	}
	return merged;
}
