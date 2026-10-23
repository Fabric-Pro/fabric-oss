import { describe, expect, it } from "vitest";
import {
	MODEL_ALIASES,
	MODELS,
	TASK_DEFAULTS,
} from "../prisma/ai-model-catalog";

const textTasks = [
	"SIMPLE",
	"COMPLEX",
	"REASONING",
	"CHAT",
	"TOOL_CALLING",
	"EVAL",
] as const;
// A misplaced template edit fails the slot assertion; absent mappings, retirement
// or incompatible capabilities fail the same test against the real catalog.
describe("new connection task templates", () => {
	for (const provider of [
		"ANTHROPIC_DIRECT",
		"VERCEL_GATEWAY",
		"OPENAI_DIRECT",
		"DATABRICKS",
		"XAI",
	] as const) {
		const tasks =
			provider === "DATABRICKS"
				? (["COMPLEX", "CHAT", "TOOL_CALLING"] as const)
				: provider === "XAI"
					? (["COMPLEX"] as const)
					: textTasks;
		it.each(tasks)(
			`${provider}/%s has an active suitable model and provider mapping`,
			(taskType) => {
				const expected =
					provider === "OPENAI_DIRECT"
						? taskType === "SIMPLE"
							? "gpt-6-luna"
							: "gpt-6.1-sol"
						: provider === "XAI"
							? "grok-4-1-fast"
							: taskType === "SIMPLE"
								? "claude-haiku-5-5"
								: taskType === "REASONING"
									? "claude-opus-5-5"
									: "claude-sonnet-5-5";
				expect(
					TASK_DEFAULTS.find(
						(row) =>
							row.provider === provider &&
							row.taskType === taskType,
					)?.canonicalName,
				).toBe(expected);
				const model = MODELS.find(
					(row) => row.canonicalName === expected,
				);
				expect(model?.deprecation).toBeUndefined();
				expect(model?.suitableForTasks).toContain(taskType);
				expect(
					model?.providerMappings.some(
						(mapping) => mapping.provider === provider,
					),
				).toBe(true);
			},
		);
	}
	it.each([
		["AZURE_AI_FOUNDRY", "CHAT", "gpt-5.5"],
		["GROQ", "COMPLEX", "llama-3-3-70b"],
		["CEREBRAS", "SIMPLE", "llama-3-1-8b"],
		["DATABRICKS", "SIMPLE", "llama-3-3-70b"],
		["OPENAI_DIRECT", "IMAGE", "dall-e-3"],
		["OPENAI_DIRECT", "EMBEDDING", "text-embedding-3-small"],
		["VERCEL_GATEWAY", "DECISION", "gpt-6-luna-decisions"],
		["GROQ", "AUDIO", "whisper-1"],
	])("retains %s/%s", (provider, taskType, expected) => {
		expect(
			TASK_DEFAULTS.find(
				(row) => row.provider === provider && row.taskType === taskType,
			)?.canonicalName,
		).toBe(expected);
	});
	it.each(["claude", "claude-3", "claude-3.5", "claude-sonnet"])(
		"maps %s to Sonnet 5.5",
		(alias) => {
			expect(MODEL_ALIASES[alias]).toBe("claude-sonnet-5-5");
		},
	);
	it("maps the Opus and Haiku aliases", () => {
		expect(MODEL_ALIASES["claude-opus"]).toBe("claude-opus-5-5");
		expect(MODEL_ALIASES["claude-haiku"]).toBe("claude-haiku-5-5");
	});
});
