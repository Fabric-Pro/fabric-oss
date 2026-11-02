const CONTROL_TAGS = ["instructions", "metadata", "tools"] as const;

/** Keep execution payloads in history, but project only assistant prose into the bubble. */
export function sidekickDisplayText(text: string): string {
	const openings = /<sidekick_apply_(instructions|metadata|tools)>/g;
	let visible = "";
	let cursor = 0;
	for (const match of text.matchAll(openings)) {
		if (match.index < cursor) {
			continue;
		}
		visible += text.slice(cursor, match.index);
		const closing = `</sidekick_apply_${match[1]}>`;
		const end = text.indexOf(closing, match.index + match[0].length);
		if (end < 0) {
			return visible;
		}
		cursor = end + closing.length;
	}
	visible += text.slice(cursor);
	const tail = visible.lastIndexOf("<sidekick_");
	if (
		tail >= 0 &&
		CONTROL_TAGS.some((tag) =>
			`<sidekick_apply_${tag}>`.startsWith(visible.slice(tail)),
		)
	) {
		return visible.slice(0, tail);
	}
	return visible;
}
