import { readFileSync } from "node:fs";
import { createOpenAI } from "@ai-sdk/openai";
import { createChatGptPlanFetch } from "@repo/agent-types/chatgpt-plan-fetch";
import {
	APICallError,
	createGateway,
	extractReasoningMiddleware,
	generateObject,
	wrapLanguageModel,
	zodSchema,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyDatabricksChatBodyCompat } from "../lib/databricks-compat";
import {
	createStrictJsonSchemaMiddleware,
	isStrictJsonSchemaCompatible,
	toStrictJsonSchema,
} from "../lib/strict-json-schema-middleware";
import {
	STRUCTURED_OUTPUT_CAPABILITIES,
	structuredOutputCapabilityFor,
} from "../lib/structured-output-capabilities";
import { applyAzureChatBodyCompat, getModel } from "../model-factory";

const capability = structuredOutputCapabilityFor(
	"OPENAI_DIRECT",
	false,
	"example",
);
const schema = z.object({ title: z.string(), note: z.string().optional() });
const reply = (text = '{"title":"Example"}') => ({
	content: [{ type: "text" as const, text }],
	finishReason: { unified: "stop" as const, raw: "stop" },
	usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
	warnings: [],
});
const rejection = (message: string, statusCode = 400, responseBody?: string) =>
	new APICallError({
		message,
		statusCode,
		responseBody,
		url: "https://example.com/v1/chat/completions",
		requestBodyValues: { apiKey: "example-secret-not-for-logs" },
	});
