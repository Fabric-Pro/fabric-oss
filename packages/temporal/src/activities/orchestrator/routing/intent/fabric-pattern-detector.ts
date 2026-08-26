/**
 * Fabric Pattern Detector
 *
 * Detects the appropriate Fabric AI pattern based on user message.
 * Maps common user intents to Fabric patterns.
 */

/**
 * Detects the appropriate Fabric pattern based on user message.
 * @param message User's message
 * @returns Fabric pattern name or empty string for transcript only
 */
export function detectFabricPattern(message: string): string {
	const messageLower = message.toLowerCase();

	// Summary patterns
	if (
		messageLower.includes("summarize") ||
		messageLower.includes("summary") ||
		messageLower.includes("tldr")
	) {
		return "summarize";
	}

	// Wisdom/insight extraction
	if (
		messageLower.includes("wisdom") ||
		messageLower.includes("insight") ||
		messageLower.includes("key points") ||
		messageLower.includes("takeaway")
	) {
		return "extract_wisdom";
	}

	// Analysis patterns
	if (messageLower.includes("analyze") || messageLower.includes("analysis")) {
		return "analyze_claims";
	}

	// Transcript only (no processing)
	if (
		messageLower.includes("transcript") &&
		!messageLower.includes("summarize")
	) {
		return ""; // Empty pattern = just transcript
	}

	// Default to summarize for YouTube videos
	return "summarize";
}
