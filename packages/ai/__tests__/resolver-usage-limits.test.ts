/**
 * `getAIModelWithMetadata` checks HARD usage limits before every request its
 * model makes, not only when it resolves the model.
 *
 * These run the real resolver, the real middleware chain and the real
 * `generateText`/`streamText` against a mock provider model, with the limit
 * check and the usage-row writer replaced at the package boundary, so they
 * pin what the unit tests of the middleware cannot: the scope the resolver
 * binds, and that the check sits outside the usage logger (a refused request
 * writes no row) in both usage modes. The ChatGPT plan resolver is covered
 * in chatgpt-plan-rotation.test.ts.
 */

import { AiUsageLimitExceededError } from "@repo/payments/lib/ai-usage-limit-error";
import {
	type DispatchBudgetRequest,
	runWithDispatchGuard,
} from "@repo/utils/dispatch-guard";
import { generateText, isStepCount, streamText, tool } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
	assertWithinAiUsageLimitsMock,
	getAiProviderApiKeyMock,
	getAiProviderByProviderMock,
	getPlanSpentPersonalProviderConfigMock,
	getModelForTaskMock,
	getTaskDefaultModelMock,
	getModelByCanonicalNameMock,
	getProviderModelMappingForCanonicalMock,
	getProviderModelIdForCanonicalMock,
	getCanonicalNameForProviderModelIdMock,
	getModelMock,
	logAiUsageAsyncMock,
} = vi.hoisted(() => ({
	assertWithinAiUsageLimitsMock: vi.fn(),
	getAiProviderApiKeyMock: vi.fn(),
	getAiProviderByProviderMock: vi.fn(),
	getPlanSpentPersonalProviderConfigMock: vi.fn(),
	getModelForTaskMock: vi.fn(),
	getTaskDefaultModelMock: vi.fn(),
	getModelByCanonicalNameMock: vi.fn(),
	getProviderModelMappingForCanonicalMock: vi.fn(async () => ({
		exists: false,
		providerModelId: null,
	})),
	getProviderModelIdForCanonicalMock: vi.fn(),
	getCanonicalNameForProviderModelIdMock: vi.fn(),
	getModelMock: vi.fn(),
	logAiUsageAsyncMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
	getActiveModels: vi.fn(),
	getAiProviderApiKey: getAiProviderApiKeyMock,
	getAiProviderApiKeyByProvider: getAiProviderByProviderMock,
	getPlanSpentPersonalProviderConfig: getPlanSpentPersonalProviderConfigMock,
	getEmbeddingProviderConfig: vi.fn(),
	getModelForTask: getModelForTaskMock,
	getProviderModelIdForCanonical: getProviderModelIdForCanonicalMock,
	getModelByCanonicalName: getModelByCanonicalNameMock,
	getProviderModelMappingForCanonical:
		getProviderModelMappingForCanonicalMock,
	getCanonicalNameForProviderModelId: getCanonicalNameForProviderModelIdMock,
	getSystemAiProviderApiKey: vi.fn(),
	getTaskDefaultModel: getTaskDefaultModelMock,
	updateProviderLastUsed: vi.fn(() => Promise.resolve()),
	logAiUsageAsync: logAiUsageAsyncMock,
}));

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: assertWithinAiUsageLimitsMock,
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((value: string) => value.replace("encrypted:", "")),
	decryptApiKeyMaybe: vi.fn((value: string) =>
		value.replace("encrypted:", ""),
	),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../model-factory", () => ({
	getEmbeddingModel: vi.fn(),
	getEvaluationModel: vi.fn(),
	getModel: getModelMock,
}));

import { answerRouteHash } from "../lib/answer-model-snapshot";
import { getAIModelWithMetadata } from "../lib/dynamic-model-selector";

const CONTEXT = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
};

const ORGANIZATION_GATEWAY = {
	apiKey: "encrypted:example-org-gateway-key",
	baseUrl: null,
	clientId: null,
	configId: "cfg-example-org",
	deploymentName: null,
	enabledProviders: [],
	encryptedClientSecret: null,
	provider: "VERCEL_GATEWAY",
	source: "organization" as const,
};

const PROVIDER_MODEL_ID = "openai/gpt-4o-mini-2024-07-18";