const wrap = (model: MockLanguageModelV4) =>
	wrapLanguageModel({
		model,
		middleware: createStrictJsonSchemaMiddleware(capability),
	});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("strict rejection fallback", () => {
	it.each([
		[
			"Invalid schema for response_format 'Example': required must include note",
			undefined,
		],
		[
			"Bad Request",
			'{"error":{"message":"INVALID_PARAMETER_VALUE: JSON schema anyOf is not supported"}}',
		],
		[
			"response_format of type json_schema is not supported with this model",
			undefined,
		],
		["Unsupported parameter: strict", undefined],
		["Invalid response format", undefined],
	])(
		"retries original params and caches rejection: %s",
		async (message, body) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const model = new MockLanguageModelV4({
				modelId: `fallback-${message.length}-${body?.length ?? 0}`,
				doGenerate: async (params) => {
					if (params.providerOptions?.openai?.strictJsonSchema) {
						throw rejection(message, 400, body);
					}
					return reply();
				},
			});
			const original = await zodSchema(schema).jsonSchema;
			const params = {
				prompt: [],
				responseFormat: { type: "json" as const, schema: original },
				providerOptions: {
					openai: { reasoningEffort: "low" },
					example: { keep: true },
				},
			};
			await expect(wrap(model).doGenerate(params)).resolves.toMatchObject(
				reply(),
			);
			await wrap(model).doGenerate(params);
			expect(model.doGenerateCalls).toHaveLength(3);
			expect(model.doGenerateCalls[1]).toEqual({
				...params,
				providerOptions: {
					...params.providerOptions,
					openai: { reasoningEffort: "low", strictJsonSchema: false },
				},
			});
			expect(model.doGenerateCalls[2]).toEqual(model.doGenerateCalls[1]);
			expect(params.responseFormat.schema).toBe(original);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.join(" ")).toContain(model.modelId);
			expect(warn.mock.calls[0]?.join(" ")).toContain(model.provider);
			expect(warn.mock.calls[0]?.join(" ")).not.toContain(message);
			expect(JSON.stringify(warn.mock.calls)).not.toContain(
				"example-secret-not-for-logs",
			);
		},
	);
	it.each([
		["gateway", 400],
		["gateway", 422],
		["chat", 400],
		["chat", 422],
		["responses", 400],
		["responses", 422],
	] as const)(
		"real %s client retries a strict-schema %i once and remembers it",
		async (route, status) => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const bodies: Record<string, any>[] = [];
			const json = (value: unknown, status = 200) =>
				new Response(JSON.stringify(value), {
					status,
					headers: { "content-type": "application/json" },
				});
			const fetch: typeof globalThis.fetch = async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				bodies.push(body);
				const strict =
					route === "gateway"
						? body.providerOptions.openai.strictJsonSchema
						: route === "chat"
							? body.response_format.json_schema.strict
							: body.text.format.strict;
				if (strict) {
					return json(
						{
							error: {
								message:
									status === 400
										? "Invalid schema for response_format 'Example': required must include note"
										: "Unknown parameter: strict in response_format",
								type: "invalid_request_error",
								param: "response_format",
								code: null,
							},
						},
						status,
					);
				}
				if (route === "gateway") {
					return json(reply());
				}
				if (route === "chat") {
					return json({
						id: "example",
						created: 1,
						model: "example-model",
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: '{"title":"Example"}',
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							total_tokens: 2,
						},
					});
				}
				return json({
					id: "example",
					created_at: 1,
					model: "example-model",
					object: "response",
					status: "completed",
					output: [
						{
							type: "message",
							id: "example-message",
							role: "assistant",
							status: "completed",
							content: [
								{
									type: "output_text",
									text: '{"title":"Example"}',
									annotations: [],
								},
							],
						},
					],
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				});
			};
			const client = createOpenAI({
				apiKey: "example-key",
				baseURL: "https://example.com/v1",
				fetch,
			});
			const id = `real-client-${route}-${status}`;
			const baseModel =
				route === "gateway"
					? createGateway({ apiKey: "example-key", fetch })(
							`openai/${id}`,
						)
					: route === "chat"
						? client.chat(id)
						: client.responses(id);
			const model = wrapLanguageModel({
				model: baseModel,
				middleware: createStrictJsonSchemaMiddleware(capability, route),
			});
			for (let call = 0; call < 2; call++) {
				await expect(
					generateObject({
						model,
						schema,
						prompt: "Example",
						maxRetries: 0,
					}),
				).resolves.toMatchObject({ object: { title: "Example" } });
			}
			const formats = bodies.map((body) =>
				route === "gateway"
					? {
							strict: body.providerOptions.openai
								.strictJsonSchema,
							schema: body.responseFormat.schema,
						}
					: route === "chat"
						? body.response_format.json_schema
						: body.text.format,
			);
			expect(formats.map((format) => format.strict)).toEqual([
				true,
				false,
				false,
			]);
			expect(formats[0]?.schema.required).toEqual(["title", "note"]);
			expect(formats[1]?.schema).toEqual(
				await zodSchema(schema).jsonSchema,
			);
			expect(formats[2]?.schema).toEqual(formats[1]?.schema);
		},
	);

	it.each([
		"gateway",
		"chat",
		"responses",
		"azure-chat",
		"chatgpt-plan",
	] as const)(
		"audits the real %s client error shape for an upstream schema 400",
		async (route) => {
			const message = "Invalid schema for response_format";
			const responseBody = JSON.stringify({
				error: {
					message,
					type: "invalid_request_error",
					param: "response_format",
					code: null,
				},
			});
			const fetch = vi.fn(
				async () =>
					new Response(responseBody, {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			);
			const client = createOpenAI({
				apiKey: "example-key",
				baseURL: "https://example.com/v1",
				fetch,
			});
			const model =
				route === "gateway"
					? createGateway({ apiKey: "example-key", fetch })(
							"openai/error-shape",
						)
					: route === "chat"
						? client.chat("error-shape")
						: route === "responses"
							? client.responses("error-shape")
							: route === "azure-chat"
								? (() => {
										vi.stubGlobal("fetch", fetch);
										return getModel("error-shape", {
											apiKey: "example-key",
											provider: "AZURE_AI_FOUNDRY",
											baseUrl:
												"https://example.openai.azure.com",
										});
									})()
								: createOpenAI({
										apiKey: "example-plan",
										baseURL: "https://api.openai.com/v1",
										fetch: createChatGptPlanFetch({
											getAccessToken: async () =>
												"example-token",
											baseFetch: fetch,
										}),
									}).responses("error-shape");
			// Explicit opt-out lets the factory's Azure error surface without fallback.
			await expect(
				generateObject({
					model,
					schema,
					prompt: "Example",
					maxRetries: 0,
					providerOptions: { openai: { strictJsonSchema: false } },
				}),
			).rejects.toMatchObject(
				route === "gateway"
					? {
							name: "GatewayInvalidRequestError",
							statusCode: 400,
							message,
							cause: {
								name: "AI_APICallError",
								statusCode: 400,
								message: responseBody,
								responseBody,
							},
						}
					: {
							name: "AI_APICallError",
							statusCode: 400,
							message,
							responseBody,
						},
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("omits provider error text and endpoint scope from its fallback warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = new MockLanguageModelV4({
			modelId: "safe-warning",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw rejection(
						"Invalid response_format at https://example.com/private?api_key=example-secret",
					);
				}
				return reply();
			},
		});
		await wrapLanguageModel({
			model,
			middleware: createStrictJsonSchemaMiddleware(
				capability,
				"OPENAI_DIRECT",
				"example-endpoint-scope",
			),
		}).doGenerate({
			prompt: [],
			responseFormat: {
				type: "json",
				schema: await zodSchema(schema).jsonSchema,
			},
		});
		expect(warn.mock.calls).toEqual([
			[
				"[AI] Strict structured output rejected; using non-strict. Provider: OPENAI_DIRECT; model: safe-warning",
			],
		]);
	});

	it("does not retry a real gateway 422 whose body the gateway cannot parse", async () => {
		// The gateway rewrites an unrecognised error body as "Invalid error
		// response format: ...", which must not read as a schema rejection.
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						detail: [
							{
								type: "missing",
								loc: ["body", "messages"],
								msg: "Field required",
								input: {
									response_format: { type: "json_schema" },
								},
							},
						],
					}),
					{
						status: 422,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const model = wrapLanguageModel({
			model: createGateway({ apiKey: "example-key", fetch })(
				"openai/unparseable-error",
			),
			middleware: createStrictJsonSchemaMiddleware(capability),
		});
		await expect(
			model.doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).rejects.toMatchObject({
			message: expect.stringContaining("Invalid error response format"),
			statusCode: 422,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"deeply nested",
			`${'{"error":'.repeat(5000)}"Invalid response_format"${"}".repeat(5000)}`,
		],
		[
			"very wide",
			JSON.stringify({
				detail: [
					...Array(150_000).fill(null),
					"Invalid response_format",
				],
			}),
		],
	])("bounds traversal of a %s error body", async (_shape, body) => {
		const error = rejection("Bad Request", 400, body);
		const model = new MockLanguageModelV4({
			modelId: "deep-error-body",
			doGenerate: async () => {
				throw error;
			},
		});
		await expect(
			wrap(model).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).rejects.toBe(error);
		expect(model.doGenerateCalls).toHaveLength(1);
	});

	it("does not retry a real gateway context-length 400", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "maximum context length exceeded",
							type: "invalid_request_error",
						},
					}),
					{
						status: 400,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const model = wrapLanguageModel({
			model: createGateway({ apiKey: "example-key", fetch })(
				"openai/context-length",
			),
			middleware: createStrictJsonSchemaMiddleware(capability),
		});
		await expect(
			model.doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).rejects.toMatchObject({
			statusCode: 400,
			cause: { statusCode: 400 },
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("finds status and schema text across untyped causes without following cycles", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const error: Record<string, unknown> = {
			statusCode: 422,
			message: "Bad request",
		};
		error.cause = {
			responseBody: "Unsupported response_format",
			cause: error,
		};
		const model = new MockLanguageModelV4({
			modelId: "cyclic-schema",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw error;
				}
				return reply();
			},
		});
		await expect(
			wrap(model).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).resolves.toMatchObject(reply());
		expect(model.doGenerateCalls).toHaveLength(2);
	});

	it.each([
		[
			"status and schema words from different links",
			{
				statusCode: 400,
				message: "Invalid 'temperature': unsupported value",
				cause: {
					message: "wrapped",
					cause: {
						message: "strict mode must be enabled for this tool",
					},
				},
			},
		],
		[
			"a 422 that echoes the strict request back under input",
			rejection(
				"Unprocessable Entity",
				422,
				JSON.stringify({
					detail: [
						{
							type: "missing",
							loc: ["body", "messages"],
							msg: "Field required",
							input: {
								response_format: {
									type: "json_schema",
									json_schema: { strict: true },
								},
							},
						},
					],
				}),
			),
		],
	])("does not retry %s", async (_label, error) => {
		const model = new MockLanguageModelV4({
			modelId: `not-a-rejection-${_label.length}`,
			doGenerate: async () => {
				throw error;
			},
		});
		await expect(
			wrap(model).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).rejects.toBe(error);
		expect(model.doGenerateCalls).toHaveLength(1);
	});

	it("retries a 422 whose validation error locates the strict flag", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = new MockLanguageModelV4({
			modelId: "extra-forbidden-strict",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw rejection(
						"Unprocessable Entity",
						422,
						JSON.stringify({
							detail: [
								{
									type: "extra_forbidden",
									loc: [
										"body",
										"response_format",
										"json_schema",
										"strict",
									],
									msg: "Extra inputs are not permitted",
									input: true,
								},
							],
						}),
					);
				}
				return reply();
			},
		});
		await expect(
			wrap(model).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).resolves.toMatchObject(reply());
		expect(model.doGenerateCalls).toHaveLength(2);
	});

	it("getModel does not throw on an unparseable Databricks base URL", () => {
		expect(() =>
			getModel("example-endpoint", {
				apiKey: "example-key",
				provider: "DATABRICKS",
				baseUrl: "not a url",
			}),
		).not.toThrow();
	});

	it("terminates unrelated cyclic and excessively deep cause chains", async () => {
		const cyclic: Record<string, unknown> = {
			statusCode: 400,
			message: "context length exceeded",
		};
		cyclic.cause = cyclic;
		let deep: unknown = {
			statusCode: 400,
			message: "Invalid response_format",
		};
		for (let depth = 0; depth < 20; depth++) {
			deep = { cause: deep };
		}
		for (const [index, error] of [cyclic, deep].entries()) {
			const model = new MockLanguageModelV4({
				modelId: `bounded-causes-${index}`,
				doGenerate: async () => {
					throw error;
				},
			});
			await expect(
				wrap(model).doGenerate({
					prompt: [],
					responseFormat: {
						type: "json",
						schema: await zodSchema(schema).jsonSchema,
					},
				}),
			).rejects.toBe(error);
			expect(model.doGenerateCalls).toHaveLength(1);
		}
	});

	it("isolates rejection memory by endpoint scope", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = new MockLanguageModelV4({
			modelId: "endpoint-cache",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw rejection("Invalid response_format");
				}
				return reply();
			},
		});
		const params = {
			prompt: [],
			responseFormat: {
				type: "json" as const,
				schema: await zodSchema(schema).jsonSchema,
			},
		};
		for (const scope of [
			"example-endpoint-a",
			"example-endpoint-a",
			"example-endpoint-b",
		]) {
			await wrapLanguageModel({
				model,
				middleware: createStrictJsonSchemaMiddleware(
					capability,
					"AZURE_AI_FOUNDRY",
					scope,
				),
			}).doGenerate(params);
		}
		expect(
			model.doGenerateCalls.map(
				(call) => call.providerOptions?.openai?.strictJsonSchema,
			),
		).toEqual([true, false, false, true, false]);
	});

	it("retries strict mode after one hour without refreshing the TTL on cache hits", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = new MockLanguageModelV4({
			modelId: "ttl-cache",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw rejection("Invalid response_format");
				}
				return reply();
			},
		});
		const params = {
			prompt: [],
			responseFormat: {
				type: "json" as const,
				schema: await zodSchema(schema).jsonSchema,
			},
		};
		await wrap(model).doGenerate(params);
		vi.setSystemTime(new Date("2026-01-01T00:59:59.999Z"));
		await wrap(model).doGenerate(params);
		vi.setSystemTime(new Date("2026-01-01T01:00:00Z"));
		await wrap(model).doGenerate(params);
		expect(
			model.doGenerateCalls.map(
				(call) => call.providerOptions?.openai?.strictJsonSchema,
			),
		).toEqual([true, false, false, true, false]);
	});

	it("degrades an incorrect Databricks strict row through the real OpenAI-compatible SDK", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const bodies: Record<string, any>[] = [];
		const client = createOpenAI({
			apiKey: "example-key",
			baseURL: "https://example.com/v1",
			fetch: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				bodies.push(body);
				if (body.response_format.json_schema.strict) {
					return new Response(
						JSON.stringify({
							error: {
								message:
									"INVALID_PARAMETER_VALUE: JSON schema anyOf is not supported",
								type: "invalid_request_error",
							},
						}),
						{
							status: 400,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return new Response(
					JSON.stringify({
						id: "example",
						created: 1,
						model: "example-model",
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: '{"title":"Example"}',
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							total_tokens: 2,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		const model = wrapLanguageModel({
			model: client.chat("incorrect-row-example"),
			middleware: createStrictJsonSchemaMiddleware(
				{
					...STRUCTURED_OUTPUT_CAPABILITIES.DATABRICKS,
					mode: "strict",
				},
				"DATABRICKS",
			),
		});
		for (let call = 0; call < 2; call++) {
			const result = await generateObject({
				model,
				schema,
				prompt: "Example",
				maxRetries: 0,
			});
			expect(result.object).toEqual({ title: "Example" });
		}
		expect(
			bodies.map((body) => body.response_format.json_schema.strict),
		).toEqual([true, false, false]);
		expect(bodies[0]?.response_format.json_schema.schema.required).toEqual([
			"title",
			"note",
		]);
		expect(bodies[1]?.response_format.json_schema.schema).toEqual(
			await zodSchema(schema).jsonSchema,
		);
		expect(bodies[2]?.response_format.json_schema.schema).toEqual(
			bodies[1]?.response_format.json_schema.schema,
		);
	});

	it("does not repair the fallback reply or retry its failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = new MockLanguageModelV4({
			modelId: "fallback-null",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw rejection("Invalid schema for response_format");
				}
				return reply('{"title":"Example","note":null}');
			},
		});
		await expect(
			generateObject({
				model: wrap(model),
				schema,
				prompt: "Example",
				maxRetries: 0,
			}),
		).rejects.toThrow();
		expect(model.doGenerateCalls).toHaveLength(2);
		const failure = rejection("Invalid schema for response_format");
		const failed = new MockLanguageModelV4({
			modelId: "fallback-fails",
			doGenerate: async () => {
				throw failure;
			},
		});
		await expect(
			wrap(failed).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).rejects.toBe(failure);
		expect(failed.doGenerateCalls).toHaveLength(2);
	});
	it.each([
		rejection("maximum context length exceeded"),
		rejection("Invalid schema for response_format", 429),
		new Error("Invalid schema for response_format"),
	])("propagates unrelated errors unchanged: %s", async (error) => {
		const model = new MockLanguageModelV4({
			modelId: `no-retry-${error.message}`,
			doGenerate: async () => {
				throw error;
			},
		});
		await expect(
			wrap(model).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: await zodSchema(schema).jsonSchema,
				},
			}),
		).rejects.toBe(error);
		expect(model.doGenerateCalls).toHaveLength(1);
	});
	it("bounds rejection memory to 500 oldest-first entries and isolates schemas/models/providers", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const model = new MockLanguageModelV4({
			modelId: "bounded-cache",
			doGenerate: async (params) => {
				if (params.providerOptions?.openai?.strictJsonSchema) {
					throw rejection("Invalid schema for response_format");
				}
				return reply();
			},
		});
		const call = (index: number, target = model) =>
			wrap(target).doGenerate({
				prompt: [],
				responseFormat: {
					type: "json",
					schema: {
						type: "object",
						properties: { [`note${index}`]: { type: "string" } },
					},
				},
			});
		for (let index = 0; index <= 500; index++) {
			await call(index);
		}
		expect(model.doGenerateCalls).toHaveLength(1002);
		await call(500);
		expect(model.doGenerateCalls).toHaveLength(1003);
		await call(0);
		expect(model.doGenerateCalls).toHaveLength(1005);
		const other = new MockLanguageModelV4({
			modelId: "other-model",
			doGenerate: model.doGenerate,
		});
		await call(0, other);
		expect(other.doGenerateCalls).toHaveLength(2);
		const otherProvider = new MockLanguageModelV4({
			modelId: model.modelId,
			provider: "other-provider",
			doGenerate: model.doGenerate,
		});
		await call(0, otherProvider);
		expect(otherProvider.doGenerateCalls).toHaveLength(2);
	});
});

