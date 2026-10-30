/**
 * The search shared by the instance-wide and per-organization flag panels.
 *
 * Filtered in the browser: both list procedures return every matching
 * registry entry in one response, so a server-side search would save nothing.
 */
type SearchableFlag = {
	key: string;
	label: string;
	description: string;
	envVar: string | null;
	note?: string | null;
};

/**
 * Case-insensitive match against everything a row shows, plus the key, so an
 * admin can find a flag by its name in code or in a deployment's environment.
 */
export function filterFlags<T extends SearchableFlag>(
	flags: readonly T[],
	searchTerm: string,
): readonly T[] {
	const term = searchTerm.trim().toLowerCase();
	if (!term) {
		return flags;
	}
	return flags.filter((flag) =>
		[flag.key, flag.label, flag.description, flag.envVar, flag.note].some(
			(value) => value?.toLowerCase().includes(term) ?? false,
		),
	);
}
