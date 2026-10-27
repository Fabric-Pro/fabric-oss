import { cacheableSystem } from "@repo/ai/prompt-cache";
import type { SystemModelMessage } from "ai";

/** Assemble instructions after history cache-marker cleanup, which only sees messages. */
export function buildIterationSystemPrompt(input: {
	systemPrompt: string;
	systemPromptParts?: { reusable: string; variable: string };
	skillsSystemBlock: string;
	promptCacheTarget: boolean;
}): {
	instructions: string | SystemModelMessage | SystemModelMessage[];
	reusable?: string;
} {
	const withSkills = (text: string) =>
		input.skillsSystemBlock
			? `${text}\n\n${input.skillsSystemBlock}`
			: text;
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
