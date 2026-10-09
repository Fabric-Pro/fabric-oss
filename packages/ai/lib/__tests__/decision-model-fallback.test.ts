import { describe, expect, it, vi } from "vitest";
import {
	getDecisionModelFallbacks,
	withGatewayDecisionFallbacks,
} from "../decision-model-fallback";

const CALL = {
	state: "example state",
	questions: {
		kind: {
			type: "boolean" as const,
			instructions: "Is it?",
		},
	},
};

function fakeModel() {
	const doDecide = vi.fn().mockResolvedValue({ answers: {}, warnings: [] });
	return {
		doDecide,
		model: {
			specificationVersion: "v4" as const,
			provider: "gateway",
			modelId: "openai/gpt-6-luna-decisions",
			supportedQuestionTypes: ["boolean" as const],
			doDecide,
		},
	};
}

describe("getDecisionModelFallbacks", () => {
	it("offers Jev only for Luna reached through the system default", () => {
		expect(
			getDecisionModelFallbacks({
				selectionSource: "system_default",
				canonicalName: "gpt-6-luna-decisions",
			}).map((fallback) => fallback.providerModelId),
		).toEqual(["typesafe-ai/jev"]);
		expect(
			getDecisionModelFallbacks({
				selectionSource: "org_override",
				canonicalName: "gpt-6-luna-decisions",
			}),
		).toEqual([]);
		expect(
			getDecisionModelFallbacks({
				selectionSource: "system_default",
				canonicalName: "typesafe-ai-jev",
			}),
		).toEqual([]);
	});
});

describe("withGatewayDecisionFallbacks", () => {
	const fallbacks = [
		{
			providerModelId: "typesafe-ai/jev",
			canonicalName: "typesafe-ai-jev",
		},
	];

	it("keeps the caller's other gateway options when adding the fallback list", async () => {
		const { model, doDecide } = fakeModel();
		const wrapped = withGatewayDecisionFallbacks(model as any, fallbacks);

		await wrapped.doDecide({
			...CALL,
			providerOptions: {
				gateway: { tags: ["example"] },
				other: { flag: true },
			},
		} as any);

		expect(doDecide.mock.calls[0][0].providerOptions).toEqual({
			gateway: { tags: ["example"], models: ["typesafe-ai/jev"] },
			other: { flag: true },
		});
		expect(wrapped.modelId).toBe("openai/gpt-6-luna-decisions");
	});

	it("leaves a caller's own models list unchanged", async () => {
		const { model, doDecide } = fakeModel();
		const wrapped = withGatewayDecisionFallbacks(model as any, fallbacks);

		await wrapped.doDecide({
			...CALL,
			providerOptions: { gateway: { models: ["example/other"] } },
		} as any);

		expect(doDecide.mock.calls[0][0].providerOptions).toEqual({
			gateway: { models: ["example/other"] },
		});
	});

	it("returns the model untouched when there is no fallback", () => {
		const { model } = fakeModel();
		expect(withGatewayDecisionFallbacks(model as any, [])).toBe(model);
	});
});
