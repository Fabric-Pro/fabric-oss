/**
 * Image generation inside an Advisor chat turn (`fabric_generate_image`).
 *
 * The image tool makes the most expensive provider requests a turn can
 * make, through three paths: the gateway's multimodal language model, the
 * gateway's dedicated image API, and FAL over plain HTTP. With a turn scope:
 *   - a Stop recorded while the tool resolves credentials or downloads its
 *     input image refuses the request — zero provider requests;
 *   - every attempt is checked (the SDK's own retries included);
 *   - a cancelled activity aborts the request in flight;
 *   - a stop is rethrown, never turned into an ordinary "image failed".
 * Without a turn scope (direct chat, the agent executor) nothing changes.
 */

import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { MockImageModelV4, MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	fetchCredentialsByProvider: vi.fn(),
	downloadFile: vi.fn(),
	getRAGProviderConfig: vi.fn(),
	physical: { count: 0, aborted: false },
	hangUntilAborted: { value: false },
	/** Runs once a physical request has answered. */
	afterRequest: { current: undefined as (() => void) | undefined },
	uploadFile: vi.fn(),
	generateContent: vi.fn(),
	beforePhysical: { current: undefined as (() => void) | undefined },
	maxOutputTokens: { current: undefined as number | undefined },
	cacheReadTokens: undefined as number | undefined,
}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByProvider: h.fetchCredentialsByProvider,
	logAiUsageAsync: vi.fn(),
	resolveModel: vi.fn(),
	checkConversationTurnDispatchable: h.checkDispatchable,
}));
vi.mock("@repo/storage", () => ({
	downloadFile: h.downloadFile,
	getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/image.png"),
	uploadFile: h.uploadFile,
}));

/** One physical provider request; hangs until aborted when asked to. */
async function physicalRequest(signal: AbortSignal | undefined) {
	h.beforePhysical.current?.();
	h.physical.count++;
	if (!h.hangUntilAborted.value) {
		h.afterRequest.current?.();
		return;
	}
	await new Promise<void>((_resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("never aborted")),
			3_000,
		);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			h.physical.aborted = true;
			reject(signal.reason);
		});
	});
}

vi.mock("@repo/ai", async () => {
	const ai = await import("ai");
	const USAGE = {
		inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 1, text: 1, reasoning: 0 },
	};
	return {
		generateText: ai.generateText,
		generateImage: ai.generateImage,
		getRAGProviderConfig: h.getRAGProviderConfig,
		isVercelGatewayKey: (apiKey: string) => apiKey.startsWith("vck_"),
		createGateway: () => {
			const gateway = (modelId: string) =>
				new MockLanguageModelV4({
					modelId,
					doGenerate: async (options) => {
						h.maxOutputTokens.current = options.maxOutputTokens;
						await physicalRequest(options.abortSignal);
						return {
							content: [
								{
									type: "file" as const,
									mediaType: "image/png",
									data: {
										type: "data" as const,
										data: new Uint8Array([1, 2, 3]),
									},
								},
							],
							finishReason: {
								unified: "stop" as const,
								raw: undefined,
							},
							usage: {
								...USAGE,
								inputTokens: {
									...USAGE.inputTokens,
									noCache: 1 - (h.cacheReadTokens ?? 0),
									cacheRead: h.cacheReadTokens,
								},
							},
							warnings: [],
						};
					},
				});
			(gateway as unknown as { imageModel: unknown }).imageModel = (
				modelId: string,
			) =>
				new MockImageModelV4({
					modelId,
					doGenerate: async (options) => {
						await physicalRequest(options.abortSignal);
						return {
							images: [new Uint8Array([1, 2, 3])],
							warnings: [],
							response: {
								timestamp: new Date(),
								modelId,
								headers: undefined,
							},
						};
					},
				});
			return gateway;
		},
	};
});

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		models = { generateContent: h.generateContent };
	},
}));

import { estimateLanguageRequestInputTokens } from "@repo/ai/lib/turn-budget-estimate";
import { runWithDispatchGuard } from "@repo/utils/dispatch-guard";
import { generateImageActivity } from "../image-generation";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const NANO_BANANA = "google/gemini-3.1-flash-image-preview";
const IMAGE_API_MODEL = "openai/gpt-image-1";

let cancelled = false;
const originalFetch = global.fetch;

