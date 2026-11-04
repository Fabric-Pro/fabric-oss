function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/** A binding identifies scope; it never grants project access or enables a tool. */
export function readAgentProjectBinding(
	customInstructions: unknown,
	toolConnections: unknown,
): string | undefined {
	const selected = object(customInstructions).projectId;
	const legacy = object(object(toolConnections)["project-context"]).projectId;
	for (const value of [selected, legacy]) {
		if (
			value !== undefined &&
			value !== null &&
			(typeof value !== "string" || !value.trim() || value.length > 200)
		) {
			throw new Error("Invalid agent project binding");
		}
	}
	if (selected === null && typeof legacy === "string") {
		throw new Error("Conflicting cleared agent project binding");
	}
	if (
		typeof selected === "string" &&
		typeof legacy === "string" &&
		selected !== legacy
	) {
		throw new Error("Conflicting agent project bindings");
	}
	return typeof selected === "string"
		? selected
		: typeof legacy === "string"
			? legacy
			: undefined;
}
