/**
 * `text` cut to at most `max` UTF-16 code units, never between the two halves
 * of a surrogate pair: when the last kept unit would be a high surrogate, it
 * goes too. Text that already fits is returned as is.
 */
export function cutAtCodeUnits(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const code = text.charCodeAt(max - 1);
	const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
	return text.slice(0, end);
}

/** Cut at a code-point boundary and replace pre-existing lone surrogates. */
export function truncateWellFormed(text: string, max = text.length): string {
	// Node 22 supplies the method; the package type library predates ES2024.
	return (
		cutAtCodeUnits(text, max) as string & { toWellFormed(): string }
	).toWellFormed();
}
