function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The prompt a template gives the reports made from it. */
export function templateUserPrompt(definition: unknown): string {
	return isJsonRecord(definition) && typeof definition.userPrompt === "string"
		? definition.userPrompt
		: "";
}

/**
 * The instructions a report runs with: the ones a person wrote for it
 * (`promptOverrideSource: "user"`), else its template's. An unmarked override
 * is a copy of an older template prompt, which a run does not add to its tasks.
 */
export function reportInstructions(instance: {
	connections: unknown;
	template: { definition: unknown };
}): { instructions: string; instructionsSource: "report" | "template" } {
	const connections = isJsonRecord(instance.connections)
		? instance.connections
		: {};
	const override =
		typeof connections.promptOverride === "string"
			? connections.promptOverride.trim()
			: "";
	return override && connections.promptOverrideSource === "user"
		? { instructions: override, instructionsSource: "report" }
		: {
				instructions: templateUserPrompt(instance.template.definition),
				instructionsSource: "template",
			};
}
