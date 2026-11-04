/** The human-readable answer, never a tool payload, progress message or artifact. */
export function agentRunText(output: unknown): string {
	if (typeof output === "string") {
		return output;
	}
	if (!output || typeof output !== "object" || Array.isArray(output)) {
		return "";
	}
	const data = output as Record<string, unknown>;
	const answer = data.response ?? data.text ?? data.content;
	return typeof answer === "string" ? answer : "";
}
