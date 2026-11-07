import { describe, expect, it } from "vitest";
import { frameDesignInstructions } from "../../../../lib/frame-design-instructions";
import { buildIterationSystemPrompt } from "../system-prompt";

describe("artifact instructions in model requests", () => {
	it.each([false, true])(
		"keeps artifact guidance in the stable prefix and variable tenant data separate (cache=%s)",
		(promptCacheTarget) => {
			const artifactInstructions = frameDesignInstructions([
				"fabric_update_frame",
			]);
			const result = buildIterationSystemPrompt({
				systemPrompt: "persona\n\nexample-org",
				systemPromptParts: {
					reusable: "persona",
					variable: "example-org",
				},
				skillsSystemBlock: "available skills",
				artifactInstructions,
				promptCacheTarget,
			});
			expect(result.reusable).toBe(
				`persona\n\navailable skills\n\n${artifactInstructions}`,
			);
			expect(result.reusable).not.toContain("example-org");
			expect(result.instructions).toEqual([
				expect.objectContaining({
					role: "system",
					content: result.reusable,
				}),
				{ role: "system", content: "example-org" },
			]);
		},
	);
	it("includes the same guidance in the legacy request and leaves tool-free requests unchanged", () => {
		const artifactInstructions = frameDesignInstructions([
			"fabric_create_frame",
		]);
		expect(
			buildIterationSystemPrompt({
				systemPrompt: "persona",
				skillsSystemBlock: "",
				artifactInstructions,
				promptCacheTarget: false,
			}).instructions,
		).toBe(`persona\n\n${artifactInstructions}`);
		expect(
			buildIterationSystemPrompt({
				systemPrompt: "persona",
				skillsSystemBlock: "",
				promptCacheTarget: false,
			}).instructions,
		).toBe("persona");
	});
});
