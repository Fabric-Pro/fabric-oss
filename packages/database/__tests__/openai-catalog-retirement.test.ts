import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODELS,
	getModelCapabilitiesFromCatalog,
	MODEL_ALIASES,
	MODELS,
	TASK_DEFAULTS,
} from "../prisma/ai-model-catalog";

const replacements: Record<string, string> = {
	"dall-e-3": "gpt-image-2.6-sunburst",
	"gpt-image-2": "gpt-image-2.6-sunburst",
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
			{ provider: "AZURE_AI_FOUNDRY", providerModelId: "gpt-6.1-sol" },
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

	it.each([
		["gpt-6.2-astra", 8, 40],
		["gpt-6.2-sol", 2, 10],
	] as const)(
		"catalogs %s with published limits, prices and routes",
		(id, input, output) => {
			const model = MODELS.find((m) => m.canonicalName === id);
			expect(model).toMatchObject({
				contextWindow: 1050000,
				maxOutputTokens: 128000,
				inputCostPer1M: input,
				outputCostPer1M: output,
			});
			expect(model?.providerMappings).toEqual([
				{ provider: "OPENAI_DIRECT", providerModelId: id },
				{ provider: "VERCEL_GATEWAY", providerModelId: `openai/${id}` },
				{ provider: "OPENROUTER", providerModelId: `openai/${id}` },
				{ provider: "AZURE_AI_FOUNDRY", providerModelId: id },
				{ provider: "OPENAI_CHATGPT_PLAN", providerModelId: id },
			]);
			for (const slug of [id, `openai/${id}`]) {
				expect(getModelCapabilitiesFromCatalog(slug)).toMatchObject({
					vision: true,
					reasoning: true,
					toolCalling: true,
				});
			}
		},
	);

	it("maps GPT-6.1 Terra to Azure AI Foundry", () => {
		expect(
			MODELS.find((m) => m.canonicalName === "gpt-6.1-terra")
				?.providerMappings,
		).toContainEqual({
			provider: "AZURE_AI_FOUNDRY",
			providerModelId: "gpt-6.1-terra",
		});
	});

	it("keeps Whisper active across providers and catalogs GPT-Transcribe", () => {
		const transcribe = MODELS.find(
			(m) => m.canonicalName === "gpt-transcribe",
		);
		expect(transcribe?.capabilities).toEqual(["AUDIO"]);
		expect(transcribe?.deprecation).toBeUndefined();
		expect(transcribe?.providerMappings).toEqual([
			{ provider: "OPENAI_DIRECT", providerModelId: "gpt-transcribe" },
			{
				provider: "VERCEL_GATEWAY",
				providerModelId: "openai/gpt-transcribe",
			},
		]);
		const whisper = MODELS.find((m) => m.canonicalName === "whisper-1");
		expect(whisper?.capabilities).toEqual(["AUDIO"]);
		expect(whisper?.deprecation).toBeUndefined();
		expect(whisper?.providerMappings).toEqual([
			{ provider: "OPENAI_DIRECT", providerModelId: "whisper-1" },
			{ provider: "VERCEL_GATEWAY", providerModelId: "openai/whisper-1" },
			{ provider: "GROQ", providerModelId: "whisper-large-v3" },
		]);
		expect(
			MODELS.find((m) => m.canonicalName === "whisper-large-v3"),
		).toBeUndefined();
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
				"gpt-image-2.6-sunburst",
				"gpt-transcribe",
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