beforeEach(() => {
	cancelled = false;
	h.physical.count = 0;
	h.beforePhysical.current = undefined;
	h.maxOutputTokens.current = undefined;
	h.cacheReadTokens = 0;
	h.physical.aborted = false;
	h.hangUntilAborted.value = false;
	h.afterRequest.current = undefined;
	h.uploadFile.mockReset();
	h.uploadFile.mockResolvedValue(undefined);
	h.checkDispatchable.mockReset();
	h.checkDispatchable.mockImplementation(async () =>
		cancelled ? { ok: false, reason: "cancelled" } : { ok: true },
	);
	h.getRAGProviderConfig.mockReset();
	h.getRAGProviderConfig.mockResolvedValue({
		apiKey: "gateway-key",
		provider: "VERCEL_GATEWAY",
	});
	h.downloadFile.mockReset();
	h.downloadFile.mockResolvedValue({
		data: Buffer.from([1, 2, 3]),
		contentType: "image/png",
	});
	h.fetchCredentialsByProvider.mockReset();
	h.fetchCredentialsByProvider.mockResolvedValue({ FAL_API_KEY: "fal-key" });
});

afterEach(() => {
	global.fetch = originalFetch;
	vi.unstubAllEnvs();
});

function expectRefused(outcome: unknown) {
	expect(outcome).toBeInstanceOf(ApplicationFailure);
	expect((outcome as ApplicationFailure).type).toBe("TurnNotDispatchable");
}

async function run(params: Parameters<typeof generateImageActivity>[0]) {
	return new MockActivityEnvironment()
		.run(generateImageActivity, params)
		.then(
			(value) => ({ resolvedWith: value }),
			(err: unknown) => err,
		);
}

