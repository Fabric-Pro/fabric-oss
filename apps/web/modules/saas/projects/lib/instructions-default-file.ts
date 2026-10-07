/**
 * The file the tab opens on when nothing is selected: the root `CLAUDE.md`,
 * else the root `AGENTS.md`, else none. A file of the same name inside a folder
 * is not the project's entry point and is not chosen.
 */
export const DEFAULT_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

export function defaultSelectedPath(
	files: ReadonlyArray<{ path: string }>,
): string | null {
	const paths = new Set(files.map((file) => file.path));
	return DEFAULT_FILES.find((candidate) => paths.has(candidate)) ?? null;
}
