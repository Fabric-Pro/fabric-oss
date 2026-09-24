/**
 * One default Fabric AI model (Fizzy #2040, F20). Every code-level "nobody
 * picked a model" fallback reads DEFAULT_FABRIC_AI_MODEL, and the seeded task
 * defaults put it on every provider that carries it — so changing the default
 * is one edit, and no surface is left on an older model by accident.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_FABRIC_AI_MODEL,
	DEFAULT_MODELS,
	MODELS,
	TASK_DEFAULTS,
} from "../prisma/ai-model-catalog";

const PROVIDERS_CARRYING_IT = [
	"ANTHROPIC_DIRECT",
	"VERCEL_GATEWAY",
	"DATABRICKS",
] as const;

describe("DEFAULT_FABRIC_AI_MODEL", () => {
	it("is Claude Sonnet 5, an active catalog entry", () => {
		expect(DEFAULT_FABRIC_AI_MODEL).toBe("claude-sonnet-5");
		const entry = MODELS.find(
			(m) => m.canonicalName === DEFAULT_FABRIC_AI_MODEL,
		);
		expect(entry).toBeDefined();
		expect(entry?.suitableForTasks).toContain("CHAT");
		const providers = entry?.providerMappings.map((m) => m.provider);
		for (const provider of PROVIDERS_CARRYING_IT) {
			expect(providers).toContain(provider);
		}
	});

	it("backs the code defaults for chat, complex and tool-calling work", () => {
		expect(DEFAULT_MODELS.CHAT).toBe(DEFAULT_FABRIC_AI_MODEL);
		expect(DEFAULT_MODELS.COMPLEX).toBe(DEFAULT_FABRIC_AI_MODEL);
		expect(DEFAULT_MODELS.TOOL_CALLING).toBe(DEFAULT_FABRIC_AI_MODEL);
	});

	it.each(["CHAT", "COMPLEX", "TOOL_CALLING"] as const)(
		"is the %s task default on every provider that carries it",
		(taskType) => {
			for (const provider of PROVIDERS_CARRYING_IT) {
				const row = TASK_DEFAULTS.find(
					(d) => d.taskType === taskType && d.provider === provider,
				);
				expect(row?.canonicalName, `${taskType}/${provider}`).toBe(
					DEFAULT_FABRIC_AI_MODEL,
				);
			}
		},
	);
});

// Seeded templates carry no suggested model, so an agent without a pin runs on
// its tenant's task default (above). A suggested id is sent to the provider
// raw and fails on one without a mapping for it; the seed must also clear the
// value earlier seeds wrote, which only an explicit null does.
describe("seeded agent templates", () => {
	const seed = readFileSync(
		join(__dirname, "../prisma/seed-agent-templates.ts"),
		"utf8",
	);

	it("suggest no model", () => {
		const assignments = seed.match(/suggestedModel:[^\n]*/g) ?? [];
		expect(assignments).toEqual([
			"suggestedModel: template.suggestedModel ?? null,",
			"suggestedModel: template.suggestedModel ?? null,",
		]);
	});
});
