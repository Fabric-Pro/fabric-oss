/**
 * A Mermaid diagram's header line (Fizzy #2946), on its own so that the
 * theme tokens, which client components import, read it without the
 * Markdown parser `visual-identity.ts` brings in. Pure string work.
 */

/**
 * A diagram's header: its first line, trimmed, that is neither blank nor a
 * `%%` comment (so a marker line is skipped); null when there is none.
 */
export function diagramHeaderLine(source: string): string | null {
	for (const line of source.split(/\r\n?|\n/)) {
		const trimmed = line.trim();
		if (trimmed !== "" && !trimmed.startsWith("%%")) {
			return trimmed;
		}
	}
	return null;
}
