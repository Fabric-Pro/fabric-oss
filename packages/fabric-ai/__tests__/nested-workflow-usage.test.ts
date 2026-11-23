import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	generate: vi.fn(),
	stream: vi.fn(),
	send: vi.fn(),
	providerConfig: vi.fn(),
	systemProviderConfig: vi.fn(),
}));
vi.mock("@repo/ai", async () => ({
	...(await vi.importActual<typeof import("@repo/ai/lib/databricks-url")>(
		"@repo/ai/lib/databricks-url",
	)),
	getAIModelWithMetadata: mocks.resolve,
	getRAGProviderConfigForModel: mocks.providerConfig,
	getSystemRAGProviderConfig: mocks.systemProviderConfig,
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

async function run(
	mode: (typeof modes)[number],
	userContext: UserContext,
	taskType?: string,
) {
	const options = {
		input: "Story requirements",
		pattern: "summarize" as const,
		userContext,
		taskType,
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

describe("delegated platform gateway lookup", () => {
	const tenant = { userId: "user-example", organizationId: "org-example" };

	beforeEach(() => {
		mocks.resolve.mockResolvedValue({
			model: {},
			metadata: {
				provider: "VERCEL_GATEWAY",
				modelString: "openai/example-embedding-model",
				configId: null,
				configSource: null,
			},
			trackUsage: vi.fn(),
		});
		mocks.providerConfig.mockRejectedValue(new Error("No tenant API key"));
		mocks.systemProviderConfig.mockResolvedValue({
			provider: "VERCEL_GATEWAY",
			apiKey: "example-platform-key",
		});
	});

	it.each(["delegated", "delegated-stream"] as const)(
		"keeps the selected platform credential for %s embedding work",
		async (mode) => {
			await run(mode, tenant, "EMBEDDING");
			expect(mocks.send).toHaveBeenCalledOnce();
			const request = JSON.parse(mocks.send.mock.calls[0][1].body);
			expect(request.credentials).toMatchObject({
				apiKey: "example-platform-key",
				model: "example-embedding-model",
			});
		},
	);

	it("does not dispatch when the system lookup returns a different provider", async () => {
		mocks.systemProviderConfig.mockResolvedValue({
			provider: "OPENAI_DIRECT",
			apiKey: "example-unrelated-key",
		});
		await expect(
			run("delegated", tenant, "EMBEDDING"),
		).resolves.toMatchObject({
			success: false,
			error: "The selected AI provider configuration changed during resolution.",
		});
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it.each([
		{ provider: "VERCEL_GATEWAY", configId: "example-tenant-gateway" },
		{ provider: "OPENAI_DIRECT", configId: null },
	])("keeps the tenant lookup for %o", async (metadata) => {
		mocks.resolve.mockResolvedValue({
			model: {},
			metadata: { modelString: "example-model", ...metadata },
			trackUsage: vi.fn(),
		});
		mocks.providerConfig.mockResolvedValue({
			provider: metadata.provider,
			apiKey: "example-tenant-key",
		});
		await run("delegated", tenant, "EMBEDDING");
		expect(mocks.send).toHaveBeenCalledOnce();
		expect(
			JSON.parse(mocks.send.mock.calls[0][1].body).credentials,
		).toMatchObject({
			apiKey: "example-tenant-key",
		});
	});
});
