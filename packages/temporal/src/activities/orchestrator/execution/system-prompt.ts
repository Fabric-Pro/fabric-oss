import { cacheableSystem } from "@repo/ai/prompt-cache";
import type { SystemModelMessage } from "ai";

/** Assemble instructions after history cache-marker cleanup, which only sees messages. */
export function buildIterationSystemPrompt(input: {
	systemPrompt: string;
	systemPromptParts?: { reusable: string; variable: string };
	skillsSystemBlock: string;
	artifactInstructions?: string;
	promptCacheTarget: boolean;
}): {
	instructions: string | SystemModelMessage | SystemModelMessage[];
	reusable?: string;
} {
	const additions = [input.skillsSystemBlock, input.artifactInstructions]
		.filter(Boolean)
		.join("\n\n");
	const withSkills = (text: string) =>
		additions ? `${text}\n\n${additions}` : text;
	if (!input.systemPromptParts) {
		const legacy = withSkills(input.systemPrompt);
		return {
			instructions: input.promptCacheTarget
				? cacheableSystem(legacy)
				: legacy,
		};
	}
	const reusable = withSkills(input.systemPromptParts.reusable);
	return {
		reusable,
		instructions: [
			input.promptCacheTarget
				? cacheableSystem(reusable)
				: { role: "system", content: reusable },
			{ role: "system", content: input.systemPromptParts.variable },
		],
	};
}
