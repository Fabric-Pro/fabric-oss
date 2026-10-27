import { APICallError, generateText, wrapLanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
	createRequestFingerprint,
	createRequestObservationMiddleware,
	hasActiveRequestObservation,
	observeModelRequests,
	observeRequestWire,
	setRequestAdditions,
} from "../lib/request-observation";
import { firstRequestChange } from "../lib/request-shape";

const sentinel = "PRIVATE_PROMPT_SENTINEL";
const request = {
	modelId: "example-model",
	route: "example-route",
	tools: [{ name: "example", description: sentinel }],
	prompt: [
		{ role: "system", content: sentinel },
		{ role: "user", content: sentinel },
	],
	toolChoice: { type: "auto" },
	sessionKey: sentinel,
};
describe("request fingerprints", () => {
	it("is stable and contains hashes and sizes without prompt text", () => {
		const a = createRequestFingerprint(request);
		expect(createRequestFingerprint(request)).toEqual(a);
		expect(JSON.stringify(a)).not.toContain(sentinel);
		expect(a.messages[0]).toMatchObject({
			role: "user",
			bytes: expect.any(Number),
			hash: expect.any(String),
		});
	});
	it("locates a pruned message", () => {
		const next = {
			...request,
			prompt: [request.prompt[0], { role: "user", content: "[pruned]" }],
		};
		expect(
			firstRequestChange(
				createRequestFingerprint(request),
				createRequestFingerprint(next),
			),
		).toEqual({ section: "messages", index: 0 });
	});
	it("locates an appended tool before messages", () => {
		expect(
			firstRequestChange(
				createRequestFingerprint(request),
				createRequestFingerprint({
					...request,
					tools: [...request.tools, { name: "added" }],
				}),
			),
		).toEqual({ section: "tools", index: 1 });
	});
	it("locates a changed system block", () => {
		expect(
			firstRequestChange(
				createRequestFingerprint(request),
				createRequestFingerprint({
					...request,
					prompt: [
						{ role: "system", content: "changed" },
						request.prompt[1],
					],
				}),
			),
		).toEqual({ section: "system", index: 0 });
	});
	it("records cache marker positions without their text", () => {
		const fp = createRequestFingerprint({
			...request,
			prompt: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: sentinel,
							providerOptions: {
								anthropic: {
									cacheControl: { type: "ephemeral" },
								},
							},
						},
					],
				},
			],
		});
		expect(fp.cacheMarkers).toHaveLength(1);
		expect(JSON.stringify(fp)).not.toContain(sentinel);
	});
});
describe("physical request observations", () => {
	it("records separate provider attempts with cache breakdowns and unknown counts omitted", async () => {
		let n = 0;
		const model = wrapLanguageModel({
			model: {
				specificationVersion: "v4",
				provider: "example",
				modelId: "example-model",
				supportedUrls: {},
				doGenerate: async () => {
					n++;
					return {
						content: [],
						finishReason: { unified: "stop", raw: "stop" },
						warnings: [],
						usage:
							n === 1
								? {
										inputTokens: {
											total: 100,
											cacheRead: 70,
											cacheWrite: 10,
											noCache: 20,
										},
										outputTokens: {
											total: 5,
											text: 5,
											reasoning: undefined,
										},
									}
								: {
										inputTokens: {
											total: undefined,
											noCache: undefined,
											cacheRead: undefined,
											cacheWrite: undefined,
										},
										outputTokens: {
											total: undefined,
											text: undefined,
											reasoning: undefined,
										},
									},
					};
				},
				doStream: async () => {
					throw new Error("unused");
				},
			},
			middleware: createRequestObservationMiddleware(),
		});
		const observed = await observeModelRequests(
			{ iteration: 3, activityAttempt: 2 },
			async () => {
				await model.doGenerate({ prompt: [], maxOutputTokens: 10 });
				await model.doGenerate({ prompt: [], maxOutputTokens: 10 });
			},
		);
		expect(observed.requests).toHaveLength(2);
		expect(observed.requests[0]).toMatchObject({
			iteration: 3,
			activityAttempt: 2,
			request: 1,
			cacheReadTokens: 70,
			cacheWriteTokens: 10,
			uncachedInputTokens: 20,
			outputTokens: 5,
		});
		expect(observed.requests[1].cacheReadTokens).toBeUndefined();
		expect(observed.requests[1].outputTokens).toBeUndefined();
	});
	it("refines the plan wire shape and separates an unauthorized resend", async () => {
		const observed = await observeModelRequests(
			{ iteration: 1, activityAttempt: 1 },
			async () => {
				setRequestAdditions({
					systemCharacters: 0,
					callerToolNames: [],
					skillToolNames: ["load_skill"],
				});
				const middleware = createRequestObservationMiddleware();
				await middleware.wrapGenerate?.({
					params: { prompt: [] },
					model: { provider: "plan", modelId: "example" },
					doGenerate: async () => {
						const body = {
							model: "example",
							instructions: sentinel,
							input: [{ role: "user", content: sentinel }],
							tools: [
								{
									type: "function",
									function: {
										name: "load_skill",
										parameters: { type: "object" },
									},
								},
							],
						};
						observeRequestWire(body, "example-route", sentinel);
						observeRequestWire(body, "example-route", sentinel);
						return {
							usage: {
								inputTokens: { cacheRead: 3 },
								outputTokens: { total: 1 },
							},
						};
					},
				} as never);
			},
		);
		expect(observed.requests).toHaveLength(2);
		expect(
			observed.requests.map((r) => ({
				toolNames: r.toolNames,
				skillToolNames: r.skillToolNames,
			})),
		).toEqual([
			{ toolNames: ["load_skill"], skillToolNames: ["load_skill"] },
			{ toolNames: ["load_skill"], skillToolNames: ["load_skill"] },
		]);
		expect(observed.requests[0].cacheReadTokens).toBeUndefined();
		expect(observed.requests[1].cacheReadTokens).toBe(3);
		expect(observed.requests[1].fingerprint.boundary).toBe("wire");
		expect(JSON.stringify(observed.requests)).not.toContain(sentinel);
	});
});

