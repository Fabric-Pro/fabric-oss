import { describe, expect, it } from "vitest";
import { MODELS } from "../../../../../packages/database/prisma/ai-model-catalog";
import { anthropicTemperature } from "@/lib/anthropic-model-constraints";
import {
	AVAILABLE_MODELS,
	DEFAULT_ANTHROPIC_MODEL_NAME,
	DEFAULT_MODEL,
	getAnthropicModelName,
} from "@/lib/constants";

// The standalone runtime keeps a copy; these tests compare its provider IDs
// with the platform catalog.
describe("data-analyst default model", () => {
	it("defaults to Claude Sonnet 5.5", () => {
		expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-5.5");
		expect(DEFAULT_ANTHROPIC_MODEL_NAME).toBe("claude-sonnet-5-5");
	});

	it("offers the default in the picker", () => {
		expect(AVAILABLE_MODELS.map((m) => m.id)).toContain(DEFAULT_MODEL);
	});
});

// The standalone constraint copy must recognize the picker IDs, including dots.
it.each(["opus", "sonnet", "haiku"])(
	"omits temperature for Claude %s 5.5",
	(family) => {
		expect(
			anthropicTemperature(`anthropic/claude-${family}-5.5`, 0.4),
		).toEqual({});
	},
);

it.each(["opus", "sonnet", "haiku"])(
	"maps the %s 5.5 picker ID to the catalog direct ID",
	(family) => {
		const entry = MODELS.find(
			(model) => model.canonicalName === `claude-${family}-5-5`,
		);
		const gateway = entry?.providerMappings.find(
			(mapping) => mapping.provider === "VERCEL_GATEWAY",
		);
		const direct = entry?.providerMappings.find(
			(mapping) => mapping.provider === "ANTHROPIC_DIRECT",
		);
		expect(getAnthropicModelName(gateway?.providerModelId)).toBe(
			direct?.providerModelId,
		);
		expect(getAnthropicModelName(gateway?.providerModelId)).toBe(
			`claude-${family}-5-5`,
		);
	},
);
it.each([
	"claude-opus-4-5-20251101",
	"claude-sonnet-5",
	"claude-sonnet-4-5-20250929",
	"claude-haiku-4-5-20251001",
])("keeps the older direct ID %s", (name) => {
	expect(getAnthropicModelName(`anthropic/${name}`)).toBe(name);
});
