/** Display name for a retrieved project source, in prompt precedence order. */
export function projectContextSourceName(
	context: {
		sourcePath?: string;
		filename?: string;
		sourceTitle?: string;
		sourceUrl?: string;
	},
	index: number,
): string {
	return (
		context.sourcePath ||
		context.filename ||
		context.sourceTitle ||
		context.sourceUrl ||
		`Context ${index + 1}`
	);
}
