/** Match the saved agent's inherited instruction source without creating a duplicate override. */
export function agentInstructionFormState(
	templateInstructions: string | null | undefined,
	customInstructions: Record<string, unknown> | null | undefined,
) {
	const custom = customInstructions ?? {};
	const override = [custom.additionalContext, custom.role].find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
	const inherited = templateInstructions ?? "";
	return {
		instructions: override ?? inherited,
		instructionsInherited:
			override === undefined && inherited.trim().length > 0,
	};
}
