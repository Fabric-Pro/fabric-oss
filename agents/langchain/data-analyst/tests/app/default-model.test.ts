import { describe, expect, it } from "vitest";
import {
	AVAILABLE_MODELS,
	DEFAULT_ANTHROPIC_MODEL_NAME,
	DEFAULT_MODEL,
} from "@/lib/constants";

// Kept in step with DEFAULT_FABRIC_AI_MODEL in the platform's model catalog
// (packages/database/prisma/ai-model-catalog.ts), which this app cannot import.
describe("data-analyst default model", () => {
	it("defaults to Claude Sonnet 5", () => {
		expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-5");
		expect(DEFAULT_ANTHROPIC_MODEL_NAME).toBe("claude-sonnet-5");
	});

	it("offers the default in the picker", () => {
		expect(AVAILABLE_MODELS.map((m) => m.id)).toContain(DEFAULT_MODEL);
	});
});
