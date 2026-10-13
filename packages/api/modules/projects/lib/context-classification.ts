/**
 * De-duplicating filenames inside a single batch ZIP. See spec §8.5 in
 * `docs/specs/2026-04-15-download-project-context-files/spec.md`. The download
 * class of a context lives in `@repo/utils/context-download-class`, shared with
 * the context list.
 */

/**
 * De-duplicate a filename within a single batch ZIP. Mutates the shared
 * `seen` map as a side-effect on its argument (the helper is pure with
 * respect to the module — state lives on the caller).
 *
 * Collision rules:
 * - First sighting: returned unchanged.
 * - Nth sighting: `{stem}-{n-1}{ext}`, where `stem`/`ext` are split on the
 *   last `.`. If there is no `.`, the suffix is appended bare.
 */
export function dedupeFilename(
	seen: Map<string, number>,
	name: string,
): string {
	const count = seen.get(name) ?? 0;
	seen.set(name, count + 1);
	if (count === 0) {
		return name;
	}
	const dot = name.lastIndexOf(".");
	const stem = dot === -1 ? name : name.slice(0, dot);
	const ext = dot === -1 ? "" : name.slice(dot);
	return `${stem}-${count}${ext}`;
}
