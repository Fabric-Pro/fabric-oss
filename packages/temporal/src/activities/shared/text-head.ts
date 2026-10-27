/**
 * The start of `text` within `max` characters, cut at the last line break that
 * keeps at least half of them, otherwise at `max`.
 */
export function headAtLineBreak(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const head = text.slice(0, max);
	const lineBreak = head.lastIndexOf("\n");
	return (lineBreak > max / 2 ? head.slice(0, lineBreak) : head).trimEnd();
}
