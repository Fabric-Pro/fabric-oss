import { describe, expect, it, vi } from "vitest";

const { createGatewayMock, evaluationModelMock } = vi.hoisted(() => {
	const evaluationModel = vi.fn((modelId: string) => ({
		modelId,
		provider: "gateway-evaluation",
	}));
	return {
		createGatewayMock: vi.fn(() => ({ evaluationModel })),
		evaluationModelMock: evaluationModel,
	};
});

vi.mock("ai", async () => {
	const actual = await vi.importActual<typeof import("ai")>("ai");
	return { ...actual, createGateway: createGatewayMock };
});

type EvaluationModelFactory = (
	modelId: string,
	context: {
		apiKey: string;
		provider: "VERCEL_GATEWAY";
		headers?: Record<string, string>;
	},
) => unknown;

describe("getEvaluationModel", () => {
	it("constructs Jev through the tenant Vercel Gateway evaluation factory", async () => {
		const modelFactory = (await import(
			"../model-factory"
		)) as typeof import("../model-factory") & {
			getEvaluationModel?: EvaluationModelFactory;
		};

		expect(modelFactory.getEvaluationModel).toBeTypeOf("function");
		const model = modelFactory.getEvaluationModel?.("typesafe-ai/jev", {
			apiKey: "vck_example_tenant_key",
			provider: "VERCEL_GATEWAY",
			headers: { "x-vercel-ai-gateway-user": "example-org" },
		});

		expect(evaluationModelMock).toHaveBeenCalledWith("typesafe-ai/jev");
		expect(model).toEqual({
			modelId: "typesafe-ai/jev",
			provider: "gateway-evaluation",
		});
	});
});