const SELECTION = {
	model: {
		canonicalName: "gpt-4o-mini",
		capabilities: [],
		contextWindow: 128000,
		maxOutputTokens: 16384,
		suitableForTasks: ["CHAT"],
		providerMappings: [
			{
				isAvailable: true,
				provider: "VERCEL_GATEWAY",
				providerModelId: PROVIDER_MODEL_ID,
			},
		],
	},
	providerModelId: PROVIDER_MODEL_ID,
	source: "org_override" as const,
};

/** The scope the resolution-time check uses for this context. */
const LIMIT_SCOPE = {
	userId: "user-1",
	organizationId: "org-1",
	projectId: "project-1",
	providerConfigId: "cfg-example-org",
	modelCanonicalName: "gpt-4o-mini",
	taskType: "CHAT",
};

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 4, text: 4, reasoning: 0 },
};

const TOOL_CALL_RESULT = {
	content: [
		{
			type: "tool-call" as const,
			toolCallId: "call-1",
			toolName: "lookup",
			input: "{}",
		},
	],
	finishReason: { unified: "tool-calls" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

const TEXT_RESULT = {
	content: [{ type: "text" as const, text: "Hello" }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage: USAGE,
	warnings: [],
};

const tools = {
	lookup: tool({
		inputSchema: z.object({}),
		execute: async () => ({ found: true }),
	}),
};

function limitError() {
	return new AiUsageLimitExceededError({
		message: "AI usage limit exceeded: limit-1 (TOKENS, MONTHLY)",
		limitId: "limit-1",
		dimension: "TOKENS" as never,
		window: "MONTHLY" as never,
		used: BigInt(100),
		max: BigInt(100),
		manageLimitsUrl: "https://example.com/limits",
	});
}

/** Passes the resolution-time check and `requests` request checks, then refuses. */
function allowRequests(requests: number, refusal = limitError()) {
	let remaining = requests + 1;
	assertWithinAiUsageLimitsMock.mockImplementation(async () => {
		if (remaining <= 0) {
			throw refusal;
		}
		remaining -= 1;
	});
	return refusal;
}

let model: MockLanguageModelV4;

beforeEach(() => {
	vi.clearAllMocks();
	assertWithinAiUsageLimitsMock.mockReset();
	assertWithinAiUsageLimitsMock.mockResolvedValue(undefined);
	let calls = 0;
	model = new MockLanguageModelV4({
		doGenerate: async () => {
			calls += 1;
			return calls === 1 ? TOOL_CALL_RESULT : TEXT_RESULT;
		},
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: "stream-start" as const, warnings: [] },
					{ type: "text-start" as const, id: "t1" },
					{ type: "text-delta" as const, id: "t1", delta: "Hello" },
					{ type: "text-end" as const, id: "t1" },
					{
						type: "finish" as const,
						finishReason: {
							unified: "stop" as const,
							raw: undefined,
						},
						usage: USAGE,
					},
				],
			}),
		}),
	});
	getModelMock.mockImplementation(() => model);
	getAiProviderApiKeyMock.mockResolvedValue(ORGANIZATION_GATEWAY);
	getAiProviderByProviderMock
		.mockReset()
		.mockImplementation((...args: unknown[]) =>
			getAiProviderApiKeyMock(...args),
		);
	getModelByCanonicalNameMock.mockReset();
	getModelForTaskMock.mockReset().mockResolvedValue(SELECTION);
	getTaskDefaultModelMock.mockReset();
});

