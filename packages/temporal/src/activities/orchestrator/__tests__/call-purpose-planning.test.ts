import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	purposes: [] as (string | undefined)[],
	replies: [] as string[],
}));
vi.mock("@repo/ai", () => ({
	generateText: async ({ model }: { model: { purpose?: string } }) => {
		h.purposes.push(model.purpose);
		return { text: h.replies.shift() ?? "{}", steps: [] };
	},
	isStepCount: () => () => false,
}));
vi.mock("../utils/model-selector", () => {
	const model = (
		_user: string,
		_org: string,
		_tools: boolean,
		_override: unknown,
		_job: unknown,
		origin?: { callPurpose?: string },
	) => ({ purpose: origin?.callPurpose });
	return {
		getAiModel: model,
		getAiModelWithSelection: (...args: Parameters<typeof model>) => ({
			model: model(...args),
			provider: "VERCEL_GATEWAY",
			modelString: "example-model",
		}),
	};
});
vi.mock("../planning/plan-validator", () => ({
	validatePlan: async () => ({ isValid: true, issues: [] }),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../research/research-tools", () => ({
	buildResearchTools: async () => ({
		example_search: { execute: async () => "example notes" },
	}),
}));

import { analyzeContextRequirements } from "../context/analyze-requirements";
import { synthesizeContext } from "../context/synthesize-context";
import {
	analyzeJourneyInput,
	createJourneyState,
} from "../journey/journey-state-manager";
import { createMultiModelPlan } from "../planning/multi-model-planner";
import { analyzePlanModification } from "../planning/plan-adapter";
import { executeResearchAgent } from "../research/research-agent";

const actor = { userId: "example-user", organizationId: "example-org" };
beforeEach(() => {
	h.purposes.length = 0;
	h.replies.length = 0;
});

describe("Advisor optional planning and context calls", () => {
	it("distinguishes requirements analysis from context synthesis", async () => {
		await analyzeContextRequirements({
			...actor,
			message: "Summarize the notes",
			availableAgents: [],
			availableMcpTools: [],
		} as any);
		await synthesizeContext({
			...actor,
			originalTask: "Summarize the notes",
			researchResults: [],
			previousStepResults: [],
		} as any);
		expect(h.purposes).toEqual(["requirements", "context-synthesis"]);
	});

	it("distinguishes plan generation, critique and refinement", async () => {
		h.replies.push(
			JSON.stringify({ confidence: 0.5 }),
			JSON.stringify({
				approved: false,
				score: 0.5,
				issues: [
					{
						severity: "major",
						issue: "Add verification",
						impact: "Missing validation",
					},
				],
				suggestions: [],
			}),
			"{}",
		);
		await createMultiModelPlan({
			...actor,
			message: "Prepare an implementation plan",
			routingDecision: {
				riskLevel: "low",
				suggestedStrategy: "sequential",
				reasoning: "example",
			},
		} as any);
		expect(h.purposes).toEqual([
			"plan-generation",
			"plan-critique",
			"plan-refinement",
		]);
	});

	it("distinguishes plan adaptation from ambiguous journey input", async () => {
		const journey = createJourneyState({
			message: "Prepare a plan",
			...actor,
		} as any);
		await analyzePlanModification(
			"Add a step",
			{ steps: [] } as any,
			journey,
			actor.userId,
			actor.organizationId,
		);
		await analyzeJourneyInput(
			"Investigate deployment logs",
			journey,
			actor.userId,
			actor.organizationId,
		);
		expect(h.purposes).toEqual(["plan-adaptation", "journey"]);
	});

	it("labels research generations", async () => {
		await executeResearchAgent({
			...actor,
			researchQueries: ["example query"],
			originalTask: "Find notes",
			informationNeeds: [],
			availableTools: [],
			availableAgents: [],
		} as any);
		expect(h.purposes).toEqual(["research"]);
	});
});
