import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODELS,
	getModelCapabilitiesFromCatalog,
	MODEL_ALIASES,
	MODELS,
	TASK_DEFAULTS,
} from "../prisma/ai-model-catalog";

const replacements: Record<string, string> = {
	"gpt-4o": "gpt-5.5",
	"gpt-4o-mini": "gpt-5.5",
	"gpt-5-nano": "gpt-5.5",
	"gpt-5-mini": "gpt-5.5",
	"gpt-5-2": "gpt-5.5",
	"gpt-5.4": "gpt-5.5",
	"gpt-4.1-mini": "gpt-5.5",
	"gpt-4-turbo": "gpt-5.5",
	o1: "gpt-5.5",
	"o1-mini": "gpt-5.5",
	"o3-mini": "gpt-5.5",
};

describe("OpenAI catalog retirement", () => {
	it("catalogs GPT-6.1 Sol with its published limits and pricing", () => {
		const model = MODELS.find((m) => m.canonicalName === "gpt-6.1-sol");
		expect(model).toMatchObject({
			displayName: "GPT-6.1 Sol",
			contextWindow: 1050000,
			maxOutputTokens: 128000,
			inputCostPer1M: 2,
			outputCostPer1M: 10,
		});
		expect(model?.deprecation).toBeUndefined();
		expect(model?.providerMappings).toEqual([
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-6.1-sol" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-6.1-sol",
			},
			{ provider: "OPENROUTER", providerModelId: "openai/gpt-6.1-sol" },
			// ChatGPT plans serve it too, and it is their default (Fizzy #2770).
			{ provider: "OPENAI_CHATGPT_PLAN", providerModelId: "gpt-6.1-sol" },
		]);
		for (const id of ["gpt-6.1-sol", "openai/gpt-6.1-sol"]) {
			expect(getModelCapabilitiesFromCatalog(id)).toMatchObject({
				vision: true,
				reasoning: true,
				toolCalling: true,
			});
		}
	});

	it.each(Object.entries(replacements))(
		"retains %s and resolves it directly to active %s on every existing provider",
		(name, replacementName) => {
			const model = MODELS.find((m) => m.canonicalName === name);
			const replacement = MODELS.find(
				(m) => m.canonicalName === replacementName,
			);
			expect(model?.deprecation?.replacedBy).toBe(replacementName);
			expect(replacement).toBeDefined();
			expect(replacement?.deprecation).toBeUndefined();
			for (const mapping of model?.providerMappings ?? []) {
				expect(
					replacement?.providerMappings.map((m) => m.provider),
				).toContain(mapping.provider);
			}
		},
	);

	it("keeps GPT-5.5, GPT-6, OSS and specialized OpenAI models active", () => {
		const retained = MODELS.filter(
			(m) => m.vendor === "OpenAI" && !(m.canonicalName in replacements),
		);
		expect(retained.map((m) => m.canonicalName)).toEqual(
			expect.arrayContaining([
				"gpt-5.5",
				"gpt-6-sol",
				"gpt-6-astra",
				"gpt-6-luna",
				"gpt-oss-120b",
				"gpt-oss-20b",
				"text-embedding-3-small",
				"dall-e-3",
				"whisper-1",
			]),
		);
		for (const model of retained) {
			expect(model.deprecation, model.canonicalName).toBeUndefined();
		}
	});

	it("redirects legacy sampling aliases to active models", () => {
		for (const name of Object.values(MODEL_ALIASES)) {
			expect(name in replacements, name).toBe(false);
		}
		for (const key of [
			"gpt-4",
			"gpt-4o",
			"gpt-4o-mini",
			"gpt-5",
			"gpt-5.2",
			"gpt-5-nano",
			"gpt-5-mini",
			"o1",
			"o1-mini",
			"o3-mini",
		]) {
			expect(MODEL_ALIASES[key], key).toBe("gpt-5.5");
		}
	});

	it("never assigns a retired OpenAI model as a task or code default", () => {
		for (const name of Object.values(DEFAULT_MODELS)) {
			expect(name in replacements, name).toBe(false);
		}
		for (const row of TASK_DEFAULTS) {
			expect(
				row.canonicalName in replacements,
				`${row.provider}/${row.taskType}`,
			).toBe(false);
			const model = MODELS.find(
				(m) => m.canonicalName === row.canonicalName,
			);
			expect(model?.providerMappings.map((m) => m.provider)).toContain(
				row.provider,
			);
		}
	});
});