describe("generateImageActivity — a recorded Stop refuses the provider request", () => {
	it("Stop recorded during credential resolution (gateway multimodal): zero requests", async () => {
		h.getRAGProviderConfig.mockImplementation(async () => {
			cancelled = true;
			return { apiKey: "gateway-key", provider: "VERCEL_GATEWAY" };
		});
		const outcome = await run({
			prompt: "a paper boat",
			provider: "gateway",
			gatewayModel: NANO_BANANA,
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			turnScope: TURN_SCOPE,
		});
		expect(h.physical.count).toBe(0);
		expectRefused(outcome);
	});

	it("Stop recorded during the input-image download: zero requests", async () => {
		h.downloadFile.mockImplementation(async () => {
			cancelled = true;
			return { data: Buffer.from([1, 2, 3]), contentType: "image/png" };
		});
		const outcome = await run({
			prompt: "make it blue",
			provider: "gateway",
			gatewayModel: NANO_BANANA,
			inputImagePath: `${TURN_SCOPE.organizationId}/uploads/boat.png`,
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			turnScope: TURN_SCOPE,
		});
		expect(h.physical.count).toBe(0);
		expectRefused(outcome);
	});

	it("Stop recorded during credential resolution (gateway image API): zero requests", async () => {
		h.getRAGProviderConfig.mockImplementation(async () => {
			cancelled = true;
			return { apiKey: "gateway-key", provider: "VERCEL_GATEWAY" };
		});
		const outcome = await run({
			prompt: "a paper boat",
			provider: "gateway",
			gatewayModel: IMAGE_API_MODEL,
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			turnScope: TURN_SCOPE,
		});
		expect(h.physical.count).toBe(0);
		expectRefused(outcome);
	});

	it("Stop recorded during credential resolution (FAL): no HTTP request", async () => {
		const fetchSpy = vi.fn(async () => new Response("{}"));
		global.fetch = fetchSpy as unknown as typeof fetch;
		h.fetchCredentialsByProvider.mockImplementation(async () => {
			cancelled = true;
			return { FAL_API_KEY: "fal-key" };
		});
		const outcome = await run({
			prompt: "a paper boat",
			provider: "fal",
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
			turnScope: TURN_SCOPE,
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		expectRefused(outcome);
	});

	it("a run without a turn generates as before", async () => {
		h.getRAGProviderConfig.mockImplementation(async () => {
			cancelled = true;
			return { apiKey: "gateway-key", provider: "VERCEL_GATEWAY" };
		});
		const outcome = (await run({
			prompt: "a paper boat",
			provider: "gateway",
			gatewayModel: NANO_BANANA,
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
		})) as { resolvedWith: { success: boolean } };
		expect(h.physical.count).toBe(1);
		expect(outcome.resolvedWith.success).toBe(true);
		expect(h.checkDispatchable).not.toHaveBeenCalled();
	});
});

describe("generateImageActivity — a cancelled activity aborts the in-flight request", () => {
	it("gateway multimodal request is aborted and the activity reports cancelled", async () => {
		h.hangUntilAborted.value = true;
		const env = new MockActivityEnvironment();
		const running = env
			.run(generateImageActivity, {
				prompt: "a paper boat",
				provider: "gateway" as const,
				gatewayModel: NANO_BANANA,
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		await vi.waitFor(() => {
			expect(h.physical.count).toBe(1);
		});
		env.cancel();
		const outcome = await running;
		expect(h.physical.aborted).toBe(true);
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});

	it("FAL HTTP request is aborted and the activity reports cancelled", async () => {
		let falAborted = false;
		global.fetch = vi.fn(
			(_url: unknown, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						falAborted = true;
						reject(init.signal?.reason);
					});
				}),
		) as unknown as typeof fetch;
		const env = new MockActivityEnvironment();
		const running = env
			.run(generateImageActivity, {
				prompt: "a paper boat",
				provider: "fal" as const,
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
				turnScope: TURN_SCOPE,
			})
			.then(
				(value) => ({ resolvedWith: value }),
				(err: unknown) => err,
			);
		await vi.waitFor(() => {
			expect(global.fetch).toHaveBeenCalled();
		});
		env.cancel();
		const outcome = await running;
		expect(falAborted).toBe(true);
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});
});

describe("generateImageActivity — nothing is stored once the turn stops", () => {
	it.each([
		["gateway multimodal", NANO_BANANA],
		["gateway image API", IMAGE_API_MODEL],
	])(
		"%s: an activity cancelled after the image came back uploads nothing and reports cancelled",
		async (_path, gatewayModel) => {
			const env = new MockActivityEnvironment();
			// The image is generated and returned in full; the cancellation
			// lands between it and the upload.
			h.afterRequest.current = () => env.cancel();
			const outcome = await env
				.run(generateImageActivity, {
					prompt: "a paper boat",
					provider: "gateway" as const,
					gatewayModel,
					userId: TURN_SCOPE.userId,
					organizationId: TURN_SCOPE.organizationId,
					turnScope: TURN_SCOPE,
				})
				.then(
					(value) => ({ resolvedWith: value }),
					(err: unknown) => err,
				);
			expect(h.physical.count).toBe(1);
			expect(outcome).toBeInstanceOf(CancelledFailure);
			expect(h.uploadFile).not.toHaveBeenCalled();
		},
	);

	it("a run without a turn uploads the image as before", async () => {
		const outcome = (await run({
			prompt: "a paper boat",
			provider: "gateway",
			gatewayModel: NANO_BANANA,
			userId: TURN_SCOPE.userId,
			organizationId: TURN_SCOPE.organizationId,
		})) as { resolvedWith: { success: boolean } };
		expect(outcome.resolvedWith.success).toBe(true);
		expect(h.uploadFile).toHaveBeenCalledTimes(1);
	});
});

describe("generateImageActivity — called without a turn scope inside a turn's guard", () => {
	const STOP = new Error("the chat turn stopped");
	let stopped = false;
	const guard = {
		key: "turn-example-1",
		assertDispatchable: async () => undefined,
		abortSignal: () => undefined,
		rethrowIfStopped: (error: unknown) => {
			if (error === STOP) {
				throw error;
			}
		},
		throwIfStopped: () => {
			if (stopped) {
				throw STOP;
			}
		},
	};

	beforeEach(() => {
		stopped = false;
	});

	it("FAL: a stop latched during credential resolution sends nothing", async () => {
		const fetchSpy = vi.fn(async () => new Response("{}"));
		global.fetch = fetchSpy as unknown as typeof fetch;
		h.fetchCredentialsByProvider.mockImplementation(async () => {
			stopped = true;
			return { FAL_API_KEY: "fal-key" };
		});
		const outcome = await runWithDispatchGuard(guard, () =>
			run({
				prompt: "a paper boat",
				provider: "fal",
				userId: TURN_SCOPE.userId,
				organizationId: TURN_SCOPE.organizationId,
			}),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(outcome).toBe(STOP);
	});
});

describe("image token reservations", () => {
	function ledger() {
		const reserve = vi.fn(async () => ({
			attemptId: "image-attempt",
			outputCap: null,
		}));
		const budget = {
			reserve,
			settle: vi.fn(async () => {}),
			markUnknown: vi.fn(async () => {}),
			release: vi.fn(async () => {}),
		};
		const guard = {
			key: "example-turn",
			assertDispatchable: async () => {},
			abortSignal: () => undefined,
			rethrowIfStopped: () => {},
			budget,
		};
		return { budget, guard };
	}
	it.each([undefined, 0, 1])(
		"reserves the resolved gateway model before sending IMAGE+TEXT without a token cap, cacheReadTokens=%s",
		async (cacheReadTokens) => {
			h.cacheReadTokens = cacheReadTokens;
			const { budget, guard } = ledger();
			let reservationsAtSend = 0;
			h.beforePhysical.current = () => {
				reservationsAtSend = budget.reserve.mock.calls.length;
			};
			const outcome = await runWithDispatchGuard(guard, () =>
				run({
					prompt: "boat",
					provider: "gateway",
					gatewayModel: NANO_BANANA,
					userId: TURN_SCOPE.userId,
					organizationId: "example-org",
					inputImagePath: "example-org/input.png",
				}),
			);
			expect(outcome).toMatchObject({ resolvedWith: { success: true } });
			expect(reservationsAtSend).toBe(1);
			expect(budget.reserve).toHaveBeenCalledWith(
				expect.objectContaining({
					modality: "language",
					inputEstimate: estimateLanguageRequestInputTokens({
						prompt: [
							{
								content: [
									{ type: "image" },
									{ type: "text", text: "boat" },
								],
							},
						],
					}),
					requestedOutputTokens: 16384,
					enforcesOutputCap: false,
				}),
			);
			expect(h.maxOutputTokens.current).toBeUndefined();
			expect(budget.settle).toHaveBeenCalledTimes(1);
			expect(budget.settle).toHaveBeenCalledWith("image-attempt", {
				inputTokens: 1,
				outputTokens: 1,
				...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
			});
		},
	);
	it("charges Gemini candidate and thinking output using the SDK usage totals", async () => {
		vi.stubEnv("GOOGLE_AI_STUDIO_API_KEY", "example-key");
		const { budget, guard } = ledger();
		h.generateContent.mockResolvedValue({
			candidates: [
				{
					content: {
						parts: [
							{
								inlineData: {
									mimeType: "image/png",
									data: "AQ==",
								},
							},
						],
					},
				},
			],
			usageMetadata: {
				promptTokenCount: 12,
				candidatesTokenCount: 30,
				thoughtsTokenCount: 37,
				toolUsePromptTokenCount: 5,
				cachedContentTokenCount: 4,
			},
		});
		const outcome = await runWithDispatchGuard(guard, () =>
			run({
				prompt: "boat",
				provider: "gemini",
				userId: TURN_SCOPE.userId,
			}),
		);
		expect(outcome).toMatchObject({ resolvedWith: { success: true } });
		expect(budget.settle).toHaveBeenCalledWith("image-attempt", {
			inputTokens: 12,
			outputTokens: 67,
		});
		expect(budget.markUnknown).not.toHaveBeenCalled();
	});
	it("reserves once per physical gateway call when the scoped turn guard wraps the model", async () => {
		const { budget, guard } = ledger();
		const reservationsAtSend: number[] = [];
		h.beforePhysical.current = () => {
			reservationsAtSend.push(budget.reserve.mock.calls.length);
		};
		await runWithDispatchGuard(guard, async () => {
			for (let call = 0; call < 2; call++) {
				const outcome = await run({
					prompt: "boat",
					provider: "gateway",
					gatewayModel: NANO_BANANA,
					userId: TURN_SCOPE.userId,
					turnScope: TURN_SCOPE,
				});
				expect(outcome).toMatchObject({
					resolvedWith: { success: true },
				});
			}
		});
		expect(reservationsAtSend).toEqual([1, 2]);
		expect(budget.reserve).toHaveBeenCalledTimes(2);
		expect(budget.settle).toHaveBeenCalledTimes(2);
	});
	it.each([true, false])(
		"direct Gemini reserves before sending and handles complete usage=%s",
		async (complete) => {
			vi.stubEnv("GOOGLE_AI_STUDIO_API_KEY", "example-key");
			const { budget, guard } = ledger();
			let reservationsAtSend = 0;
			h.generateContent.mockImplementation(async () => {
				reservationsAtSend = budget.reserve.mock.calls.length;
				return {
					candidates: [
						{
							content: {
								parts: [
									{
										inlineData: {
											mimeType: "image/png",
											data: "AQ==",
										},
									},
								],
							},
						},
					],
					usageMetadata: {
						promptTokenCount: 12,
						...(complete ? { candidatesTokenCount: 30 } : {}),
					},
				};
			});
			const outcome = await runWithDispatchGuard(guard, () =>
				run({
					prompt: "boat",
					provider: "gemini",
					userId: TURN_SCOPE.userId,
				}),
			);
			expect(outcome).toMatchObject({ resolvedWith: { success: true } });
			expect(reservationsAtSend).toBe(1);
			expect(budget.reserve).toHaveBeenCalledWith(
				expect.objectContaining({
					modality: "language",
					inputEstimate: estimateLanguageRequestInputTokens({
						prompt: [{ content: "boat" }],
					}),
					requestedOutputTokens: 16384,
					minOutputTokens: 16384,
					enforcesOutputCap: false,
				}),
			);
			expect(
				h.generateContent.mock.calls.at(-1)?.[0].config.maxOutputTokens,
			).toBeUndefined();
			if (complete) {
				expect(budget.settle).toHaveBeenCalledWith("image-attempt", {
					inputTokens: 12,
					outputTokens: 30,
				});
			} else {
				expect(budget.markUnknown).toHaveBeenCalledWith(
					"image-attempt",
				);
				expect(budget.settle).not.toHaveBeenCalled();
			}
		},
	);
});
