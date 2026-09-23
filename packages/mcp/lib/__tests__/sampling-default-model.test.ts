/**
 * MCP sampling falls back to the default Fabric AI model (Fizzy #2040, F20)
 * when a server states no preference or asks for intelligence first — it used
 * to fall back to GPT-4o through a separate code constant.
 */
import { DEFAULT_FABRIC_AI_MODEL } from "@repo/database/prisma/ai-model-catalog";
import { describe, expect, it } from "vitest";
import { selectModelFromPreferences } from "../sampling";

describe("selectModelFromPreferences — defaults", () => {
	it("uses the default Fabric AI model without preferences", () => {
		expect(selectModelFromPreferences()).toBe(DEFAULT_FABRIC_AI_MODEL);
	});

	it("uses it when intelligence is the top priority", () => {
		expect(selectModelFromPreferences({ intelligencePriority: 1 })).toBe(
			DEFAULT_FABRIC_AI_MODEL,
		);
	});

	it("still honours an explicit default passed by the caller", () => {
		expect(selectModelFromPreferences(undefined, "gpt-4o")).toBe("gpt-4o");
	});
});
