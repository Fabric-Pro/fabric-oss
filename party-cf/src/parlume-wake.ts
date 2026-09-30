export function parseParlumeWake(text: string): string | null {
	const match =
		/\bhey[\s,]+(?:fabric(?:\s+parlume)?|parlume)\b[\s,.:;!?–—-]*/i.exec(
			text,
		);
	return match ? text.slice(match.index + match[0].length).trim() : null;
}
