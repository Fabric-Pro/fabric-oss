/**
 * Builds a system prompt from an agent template instance and its parent template.
 * Extracted from fabric-ai page.tsx for reuse in CopilotPage and other surfaces.
 */
export function buildInstanceSystemPrompt(
	agentInstance: {
		customInstructions?: unknown;
		goal?: string | null;
		description?: string | null;
		memoryFiles?: Array<{ path: string; content: string }>;
	},
	agentTemplate?: {
		instructions?: string | null;
		description?: string | null;
	},
): string | undefined {
	const parts: string[] = [];

	// 1. Start with template instructions
	if (agentTemplate?.instructions?.trim()) {
		parts.push(agentTemplate.instructions.trim());
	} else if (agentTemplate?.description) {
		parts.push(agentTemplate.description);
	}

	// 2. Add instance-specific customizations
	const customInstructions = agentInstance.customInstructions as {
		role?: string;
		additionalContext?: string;
		constraints?: string;
	} | null;

	if (customInstructions) {
		if (customInstructions.role) {
			parts.push(
				`## Custom Role Instructions\n${customInstructions.role}`,
			);
		}
		if (customInstructions.additionalContext) {
			parts.push(
				`## Additional Context\n${customInstructions.additionalContext}`,
			);
		}
		if (customInstructions.constraints) {
			parts.push(`## Constraints\n${customInstructions.constraints}`);
		}
	}

	// 3. Add instance goal if configured
	if (agentInstance.goal) {
		parts.push(`## Goal\n${agentInstance.goal}`);
	}

	// 4. Add instance description/notes
	if (agentInstance.description) {
		parts.push(`## Instance Notes\n${agentInstance.description}`);
	}

	// 5. Add loaded skills from memoryFiles
	if (agentInstance.memoryFiles && agentInstance.memoryFiles.length > 0) {
		const skillParts: string[] = [
			"## Loaded Skills\nYou have the following skills loaded. When the user's request matches a skill's purpose, you MUST follow that skill's instructions exactly, including its output format (e.g., generating HTML pages, diagrams, etc.).",
		];
		for (const skill of agentInstance.memoryFiles) {
			const skillName = skill.path
				.replace("skills/", "")
				.replace("/SKILL.md", "");
			skillParts.push(`### Skill: ${skillName}\n${skill.content}`);
		}
		parts.push(skillParts.join("\n\n"));
	}

	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