it("observes SDK retries as distinct physical requests", async () => {
	let calls = 0;
	const model = wrapLanguageModel({
		model: {
			specificationVersion: "v4",
			provider: "example",
			modelId: "example",
			supportedUrls: {},
			doGenerate: async () => {
				if (++calls === 1) {
					throw new APICallError({
						message: "transient",
						url: "https://example.com",
						requestBodyValues: {},
						statusCode: 503,
						isRetryable: true,
					});
				}
				return {
					content: [{ type: "text", text: "Done" }],
					finishReason: { unified: "stop", raw: "stop" },
					warnings: [],
					usage: {
						inputTokens: {
							total: 10,
							noCache: 10,
							cacheRead: 0,
							cacheWrite: undefined,
						},
						outputTokens: {
							total: 1,
							text: 1,
							reasoning: undefined,
						},
					},
				};
			},
			doStream: async () => {
				throw new Error("unused");
			},
		},
		middleware: createRequestObservationMiddleware(),
	});
	const observed = await observeModelRequests(
		{ iteration: 1, activityAttempt: 1 },
		() => generateText({ model, prompt: "Example", maxRetries: 1 }),
	);
	expect(observed.requests).toHaveLength(2);
	expect(observed.requests.map((request) => request.request)).toEqual([1, 2]);
	expect(observed.requests[0].inputTokens).toBeUndefined();
	expect(observed.requests[1]).toMatchObject({
		inputTokens: 10,
		cacheReadTokens: 0,
		uncachedInputTokens: 10,
		outputTokens: 1,
	});
});

it("compares message roles and separates a moved cache marker from content changes", () => {
	const plain = { role: "user", content: "Example" };
	const marked = {
		...plain,
		providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
	};
	const first = createRequestFingerprint({ ...request, prompt: [marked] });
	const moved = createRequestFingerprint({
		...request,
		prompt: [
			plain,
			{
				role: "assistant",
				content: "Answer",
				providerOptions: marked.providerOptions,
			},
		],
	});
	expect(first.messages[0].hash).toBe(moved.messages[0].hash);
	expect(
		firstRequestChange(
			createRequestFingerprint({ ...request, prompt: [plain] }),
			createRequestFingerprint({
				...request,
				prompt: [{ ...plain, role: "assistant" }],
			}),
		),
	).toEqual({ section: "messages", index: 0 });
});
it("ignores cacheControl named inside tool arguments when locating markers", () => {
	const fingerprint = createRequestFingerprint({
		...request,
		prompt: [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						input: { cacheControl: { type: "ephemeral" } },
					},
				],
			},
		],
	});
	expect(fingerprint.cacheMarkers).toEqual([]);
});