describe("getAIModelWithMetadata — per-request usage-limit check", () => {
	it("checks every step's request with the scope the resolution check used", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(1);

		await generateText({
			model: resolved.model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(2),
		});

		// Resolution, then one check per step.
		expect(model.doGenerateCalls).toHaveLength(2);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(3);
		for (const call of assertWithinAiUsageLimitsMock.mock.calls) {
			expect(call).toEqual([LIMIT_SCOPE]);
		}
	});

	it("binds a chat's model override into the per-request scope", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", modelOverride: "example-override-model" },
			CONTEXT,
		);

		await generateText({ model: resolved.model, prompt: "Hi" });

		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(2);
		expect(assertWithinAiUsageLimitsMock.mock.calls[1]).toEqual([
			{
				...LIMIT_SCOPE,
				modelCanonicalName: "example-override-model",
			},
		]);
	});

	it("refuses a later step once the limit is reached: nothing is dispatched and no usage row is written for it", async () => {
		const refusal = allowRequests(1);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);

		const error = await generateText({
			model: resolved.model,
			prompt: "Hi",
			tools,
			stopWhen: isStepCount(5),
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(refusal);
		// Step 1 ran and wrote its row; step 2 reached neither the provider
		// nor the usage logger.
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledTimes(1);
		expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
			expect.objectContaining({ success: true }),
		);
	});

	it("refuses a reused model's next stream before it is opened, writing no row", async () => {
		const refusal = allowRequests(0);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		const onError = vi.fn();

		const result = streamText({
			model: resolved.model,
			prompt: "Hi",
			onError,
		});
		for await (const _ of result.stream) {
			// drain
		}

		expect(onError).toHaveBeenCalledWith({ error: refusal });
		expect(model.doStreamCalls).toHaveLength(0);
		expect(logAiUsageAsyncMock).not.toHaveBeenCalled();
	});

	it("checks per request in aggregate usage mode too", async () => {
		const refusal = allowRequests(1);
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", usageLogging: "aggregate" },
			CONTEXT,
		);

		await generateText({ model: resolved.model, prompt: "first" });
		const error = await generateText({
			model: resolved.model,
			prompt: "second",
			maxRetries: 0,
		}).catch((caught: unknown) => caught);

		expect(error).toBe(refusal);
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(assertWithinAiUsageLimitsMock).toHaveBeenCalledTimes(3);
		expect(assertWithinAiUsageLimitsMock.mock.calls[2]).toEqual([
			LIMIT_SCOPE,
		]);
	});
});

describe("resolved catalog output reservation", () => {
	it("passes the resolved model cap into the factory ledger middleware", async () => {
		getModelForTaskMock.mockResolvedValue({
			...SELECTION,
			model: { ...SELECTION.model, maxOutputTokens: 8192 },
		});
		const requests: DispatchBudgetRequest[] = [];
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		await runWithDispatchGuard(
			{
				key: "example-turn",
				assertDispatchable: async () => undefined,
				rethrowIfStopped: () => undefined,
				abortSignal: () => undefined,
				budget: {
					reserve: async (request) => {
						requests.push(request);
						return {
							attemptId: "example-attempt",
							outputCap: request.requestedOutputTokens,
						};
					},
					settle: async () => undefined,
					markUnknown: async () => undefined,
					release: async () => undefined,
				},
			},
			() =>
				generateText({
					model: resolved.model,
					prompt: "Example",
					maxRetries: 0,
				}),
		);
		expect(requests[0]?.requestedOutputTokens).toBe(8192);
		expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(8192);
	});
});

