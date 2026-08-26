/**
 * Render one `diff` part as gutter-marked lines.
 *
 * `diffLines` hands back parts whose `value` spans several lines, so the marker
 * has to be applied per line rather than per part. Splitting on "\n" leaves an
 * empty trailing segment for any part that ends in a newline; that segment is
 * dropped so a part never renders a phantom gutter line after its last line.
 *
 * Shared by the Playwright script revision history and the prompt version
 * history — both show "selected revision vs current" as a plain <pre> diff.
 */
export function prefixDiffPart(part: {
	value: string;
	added?: boolean;
	removed?: boolean;
}): string {
	const marker = part.added ? "+ " : part.removed ? "- " : "  ";
	const lines = part.value.split("\n");
	return lines
		.map((line, index) => {
			const newline = index < lines.length - 1 ? "\n" : "";
			return line.length > 0 || newline
				? `${marker}${line}${newline}`
				: "";
		})
		.join("");
}