describe("supported constraints and limits", () => {
	it("retains supported value constraints and hints stripped string lengths", () => {
		const converted = toStrictJsonSchema({
			type: "object",
			required: ["note", "score", "rows"],
			title: "Example",
			$schema: "example",
			properties: {
				note: {
					type: "string",
					pattern: "^a",
					format: "email",
					minLength: 1,
					maxLength: 300,
					description: "Note",
					default: "a",
					examples: ["a"],
				},
				score: {
					type: "number",
					minimum: 0,
					maximum: 10,
					exclusiveMinimum: -1,
					exclusiveMaximum: 11,
					multipleOf: 0.5,
				},
				rows: {
					type: "array",
					items: { type: "string", format: "uri" },
					minItems: 1,
					maxItems: 3,
					uniqueItems: true,
				},
			},
		});
		expect(converted).toEqual({
			type: "object",
			required: ["note", "score", "rows"],
			additionalProperties: false,
			properties: {
				note: {
					type: "string",
					pattern: "^a",
					format: "email",
					description:
						"Note (at least 1 character; at most 300 characters)",
				},
				score: {
					type: "number",
					minimum: 0,
					maximum: 10,
					exclusiveMinimum: -1,
					exclusiveMaximum: 11,
					multipleOf: 0.5,
				},
				rows: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 3,
				},
			},
		});
	});
	it.each([
		"date-time",
		"time",
		"date",
		"duration",
		"email",
		"hostname",
		"ipv4",
		"ipv6",
		"uuid",
	])("keeps supported format %s", (format) => {
		expect(
			toStrictJsonSchema({
				type: "object",
				properties: { value: { type: "string", format } },
				required: ["value"],
			}),
		).toHaveProperty("properties.value.format", format);
	});
	it.each([
		"minLength",
		"maxLength",
		"default",
		"examples",
		"uniqueItems",
		"title",
		"$schema",
		"format",
	])("fetch guards reject unsupported %s", (keyword) => {
		const strict = {
			type: "object",
			properties: {
				value: {
					type: "string",
					[keyword]: keyword === "format" ? "uri" : 1,
				},
			},
			required: ["value"],
			additionalProperties: false,
		};
		expect(isStrictJsonSchemaCompatible(strict)).toBe(false);
		for (const guard of [
			applyAzureChatBodyCompat,
			applyDatabricksChatBodyCompat,
		]) {
			const body = {
				response_format: {
					type: "json_schema",
					json_schema: { strict: true, schema: strict },
				},
			};
			guard(body, "example");
			expect(body.response_format.json_schema.strict).toBe(false);
		}
	});
	const nested = (levels: number): Record<string, unknown> =>
		levels === 1
			? { type: "object", properties: { value: { type: "string" } } }
			: {
					type: "object",
					properties: {
						child: { type: "array", items: nested(levels - 1) },
					},
				};
	it("counts object depth through optional anyOf wrappers and arrays", () => {
		expect(toStrictJsonSchema(nested(10))).toBeDefined();
		expect(toStrictJsonSchema(nested(11))).toBeUndefined();
	});
	it("counts depth through local refs", () => {
		const schemaWithRef = {
			...nested(2),
			properties: { child: { $ref: "#/$defs/deep" } },
			$defs: { deep: nested(10) },
		};
		expect(toStrictJsonSchema(schemaWithRef)).toBeUndefined();
	});
	it.each([
		[
			"properties",
			(n: number) => ({
				type: "object",
				properties: Object.fromEntries(
					Array.from({ length: n }, (_, i) => [
						`p${i}`,
						{ type: "string" },
					]),
				),
			}),
			5000,
		],
		[
			"enum values",
			(n: number) => ({
				type: "object",
				properties: {
					value: {
						type: "string",
						enum: Array.from({ length: n }, (_, i) => `e${i}`),
					},
				},
			}),
			1000,
		],
		[
			"string budget",
			(n: number) => ({
				type: "object",
				properties: { p: { const: "a".repeat(n - 1) } },
			}),
			120000,
		],
	] as const)("enforces inclusive %s limit", (_name, build, limit) => {
		expect(toStrictJsonSchema(build(limit))).toBeDefined();
		expect(toStrictJsonSchema(build(limit + 1))).toBeUndefined();
	});
	it("flattens a single-ref allOf without ref siblings", () => {
		expect(
			toStrictJsonSchema({
				type: "object",
				properties: {
					value: {
						description: "Example",
						allOf: [{ $ref: "#/$defs/entry" }],
					},
				},
				required: ["value"],
				$defs: { entry: { type: "string" } },
			}),
		).toHaveProperty("properties.value", { $ref: "#/$defs/entry" });
	});
});

