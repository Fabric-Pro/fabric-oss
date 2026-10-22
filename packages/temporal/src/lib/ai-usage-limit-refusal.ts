/** Match the payments refusal format, also parsed by the stream route extractor. */
export function isUsageLimitRefusalText(message: unknown): boolean {
	return (
		typeof message === "string" &&
		/AI usage limit exceeded:\s+([\w-]+)\s+\((TOKENS|SPEND_USD),\s+(HOURLY|DAILY|WEEKLY|MONTHLY)\)\s+—\s+used\s+(\d+)\s+of\s+(\d+)/.test(
			message,
		)
	);
}
