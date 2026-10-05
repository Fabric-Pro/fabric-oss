import type { ExcludedPath } from "@repo/instructions";

export type LeftOutListing = {
	/** The version named its left-out files, so they can be shown. */
	listable: boolean;
	/** Fewer names are kept than files were left out. */
	partial: boolean;
};

/**
 * Whether the files a version left out can be listed. The count is the
 * authoritative number: a version made before the names were kept has none
 * beside a non-zero count and shows the count alone, and a pick that left out
 * more files than the cap keeps only the first ones.
 */
export function leftOutListing(
	excludedCount: number,
	names: readonly ExcludedPath[] | null | undefined,
): LeftOutListing {
	const listed = names?.length ?? 0;
	return {
		listable: excludedCount > 0 && listed > 0,
		partial: listed > 0 && listed < excludedCount,
	};
}