describe("model override catalog identity", () => {
	beforeEach(() => {
		getAiProviderApiKeyMock.mockResolvedValue({
			...ORGANIZATION_GATEWAY,
			provider: "DATABRICKS",
			baseUrl: "https://example.com/serving-endpoints",
		});
		getModelForTaskMock.mockResolvedValue({
			...SELECTION,
			model: {
				...SELECTION.model,
				providerMappings: [
					{
						isAvailable: true,
						provider: "DATABRICKS",
						providerModelId: "system.ai.example-default",
					},
				],
			},
			providerModelId: "system.ai.example-default",
		});
		getProviderModelIdForCanonicalMock.mockResolvedValue(null);
		getProviderModelMappingForCanonicalMock.mockResolvedValue({
			exists: false,
			providerModelId: null,
		});
		getModelByCanonicalNameMock.mockResolvedValue(null);
		getCanonicalNameForProviderModelIdMock.mockResolvedValue(null);
	});

	it.each(["example-small-model", "system.ai.example-small-model"])(
		"uses the override model output cap for %s",
		async (override) => {
			getProviderModelMappingForCanonicalMock.mockResolvedValue({
				exists: override === "example-small-model",
				providerModelId:
					override === "example-small-model"
						? "system.ai.example-small-model"
						: null,
			});
			getCanonicalNameForProviderModelIdMock.mockResolvedValue(
				"example-small-model",
			);
			getModelByCanonicalNameMock.mockResolvedValue({
				canonicalName: "example-small-model",
				maxOutputTokens: 8192,
			});
			const resolved = await getAIModelWithMetadata(
				{ taskType: "CHAT", modelOverride: override },
				CONTEXT,
			);
			expect(resolved.metadata.canonicalName).toBe("example-small-model");
			expect(resolved.metadata.maxOutputTokens).toBe(8192);
			expect(resolved.metadata.modelString).toBe(
				"system.ai.example-small-model",
			);
		},
	);

	it.each([
		["system.ai.claude-sonnet-5", "claude-sonnet-5", false],
		["claude-sonnet-5", "claude-sonnet-5", true],
		["example-unknown-model", "example-unknown-model", false],
	])(
		"resolves %s identity to %s without changing dispatch",
		async (override, canonicalName, mapped) => {
			if (mapped) {
				getProviderModelMappingForCanonicalMock.mockResolvedValue({
					exists: true,
					providerModelId: "system.ai.claude-sonnet-5",
				});
			} else if (override === "system.ai.claude-sonnet-5") {
				getCanonicalNameForProviderModelIdMock.mockResolvedValue(
					canonicalName,
				);
			}
			const resolved = await getAIModelWithMetadata(
				{ taskType: "CHAT", modelOverride: override },
				CONTEXT,
			);
			expect(resolved.metadata.canonicalName).toBe(canonicalName);
			expect(resolved.metadata.modelString).toBe(
				mapped ? "system.ai.claude-sonnet-5" : override,
			);
			expect(resolved.metadata.selectionSource).toBe("override");
			expect(resolved.metadata.maxOutputTokens).toBeUndefined();
			expect(resolved.metadata.contextWindow).toBeUndefined();
			expect(getModelMock).toHaveBeenCalledWith(
				resolved.metadata.modelString,
				expect.objectContaining({
					canonicalModelName: canonicalName,
					isReasoningModel: false,
				}),
			);
			await generateText({ model: resolved.model, prompt: "Hi" });
			for (const [scope] of assertWithinAiUsageLimitsMock.mock.calls) {
				expect(scope.modelCanonicalName).toBe(canonicalName);
			}
			expect(logAiUsageAsyncMock).toHaveBeenCalledWith(
				expect.objectContaining({ modelCanonicalName: canonicalName }),
			);
			expect(
				getProviderModelMappingForCanonicalMock,
			).toHaveBeenCalledTimes(1);
			if (mapped || canonicalName !== override) {
				expect(
					getModelByCanonicalNameMock,
				).toHaveBeenCalledExactlyOnceWith(canonicalName);
			} else {
				expect(getModelByCanonicalNameMock).not.toHaveBeenCalled();
			}
			expect(getProviderModelIdForCanonicalMock).not.toHaveBeenCalled();
			if (mapped) {
				expect(
					getCanonicalNameForProviderModelIdMock,
				).not.toHaveBeenCalled();
			} else {
				expect(
					getCanonicalNameForProviderModelIdMock,
				).toHaveBeenCalledWith(override, "DATABRICKS");
			}
		},
	);

	it("keeps a canonical without a mapping before considering reverse matches", async () => {
		getProviderModelMappingForCanonicalMock.mockResolvedValue({
			exists: true,
			providerModelId: null,
		});
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", modelOverride: "claude-sonnet-5" },
			CONTEXT,
		);
		expect(resolved.metadata.canonicalName).toBe("claude-sonnet-5");
		expect(resolved.metadata.modelString).toBe("claude-sonnet-5");
		expect(getModelByCanonicalNameMock).toHaveBeenCalledExactlyOnceWith(
			"claude-sonnet-5",
		);
		expect(getProviderModelMappingForCanonicalMock).toHaveBeenCalledTimes(
			1,
		);
		expect(
			getProviderModelIdForCanonicalMock,
		).toHaveBeenCalledExactlyOnceWith(
			"claude-sonnet-5",
			"OPENAI_CHATGPT_PLAN",
		);
		expect(getCanonicalNameForProviderModelIdMock).not.toHaveBeenCalled();
	});
	it("uses the canonical identity for reasoning detection on an opaque provider id", async () => {
		getCanonicalNameForProviderModelIdMock.mockResolvedValue("deepseek-r1");
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT", modelOverride: "system.ai.example-endpoint" },
			CONTEXT,
		);
		expect(resolved.metadata.modelString).toBe(
			"system.ai.example-endpoint",
		);
		expect(getModelMock).toHaveBeenCalledWith(
			"system.ai.example-endpoint",
			expect.objectContaining({
				canonicalModelName: "deepseek-r1",
				isReasoningModel: true,
			}),
		);
	});
});

