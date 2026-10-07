/** Character offsets stay stable across transports, including non-BMP text. */
export function instructionTextPage(
	text: string,
	offset: number,
	maxLength: number,
) {
	const characters = Array.from(text);
	const end = offset + maxLength;
	return {
		body: characters.slice(offset, end).join(""),
		offset,
		nextOffset: end < characters.length ? end : null,
		truncated: end < characters.length,
	};
}
