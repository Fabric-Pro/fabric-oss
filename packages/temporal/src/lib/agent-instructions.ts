/** Compose instruction text without execution capabilities, model resolution or I/O. */
export function buildAgentInstructions(
	template: {
		displayName: string;
		description: string;
		instructions: string | null;
	},
	instance: {
		customInstructions: Record<string, unknown> | null;
		description: string | null;
	},
): string {
	const parts: string[] = [];

	// Start with agent identity
	parts.push(`# ${template.displayName}`);
	parts.push(template.description);

	// Add reusable template instructions
	if (template.instructions?.trim()) {
		parts.push(template.instructions.trim());
	}

	// Apply custom instructions (user overrides)
	if (instance.customInstructions) {
		const custom = instance.customInstructions;

		if (custom.role) {
			parts.push(`## Custom Role Instructions\n${custom.role}`);
		}

		if (custom.additionalContext) {
			parts.push(`## Additional Context\n${custom.additionalContext}`);
		}

		if (custom.constraints) {
			parts.push(`## Constraints\n${custom.constraints}`);
		}
	}

	// Add instance-specific description if provided
	if (instance.description) {
		parts.push(`## Instance Notes\n${instance.description}`);
	}
	return parts.join("\n\n");
}