describe("repair and composition", () => {
	it("repairs behind think tags in the real middleware order", async () => {
		const prefix = " \n<think>Example reasoning\n</think>\n ";
		const model = new MockLanguageModelV4({
			doGenerate: reply(`${prefix}{"title":"Example","note":null}`),
		});
		const raw = await wrap(model).doGenerate({
			prompt: [],
			responseFormat: {
				type: "json",
				schema: await zodSchema(schema).jsonSchema,
			},
		});
		expect(raw.content[0]).toMatchObject({
			text: `${prefix}{"title":"Example"}`,
		});
		const composed = wrapLanguageModel({
			model,
			middleware: [
				extractReasoningMiddleware({ tagName: "think" }),
				createStrictJsonSchemaMiddleware(capability),
			],
		});
		const result = await generateObject({
			model: composed,
			schema,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ title: "Example" });
	});
	it("respects closed union branch properties while repairing nulls", async () => {
		const union = z.object({
			choice: z.union([
				z.strictObject({ note: z.string().optional() }),
				z.strictObject({ other: z.number().optional() }),
			]),
		});
		const result = await generateObject({
			model: wrap(
				new MockLanguageModelV4({
					doGenerate: reply('{"choice":{"note":null}}'),
				}),
			),
			schema: union,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ choice: {} });
	});
	it("factory keeps strict middleware inside prompt steering and reasoning extraction", () => {
		const source = readFileSync(
			new URL("../model-factory.ts", import.meta.url),
			"utf8",
		);
		const factory = source.slice(
			source.indexOf("function wrapWithProviderMiddleware("),
			source.indexOf(
				"// Type assertion needed",
				source.indexOf("function wrapWithProviderMiddleware("),
			),
		);
		expect(
			factory.indexOf("createStrictJsonSchemaMiddleware("),
		).toBeGreaterThan(
			factory.indexOf("createPromptSteeredStructuredOutputMiddleware()"),
		);
		expect(
			factory.indexOf("createStrictJsonSchemaMiddleware("),
		).toBeGreaterThan(factory.indexOf("extractReasoningMiddleware({"));
	});
});
