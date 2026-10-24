import { describe, expect, it, vi } from "vitest";

const { createGatewayMock, decisionModelMock } = vi.hoisted(() => {
	const decisionModel = vi.fn((modelId: string) => ({
		modelId,
		provider: "gateway-decision",
	}));
	return {
		createGatewayMock: vi.fn(() => ({ decisionModel })),
		decisionModelMock: decisionModel,
	};
});

vi.mock("ai", async () => {
	const actual = await vi.importActual<typeof import("ai")>("ai");
	return { ...actual, createGateway: createGatewayMock };
});

const createTypeSafeAiMock = vi.hoisted(() =>
	vi.fn<typeof import("@ai-sdk/typesafe-ai").createTypeSafeAi>(),
);
vi.mock("@ai-sdk/typesafe-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/typesafe-ai")>();
	createTypeSafeAiMock.mockImplementation(actual.createTypeSafeAi);
	return { ...actual, createTypeSafeAi: createTypeSafeAiMock };
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
	it("constructs Jev through the tenant Vercel Gateway decision-model factory", async () => {
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

		expect(decisionModelMock).toHaveBeenCalledWith("typesafe-ai/jev");
		expect(model).toEqual({
			modelId: "typesafe-ai/jev",
			provider: "gateway-decision",
		});
	});
});

it.each([
	"https://example.cloud.databricks.com",
	"https://example.cloud.databricks.com/serving-endpoints",
	"https://example.cloud.databricks.com/ai-gateway/mlflow/v1",
])("constructs System One from the workspace origin: %s", async (baseUrl) => {
	const { getEvaluationModel } = await import("../model-factory");
	const model = getEvaluationModel("system.ai.openjev-qwen35-4b", {
		provider: "DATABRICKS",
		apiKey: "example-token",
		baseUrl,
	});
	expect(createTypeSafeAiMock).toHaveBeenLastCalledWith({
		apiKey: "example-token",
		baseURL: "https://example.cloud.databricks.com/ai-gateway/typesafe/v1",
	});
	expect(model.modelId).toBe("system.ai.openjev-qwen35-4b");
});
it("rejects an unsupported evaluation provider", async () => {
	const { getEvaluationModel } = await import("../model-factory");
	// @ts-expect-error Exercise the runtime boundary with an unsupported provider.
	expect(() =>
		getEvaluationModel("example-model", {
			provider: "OPENAI_DIRECT",
			apiKey: "example-token",
		}),
	).toThrow(/require Vercel AI Gateway/);
});

it("adapts TypeSafe's newer question contract", async () => {
	const { getEvaluationModel } = await import("../model-factory");
	const model = getEvaluationModel("system.ai.openjev-qwen35-4b", {
		provider: "DATABRICKS",
		apiKey: "example-token",
		baseUrl: "https://example.cloud.databricks.com",
	});
	expect(model.supportedQuestionTypes).toEqual([
		"choice",
		"score",
		"boolean",
	]);
});

it.each([false, true])(
	"uses the real System One transport with the installed AI SDK (box response=%s)",
	async (boxResponse) => {
		const { createTypeSafeAi } = await vi.importActual<
			typeof import("@ai-sdk/typesafe-ai")
		>("@ai-sdk/typesafe-ai");
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						model: "databricks-openjev-qwen35-4b",
						answers: {
							accepted: boxResponse
								? {
										type: "box",
										box: {
											top: 0,
											bottom: 1,
											left: 0,
											right: 1,
										},
									}
								: { type: "noul", noul: 0.9 },
						},
						usage: { input_tokens: 173, output_tokens: 0 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		createTypeSafeAiMock.mockImplementationOnce((options) =>
			createTypeSafeAi({ ...options, fetch: fetchMock }),
		);
		const { getEvaluationModel } = await import("../model-factory");
		const { experimental_decide } = await import("ai");
		const model = getEvaluationModel("system.ai.openjev-qwen35-4b", {
			provider: "DATABRICKS",
			apiKey: "example-token",
			baseUrl: "https://example.cloud.databricks.com/serving-endpoints",
		});
		const pending = experimental_decide({
			model,
			state: "example state",
			questions: {
				accepted: {
					type: "boolean",
					instructions: "Is the state accepted?",
				},
			},
			maxRetries: 0,
		});
		if (boxResponse) {
			await expect(pending).rejects.toThrow("unsupported box answer");
		} else {
			const result = await pending;
			expect(result.answers.accepted).toMatchObject({
				type: "boolean",
				probability: 0.9,
			});
			expect(result.usage).toMatchObject({
				inputTokens: 173,
				outputTokens: 0,
			});
			expect(result.response.modelId).toBe(
				"databricks-openjev-qwen35-4b",
			);
		}
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, request] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe(
			"https://example.cloud.databricks.com/ai-gateway/typesafe/v1/systemone",
		);
		expect(new Headers(request.headers).get("authorization")).toBe(
			"Bearer example-token",
		);
		expect(JSON.parse(request.body as string)).toMatchObject({
			model: "system.ai.openjev-qwen35-4b",
			questions: { accepted: { type: "noul" } },
		});
	},
);