describe("answer model snapshot", () => {
	it("keeps the resolved model when the task catalog changes", async () => {
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		const snapshot = (
			first.metadata as unknown as { answerSnapshot?: unknown }
		).answerSnapshot;
		getModelForTaskMock.mockResolvedValue({
			...SELECTION,
			model: { ...SELECTION.model, canonicalName: "example-other" },
			providerModelId: "example-other",
		});
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: snapshot },
			CONTEXT,
		);
		expect(next.metadata.modelString).toBe(PROVIDER_MODEL_ID);
		expect(next.metadata.canonicalName).toBe("gpt-4o-mini");
	});
	it("records a credential-free route with the resolved output cap", async () => {
		const resolved = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		expect(resolved.metadata.answerSnapshot).toMatchObject({
			provider: "VERCEL_GATEWAY",
			modelString: PROVIDER_MODEL_ID,
			canonicalName: "gpt-4o-mini",
			configId: "cfg-example-org",
			maxOutputTokens: 16384,
		});
		expect(
			JSON.stringify(
				(resolved.metadata as unknown as { answerSnapshot?: unknown })
					.answerSnapshot,
			),
		).not.toContain("example-org-gateway-key");
	});
});

it("refreshes an unusable answer configuration once and records the reason", async () => {
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, CONTEXT);
	getAiProviderApiKeyMock.mockResolvedValue({
		...ORGANIZATION_GATEWAY,
		configId: "example-replacement",
	});
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
		CONTEXT,
	);
	expect(next.metadata.answerSnapshot).toMatchObject({
		configId: "example-replacement",
		reResolved: true,
	});
	expect(next.metadata.answerRouteChanges).toMatchObject([
		{ cause: "model_unavailable", reason: "configuration_unavailable" },
	]);
	getAiProviderApiKeyMock.mockResolvedValue({
		...ORGANIZATION_GATEWAY,
		configId: "example-third",
	});
	await expect(
		getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: next.metadata.answerSnapshot },
			CONTEXT,
		),
	).rejects.toThrow("no longer available");
});

it.each(["generate", "stream"])(
	"recovers a provider-refused answer model once during %s",
	async (method) => {
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		const failure = Object.assign(new Error("key revoked"), {
			statusCode: 401,
		});
		const refused = new MockLanguageModelV4({
			doGenerate: async () => {
				throw failure;
			},
			doStream: async () => {
				throw failure;
			},
		});
		getModelMock.mockReturnValueOnce(refused).mockReturnValue(model);
		const next = await getAIModelWithMetadata(
			{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
			CONTEXT,
		);
		if (method === "generate") {
			await generateText({
				model: next.model,
				prompt: "Example",
				maxRetries: 0,
			});
		} else {
			await streamText({
				model: next.model,
				prompt: "Example",
				maxRetries: 0,
			}).consumeStream();
		}
		expect(next.metadata.answerSnapshot?.reResolved).toBe(true);
		expect(next.metadata.answerRouteChanges).toMatchObject([
			{ cause: "model_unavailable", reason: "provider_refused" },
		]);
	},
);

it("refreshes an answer route when its catalog model is disabled", async () => {
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, CONTEXT);
	getModelByCanonicalNameMock.mockResolvedValueOnce({ isActive: false });
	getModelForTaskMock.mockResolvedValue({
		...SELECTION,
		model: { ...SELECTION.model, canonicalName: "example-active-model" },
		providerModelId: "example-active-model",
	});
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: first.metadata.answerSnapshot },
		CONTEXT,
	);
	expect(next.metadata.canonicalName).toBe("example-active-model");
	expect(next.metadata.answerRouteChanges).toMatchObject([
		{ cause: "model_unavailable", reason: "configuration_unavailable" },
	]);
});