it("sizes activity-only system and tool additions independently of the conversation", async () => {
	const model = wrapLanguageModel({
		model: {
			specificationVersion: "v4",
			provider: "example",
			modelId: "example",
			supportedUrls: {},
			doGenerate: async () => ({
				content: [],
				finishReason: { unified: "stop", raw: "stop" },
				warnings: [],
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: undefined,
						cacheWrite: undefined,
					},
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
			}),
			doStream: async () => {
				throw new Error("unused");
			},
		},
		middleware: createRequestObservationMiddleware(),
	});
	const observed = await observeModelRequests(
		{ iteration: 1, activityAttempt: 1 },
		async () => {
			setRequestAdditions({
				systemCharacters: 300,
				callerToolNames: ["caller"],
			});
			await model.doGenerate({
				prompt: [
					{
						role: "user",
						content: [{ type: "text", text: "Example" }],
					},
				],
				tools: [
					{
						type: "function",
						name: "caller",
						inputSchema: { type: "object" },
					},
					{
						type: "function",
						name: "skill",
						description: "s".repeat(300),
						inputSchema: { type: "object" },
					},
				],
			});
		},
	);
	expect(observed.extraInputTokens).toBeGreaterThan(250);
});

it("fingerprints a multi-megabyte image within 250 ms using binary byte counts", () => {
	const image = new Uint8Array(3_750_000).fill(42);
	const start = performance.now();
	const fingerprint = createRequestFingerprint({
		...request,
		prompt: [
			{
				role: "user",
				content: [
					{ type: "file", data: image, mediaType: "image/png" },
				],
			},
		],
	});
	const elapsed = performance.now() - start;
	process.stderr.write(
		`[request-observation] 3.75 MB fingerprint: ${elapsed.toFixed(2)} ms\n`,
	);
	expect(elapsed).toBeLessThan(250);
	expect(fingerprint.messages[0].bytes).toBeGreaterThanOrEqual(
		image.byteLength,
	);
	expect(fingerprint.messages[0].bytes).toBeLessThan(
		image.byteLength + 1_000,
	);
	expect(JSON.stringify(fingerprint)).not.toContain('"0":42');
});
it.each(["generate", "stream"])(
	"continues %s when request observation throws",
	async (mode) => {
		const params = {
			prompt: [
				{
					role: "user",
					content: {
						toJSON() {
							throw new Error("observer sentinel");
						},
					},
				},
			],
		};
		const sent = vi.fn(async () =>
			mode === "generate"
				? { usage: {}, content: [] }
				: {
						stream: new ReadableStream({
							start(controller) {
								controller.enqueue({
									type: "finish",
									usage: {},
								});
								controller.close();
							},
						}),
					},
		);
		const middleware = createRequestObservationMiddleware();
		const observed = await observeModelRequests(
			{ iteration: 1, activityAttempt: 1 },
			async () =>
				mode === "generate"
					? middleware.wrapGenerate?.({
							params,
							model: { modelId: "example", provider: "example" },
							doGenerate: sent,
						} as never)
					: middleware.wrapStream?.({
							params,
							model: { modelId: "example", provider: "example" },
							doStream: sent,
						} as never),
		);
		expect(sent).toHaveBeenCalledTimes(1);
		expect(observed.requests).toEqual([]);
		expect(observed.result).toBeDefined();
	},
);
it("passes the model request and response through with no observer installed", async () => {
	const params = {
		prompt: [
			{
				role: "user",
				content: {
					toJSON() {
						throw new Error("observation should be inactive");
					},
				},
			},
		],
	};
	const result = { content: [{ type: "text", text: "Example" }], usage: {} };
	const doGenerate = vi.fn(async () => result);
	const middleware = createRequestObservationMiddleware();
	expect(
		await middleware.wrapGenerate?.({
			params,
			model: { modelId: "example", provider: "example" },
			doGenerate,
		} as never),
	).toBe(result);
	expect(doGenerate).toHaveBeenCalledTimes(1);
});

