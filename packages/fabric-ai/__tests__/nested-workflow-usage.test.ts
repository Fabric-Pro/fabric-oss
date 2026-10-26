import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	generate: vi.fn(),
	stream: vi.fn(),
	send: vi.fn(),
	providerConfig: vi.fn(),
}));
vi.mock("@repo/ai", async () => ({
	...(await vi.importActual<typeof import("@repo/ai/lib/databricks-url")>(
		"@repo/ai/lib/databricks-url",
	)),
	getAIModelWithMetadata: mocks.resolve,
	getSystemRAGProviderConfig: mocks.providerConfig,
	logModelUsageAsync: () => undefined,
}));
vi.mock("ai", () => ({
	generateText: mocks.generate,
	streamText: mocks.stream,
}));
vi.mock("../client", () => ({
	createFabricClient: () => ({
		getPattern: async () => "Summarize the input",
		getBaseUrl: () => "https://fabric.example.com",
		getApiKey: () => undefined,
	}),
}));

import {
	executePatternDelegated,
	executePatternDelegatedStream,
} from "../delegated-executor";
import {
	executePatternHybrid,
	executePatternHybridStream,
	type UserContext,
} from "../hybrid-executor";

const origin = {
	projectId: "project-example",
	frameId: "frame-example",
	workflowExecutionId: "execution-example",
};
const modes = [
	"hybrid",
	"hybrid-stream",
	"delegated",
	"delegated-stream",
] as const;

async function run(mode: (typeof modes)[number], userContext: UserContext) {
	const options = {
		input: "Story requirements",
		pattern: "summarize" as const,
		userContext,
	};
	if (mode === "hybrid") {
		return executePatternHybrid(options);
	}
	if (mode === "delegated") {
		return executePatternDelegated(options);
	}
	const events = [];
	const stream =
		mode === "hybrid-stream"
			? executePatternHybridStream(options)
			: executePatternDelegatedStream(options);
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.providerConfig.mockResolvedValue({
		apiKey: "key-example",
		provider: "OPENAI_DIRECT",
	});
	mocks.resolve.mockResolvedValue({
		model: {},
		metadata: { provider: "OPENAI_DIRECT", modelString: "example-model" },
		trackUsage: vi.fn(),
	});
	mocks.generate.mockResolvedValue({
		text: "Summary",
		usage: { inputTokens: 2, outputTokens: 1 },
	});
	mocks.stream.mockImplementation(() => ({
		textStream: (async function* () {
			yield "Summary";
		})(),
		usage: Promise.resolve({ inputTokens: 2, outputTokens: 1 }),
	}));
	mocks.send.mockImplementation(
		async () => new Response('{"type":"content","content":"Summary"}\n'),
	);
	vi.stubGlobal("fetch", mocks.send);
});
afterEach(() => vi.unstubAllGlobals());

describe("nested workflow analysis usage", () => {
	it.each(modes)(
		"carries origins to the actual %s model resolver",
		async (mode) => {
			await run(mode, {
				userId: "user-example",
				organizationId: "org-example",
				...origin,
			});
			expect(mocks.resolve).toHaveBeenCalledOnce();
			expect(mocks.resolve.mock.calls[0][1]).toMatchObject(origin);
			expect(mocks.resolve.mock.calls[0][0]).toEqual({
				taskType: "SIMPLE",
			});
			if (mode.startsWith("delegated")) {
				expect(mocks.resolve.mock.calls[0][1].excludeChatGptPlan).toBe(
					true,
				);
				expect(mocks.send).toHaveBeenCalledOnce();
				const request = JSON.parse(mocks.send.mock.calls[0][1].body);
				expect(request).toMatchObject({
					temperature: 0.7,
					prompts: [
						{
							userInput: "Story requirements",
							patternName: "summarize",
							vendor: "openai",
							model: "example-model",
						},
					],
				});
				for (const value of Object.values(origin)) {
					expect(mocks.send.mock.calls[0][1].body).not.toContain(
						value,
					);
				}
			} else {
				const request =
					mode === "hybrid" ? mocks.generate : mocks.stream;
				expect(request).toHaveBeenCalledExactlyOnceWith({
					model: {},
					instructions: "Summarize the input",
					prompt: "Story requirements",
					temperature: 0.7,
				});
				expect(mocks.send).not.toHaveBeenCalled();
			}
		},
	);

	it.each(modes)("keeps absent origins absent for %s", async (mode) => {
		await run(mode, {
			userId: "user-example",
			organizationId: "org-example",
		});
		const resolver = mocks.resolve.mock.calls[0][1];
		for (const field of ["frameId", "workflowExecutionId", "projectId"]) {
			expect(resolver).not.toHaveProperty(field);
		}
	});
});

describe("delegated Databricks URL routing", () => {
	it.each([
		["delegated", "system.ai.claude-sonnet-5", "ai-gateway/mlflow/v1"],
		["delegated", "custom-chat", "serving-endpoints"],
		[
			"delegated-stream",
			"system.ai.claude-sonnet-5",
			"ai-gateway/mlflow/v1",
		],
		["delegated-stream", "custom-chat", "serving-endpoints"],
	] as const)("%s routes %s to %s", async (mode, modelId, path) => {
		mocks.providerConfig.mockResolvedValue({
			apiKey: "key-example",
			provider: "DATABRICKS",
			baseUrl: "https://example.cloud.databricks.com",
		});
		mocks.resolve.mockResolvedValue({
			model: {},
			metadata: { provider: "DATABRICKS", modelString: modelId },
			trackUsage: vi.fn(),
		});
		await run(mode, {
			userId: "user-example",
			organizationId: "org-example",
		});
		const request = JSON.parse(mocks.send.mock.calls[0][1].body);
		expect(request.credentials).toMatchObject({
			model: modelId,
			baseUrl: `https://example.cloud.databricks.com/${path}`,
		});
	});
});