it("rechecks personal-key fallback consent before rebuilding a pinned answer route", async () => {
	const { answerRouteHash } = await import("../lib/answer-model-snapshot");
	const first = await getAIModelWithMetadata({ taskType: "CHAT" }, CONTEXT);
	const personalConfig = {
		...ORGANIZATION_GATEWAY,
		configId: "example-personal-config",
		source: "user" as const,
	};
	getAiProviderByProviderMock.mockResolvedValue(personalConfig);
	getPlanSpentPersonalProviderConfigMock.mockResolvedValue(null);
	const initialSnapshot = first.metadata.answerSnapshot;
	if (!initialSnapshot) {
		throw new Error("No initial route");
	}
	const snapshot = {
		...initialSnapshot,
		configId: personalConfig.configId,
		configSource: "user" as const,
		routeHash: answerRouteHash(personalConfig),
		personalKeyFallback: true as const,
	};
	const next = await getAIModelWithMetadata(
		{ taskType: "CHAT", answerSnapshot: snapshot },
		CONTEXT,
	);
	expect(next.metadata.answerSnapshot).toMatchObject({
		configId: ORGANIZATION_GATEWAY.configId,
		configSource: "organization",
		reResolved: true,
	});
});

it.each([
	{
		provider: "OPENAI_DIRECT",
		deploymentName: null,
		defaultDeployment: "example-default-deployment",
		defaultProvider: "AZURE_AI_FOUNDRY",
	},
	{
		provider: "AZURE_AI_FOUNDRY",
		deploymentName: "example-deployment",
		defaultDeployment: null,
		defaultProvider: "OPENAI_DIRECT",
	},
])(
	"pins the $provider fallback using its own deployment name",
	async ({
		provider,
		deploymentName,
		defaultDeployment,
		defaultProvider,
	}) => {
		const defaultConfig = {
			...ORGANIZATION_GATEWAY,
			provider: defaultProvider,
			deploymentName: defaultDeployment,
		};
		const selectedConfig = {
			...ORGANIZATION_GATEWAY,
			provider,
			baseUrl: "https://example.openai.azure.com",
			configId: "example-selected-provider",
			deploymentName,
		};
		getAiProviderApiKeyMock.mockResolvedValue(defaultConfig);
		getAiProviderByProviderMock.mockResolvedValue(selectedConfig);
		getModelForTaskMock.mockResolvedValue(null);
		getTaskDefaultModelMock.mockResolvedValue({
			...SELECTION.model,
			providerMappings: [
				{
					provider,
					providerModelId: "example-selected-model",
					isAvailable: true,
				},
			],
		});
		const first = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			CONTEXT,
		);
		const snapshot = first.metadata.answerSnapshot;
		if (!snapshot) {
			throw new Error("Expected an answer snapshot");
		}
		const second = await getAIModelWithMetadata(
			{
				taskType: "CHAT",
				answerSnapshot: {
					...snapshot,
					// Older snapshots may retain the default provider's deployment option.
					deploymentName: "example-stale-deployment",
				},
			},
			CONTEXT,
		);
		const third = await getAIModelWithMetadata(
			{
				taskType: "CHAT",
				answerSnapshot: second.metadata.answerSnapshot,
			},
			CONTEXT,
		);
		expect(
			[first, second, third].map((r) => r.metadata.modelString),
		).toEqual([
			"example-selected-model",
			"example-selected-model",
			"example-selected-model",
		]);
		expect(second.metadata.answerRouteChanges).toEqual([]);
		expect(third.metadata.answerRouteChanges).toEqual([]);
		expect(third.metadata.answerSnapshot?.reResolved).toBeUndefined();
		expect(getModelForTaskMock).toHaveBeenCalledTimes(1);
		// The selected provider supplies the deployment option across pinned calls.
		expect(
			getModelMock.mock.calls.map(
				([, options]) => options.deploymentName,
			),
		).toEqual([deploymentName, deploymentName, deploymentName]);
	},
);

it("distinguishes deployment-only route changes", () => {
	const route = {
		provider: "AZURE_AI_FOUNDRY",
		configId: "example-config",
		baseUrl: "https://example.openai.azure.com",
		deploymentName: "example-deployment",
	};
	expect(answerRouteHash(route)).not.toBe(
		answerRouteHash({
			...route,
			deploymentName: "example-other-deployment",
		}),
	);
});