it.each([
	new Uint8Array(128),
	new Uint16Array(new ArrayBuffer(512), 32, 64),
	new DataView(new ArrayBuffer(512), 32, 128),
	new ArrayBuffer(128),
	Buffer.alloc(128),
])("counts binary view bytes without numeric-key serialization", (binary) => {
	const fingerprint = createRequestFingerprint({
		...request,
		prompt: [{ role: "user", content: [{ type: "file", data: binary }] }],
	});
	expect(fingerprint.messages[0].bytes).toBeGreaterThanOrEqual(
		binary.byteLength,
	);
	expect(fingerprint.messages[0].bytes).toBeLessThan(binary.byteLength + 400);
	expect(
		createRequestFingerprint({
			...request,
			prompt: [
				{ role: "user", content: [{ type: "file", data: binary }] },
			],
		}),
	).toEqual(fingerprint);
});
it("reports the active observation scope and restores its caller", async () => {
	expect(hasActiveRequestObservation()).toBe(false);
	await observeModelRequests(
		{ iteration: 1, activityAttempt: 1 },
		async () => {
			expect(hasActiveRequestObservation()).toBe(true);
		},
	);
	expect(hasActiveRequestObservation()).toBe(false);
});
it("preserves the model error when the diagnostic failure callback throws", async () => {
	const error = new Error("model failure");
	await expect(
		observeModelRequests(
			{ iteration: 1, activityAttempt: 1 },
			async () => {
				throw error;
			},
			() => {
				throw new Error("observer failure");
			},
		),
	).rejects.toBe(error);
});
it("forwards stream chunks if usage inspection throws", async () => {
	const chunk = {
		type: "finish",
		get usage() {
			throw new Error("usage observation failed");
		},
	};
	const chunks: unknown[] = [];
	await observeModelRequests(
		{ iteration: 1, activityAttempt: 1 },
		async () => {
			const result =
				await createRequestObservationMiddleware().wrapStream?.({
					params: { prompt: [] },
					model: { modelId: "example", provider: "example" },
					doStream: async () => ({
						stream: new ReadableStream({
							start(controller) {
								controller.enqueue(chunk);
								controller.close();
							},
						}),
					}),
				} as never);
			if (result) {
				for await (const value of result.stream) {
					chunks.push(value);
				}
			}
		},
	);
	expect(chunks).toEqual([chunk]);
});

it("pairs physical tool hashes with names and recorded skill bindings without changing the request", async () => {
	const params = {
		prompt: [],
		tools: [
			{
				type: "function",
				name: "example",
				inputSchema: { type: "object" },
			},
			{
				type: "function",
				name: "load_skill",
				inputSchema: { type: "object" },
			},
		],
	};
	const model = { modelId: "example", provider: "example" };
	const fingerprint = createRequestFingerprint({
		modelId: model.modelId,
		route: { provider: model.provider, scope: undefined },
		...params,
	});
	const before = JSON.stringify(params);
	const sent: unknown[] = [];
	const result = { usage: {}, content: [] };
	const run = () =>
		createRequestObservationMiddleware().wrapGenerate?.({
			params,
			model,
			doGenerate: async () => {
				sent.push(params);
				return result;
			},
		} as never);
	const plain = await run();
	const observed = await observeModelRequests(
		{ iteration: 1, activityAttempt: 1 },
		async () => {
			setRequestAdditions({
				systemCharacters: 0,
				callerToolNames: ["example"],
				skillToolNames: ["load_skill"],
			});
			return run();
		},
	);
	expect(observed.result).toBe(plain);
	expect(sent).toEqual([params, params]);
	expect(JSON.stringify(params)).toBe(before);
	expect(observed.requests[0]).toMatchObject({
		toolNames: ["example", "load_skill"],
		skillToolNames: ["load_skill"],
		fingerprint,
	});
});
