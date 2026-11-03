/**
 * Local-development models (lib/local-models.ts).
 *
 * Only NODE_ENV=development with a task's FABRIC_LOCAL_<TASK>_* variables set
 * sends that task to the local server; every other environment — production
 * above all — resolves exactly as before, even with the variables present.
 * The harness is the one embeddings-only-key.test.ts uses: real ai-gateway
 * queries over an in-memory Prisma table.
 */

import { embed, experimental_decide } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const { orgRows, userRows, getModelForTask } = vi.hoisted(() => ({
	orgRows: [] as Record<string, unknown>[],
	userRows: [] as Record<string, unknown>[],
	getModelForTask: vi.fn(),
}));

vi.mock("../../database/prisma/client", () => {
	function matches(row: Row, where: Row): boolean {
		return Object.entries(where).every(([key, condition]) => {
			if (
				condition !== null &&
				typeof condition === "object" &&
				"not" in (condition as Row)
			) {
				return row[key] !== (condition as Row).not;
			}
			return row[key] === condition;
		});
	}
	const table = (rows: Row[]) => ({
		findFirst: vi.fn(async ({ where }: { where: Row }) => {
			const row = rows.find((r) => matches(r, where));
			return row ? { ...row } : null;
		}),
	});
	return {
		db: {
			cloudProviderConfig: table(orgRows),
			userCloudProviderConfig: table(userRows),
		},
	};
});

vi.mock("@repo/database", async () => {
	const gateway = await vi.importActual<Record<string, unknown>>(
		"../../database/prisma/queries/ai-gateway",
	);
	return {
		...gateway,
		GATEWAY_PROVIDERS: ["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"],
		getActiveModels: vi.fn(),
		getProviderModelIdForCanonical: vi.fn(),
		getModelForTask,
		getTaskDefaultModel: vi.fn(),
		// The organization's decision provider (staging #1367): none here, so
		// decisions go through the organization's gateway as before.
		getOrgDecisionProvider: vi.fn().mockResolvedValue(null),
		logAiUsageAsync: vi.fn(),
	};
});

vi.mock("@repo/config", async (importOriginal) => {
	const actual = await importOriginal<{ config: Record<string, unknown> }>();
	return {
		...actual,
		config: {
			...actual.config,
			ai: {
				enableGateway: false,
				gatewayApiKey: null,
				enabledProviders: [],
			},
		},
	};
});

vi.mock("@repo/payments", () => ({
	assertWithinAiUsageLimits: vi.fn(),
	getTenantAiGatewayBillingState: vi.fn(() => ({
		mode: "external_provider",
		headers: null,
	})),
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
	decryptApiKey: vi.fn((value: string) => {
		if (!value.startsWith("encrypted:")) {
			throw new Error("not an encrypted key");
		}
		return value.replace("encrypted:", "");
	}),
	decryptApiKeyMaybe: vi.fn((value: string) =>
		value.replace("encrypted:", ""),
	),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	AIProviderNotConfiguredError,
	getAIDecisionModelWithMetadata,
	getAIEmbeddingModelWithMetadata,
	getEmbeddingRAGProviderConfig,
	getSystemEmbeddingRAGProviderConfig,
	resolveModelWithProvider,
} from "../lib/dynamic-model-selector";
import {
	getLocalDecisionModel,
	getLocalEmbeddingModel,
	getLocalEmbeddingsConfig,
	getLocalModelConfig,
	localImageSize,
} from "../lib/local-models";

const CONTEXT = { userId: "user-1", organizationId: "org-1" };
const LOCAL_URL = "http://localhost:11434/v1";
const LOCAL_MODEL = "qwen3-embedding:4b";

const fetchMock = vi.fn();

function lastRequest() {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
	return {
		url: String(url),
		headers: new Headers(init.headers),
		body: JSON.parse(init.body as string) as Record<string, unknown>,
	};
}

function stubLocalEnv(nodeEnv: string) {
	vi.stubEnv("NODE_ENV", nodeEnv);
	vi.stubEnv("FABRIC_LOCAL_EMBEDDINGS_BASE_URL", LOCAL_URL);
	vi.stubEnv("FABRIC_LOCAL_EMBEDDINGS_MODEL", LOCAL_MODEL);
}

beforeEach(() => {
	orgRows.length = 0;
	userRows.length = 0;
	orgRows.push({
		id: "cpc_openai",
		organizationId: "org-1",
		provider: "OPENAI_DIRECT",
		enabled: true,
		isDefault: true,
		isEmbeddingProvider: true,
		purpose: "ALL",
		encryptedApiKey: "encrypted:sk-org",
		clientId: null,
		encryptedClientSecret: null,
		config: {},
	});
	getModelForTask.mockReset();
	getModelForTask.mockResolvedValue({
		providerModelId: "text-embedding-3-small",
		provider: "OPENAI_DIRECT",
		selectionSource: "system_default",
		model: { canonicalName: "text-embedding-3-small" },
	});
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () =>
		Response.json({
			object: "list",
			data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
			model: "m",
			usage: { prompt_tokens: 1, total_tokens: 1 },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("getLocalEmbeddingsConfig", () => {
	it.each(["production", "test", "staging", ""])(
		"is off under NODE_ENV=%j even with both variables set",
		(nodeEnv) => {
			stubLocalEnv(nodeEnv);
			expect(getLocalEmbeddingsConfig()).toBeNull();
		},
	);

	it("is off in development unless both variables are set", () => {
		expect(
			getLocalEmbeddingsConfig({
				NODE_ENV: "development",
				FABRIC_LOCAL_EMBEDDINGS_BASE_URL: LOCAL_URL,
			}),
		).toBeNull();
		expect(
			getLocalEmbeddingsConfig({
				NODE_ENV: "development",
				FABRIC_LOCAL_EMBEDDINGS_MODEL: LOCAL_MODEL,
			}),
		).toBeNull();
	});

	it("is on in development with both variables, without a trailing slash", () => {
		expect(
			getLocalEmbeddingsConfig({
				NODE_ENV: "development",
				FABRIC_LOCAL_EMBEDDINGS_BASE_URL: `${LOCAL_URL}/`,
				FABRIC_LOCAL_EMBEDDINGS_MODEL: ` ${LOCAL_MODEL} `,
			}),
		).toEqual({
			baseUrl: LOCAL_URL,
			model: LOCAL_MODEL,
			provider: "local server",
		});
	});

	it("refuses a base URL that is not http(s)", () => {
		const env = {
			NODE_ENV: "development",
			FABRIC_LOCAL_EMBEDDINGS_MODEL: LOCAL_MODEL,
		};
		expect(() =>
			getLocalEmbeddingsConfig({
				...env,
				FABRIC_LOCAL_EMBEDDINGS_BASE_URL: "localhost:11434",
			}),
		).toThrow(/must be http/);
		expect(() =>
			getLocalEmbeddingsConfig({
				...env,
				FABRIC_LOCAL_EMBEDDINGS_BASE_URL: "not a url",
			}),
		).toThrow(/not a valid URL/);
	});
});

describe("getLocalEmbeddingModel", () => {
	it("sizes every request to the vector store, whatever the caller sent", async () => {
		const model = getLocalEmbeddingModel({
			baseUrl: LOCAL_URL,
			model: LOCAL_MODEL,
		});

		await embed({ model, value: "no dimensions passed" });
		expect(lastRequest().url).toBe(`${LOCAL_URL}/embeddings`);
		expect(lastRequest().body).toMatchObject({
			model: LOCAL_MODEL,
			dimensions: 1536,
		});

		await embed({
			model,
			value: "other dimensions passed",
			providerOptions: { openai: { dimensions: 2560 } },
		});
		expect(lastRequest().body.dimensions).toBe(1536);
	});
});

describe("embedding resolution in development with the override set", () => {
	beforeEach(() => stubLocalEnv("development"));

	it("resolves EMBEDDING to the local model without reading the catalog", async () => {
		const config = await resolveModelWithProvider("EMBEDDING", CONTEXT);

		expect(config).toMatchObject({
			provider: "CUSTOM",
			modelString: LOCAL_MODEL,
			baseUrl: LOCAL_URL,
			selectionSource: "local_development",
		});
		expect(getModelForTask).not.toHaveBeenCalled();
	});

	it("passes both embedding gates", async () => {
		for (const gate of [
			getEmbeddingRAGProviderConfig,
			getSystemEmbeddingRAGProviderConfig,
		]) {
			await expect(gate(CONTEXT)).resolves.toMatchObject({
				provider: "CUSTOM",
				baseUrl: LOCAL_URL,
				source: "environment",
			});
		}
	});

	it("embeds on the local server", async () => {
		const { model, metadata } =
			await getAIEmbeddingModelWithMetadata(CONTEXT);
		await embed({ model, value: "hello" });

		expect(metadata.provider).toBe("CUSTOM");
		expect(lastRequest().url).toBe(`${LOCAL_URL}/embeddings`);
	});

	it("leaves language-model tasks on the tenant's provider", async () => {
		const config = await resolveModelWithProvider("SIMPLE", CONTEXT);

		expect(config.provider).toBe("OPENAI_DIRECT");
		expect(config.apiKey).toBe("encrypted:sk-org");
	});
});

describe("embedding resolution in production with the variables present", () => {
	beforeEach(() => stubLocalEnv("production"));

	it("resolves the tenant's embedding provider as before", async () => {
		const config = await resolveModelWithProvider("EMBEDDING", CONTEXT);

		expect(config).toMatchObject({
			provider: "OPENAI_DIRECT",
			modelString: "text-embedding-3-small",
			apiKey: "encrypted:sk-org",
		});
		await expect(
			getEmbeddingRAGProviderConfig(CONTEXT),
		).resolves.toMatchObject({
			provider: "OPENAI_DIRECT",
			apiKey: "sk-org",
		});
	});

	it("embeds on the tenant's provider", async () => {
		const { model } = await getAIEmbeddingModelWithMetadata(CONTEXT);
		await embed({ model, value: "hello" });

		const request = lastRequest();
		expect(request.url).toBe("https://api.openai.com/v1/embeddings");
		expect(request.headers.get("authorization")).toBe("Bearer sk-org");
	});
});

/** A chat completion whose single token carries these top logprobs. */
function letterReply(tokens: Record<string, number>) {
	return Response.json({
		choices: [
			{
				message: { role: "assistant", content: Object.keys(tokens)[0] },
				logprobs: {
					content: [
						{
							top_logprobs: Object.entries(tokens).map(
								([token, probability]) => ({
									token,
									logprob: Math.log(probability),
								}),
							),
						},
					],
				},
			},
		],
		usage: { prompt_tokens: 40, completion_tokens: 1 },
	});
}

const DECISION_CONFIG = {
	baseUrl: LOCAL_URL,
	model: "qwen3:4b-instruct",
	provider: "Ollama",
};

describe("getLocalModelConfig — each task on its own", () => {
	it("switches decisions and images on separately from embeddings", () => {
		const env = {
			NODE_ENV: "development",
			FABRIC_LOCAL_DECISIONS_BASE_URL: LOCAL_URL,
			FABRIC_LOCAL_DECISIONS_MODEL: "qwen3:4b-instruct",
			FABRIC_LOCAL_DECISIONS_PROVIDER: "Ollama",
		};
		expect(getLocalModelConfig("DECISION", env)).toEqual(DECISION_CONFIG);
		expect(getLocalModelConfig("EMBEDDING", env)).toBeNull();
		expect(getLocalModelConfig("IMAGE", env)).toBeNull();
		expect(
			getLocalModelConfig("DECISION", { ...env, NODE_ENV: "production" }),
		).toBeNull();
	});
});

describe("getLocalDecisionModel", () => {
	it("answers a choice from the answer letter's logprobs", async () => {
		fetchMock.mockImplementation(async () =>
			letterReply({ A: 0.93, B: 0.05, " B": 0.01, Answer: 0.01 }),
		);

		const { answers } = await experimental_decide({
			model: getLocalDecisionModel(DECISION_CONFIG),
			state: [
				{ type: "text", text: "Login button does nothing on Safari." },
			],
			questions: {
				kind: {
					type: "choice",
					instructions: "Is this work item a bug or a feature?",
					criteria: { bug: "Broken behaviour", feature: null },
				},
			},
		});

		expect(answers.kind).toMatchObject({ type: "choice", choice: "bug" });
		const probabilities = (
			answers.kind as { probabilities: Record<string, number> }
		).probabilities;
		expect(probabilities.bug).toBeCloseTo(0.93 / 0.99, 4);
		expect(probabilities.feature).toBeCloseTo(0.06 / 0.99, 4);
		const request = lastRequest();
		expect(request.url).toBe(`${LOCAL_URL}/chat/completions`);
		expect(request.body).toMatchObject({
			model: "qwen3:4b-instruct",
			max_tokens: 1,
			logprobs: true,
		});
	});

	it("answers a boolean with P(true)", async () => {
		fetchMock.mockImplementation(async () =>
			letterReply({ B: 0.8, A: 0.2 }),
		);

		const { answers } = await experimental_decide({
			model: getLocalDecisionModel(DECISION_CONFIG),
			state: [{ type: "text", text: "The task says it is done." }],
			questions: {
				done: {
					type: "boolean",
					instructions: "Is the task complete?",
				},
			},
		});

		expect(answers.done).toMatchObject({ type: "boolean" });
		expect(
			(answers.done as { probability: number }).probability,
		).toBeCloseTo(0.2, 4);
	});

	it("refuses when no option letter is among the logprobs", async () => {
		fetchMock.mockImplementation(async () =>
			letterReply({ Sorry: 0.9, I: 0.1 }),
		);

		// `decide` turns a refusal into an error, which every caller treats as
		// "no decision" and falls back to its language model.
		await expect(
			experimental_decide({
				model: getLocalDecisionModel(DECISION_CONFIG),
				state: [{ type: "text", text: "?" }],
				questions: {
					done: {
						type: "boolean",
						instructions: "Is the task complete?",
					},
				},
			}),
		).rejects.toThrow(/refused question "done"/);
	});
});

describe("localImageSize", () => {
	it("scales the requested shape to about 0.6 MP in multiples of 64", () => {
		expect(localImageSize({})).toBe("768x768");
		expect(localImageSize({ aspectRatio: "16:9" })).toBe("1024x576");
		expect(localImageSize({ size: "1024x1792" })).toBe("576x1024");
		expect(localImageSize({ size: "0x0" })).toBe("768x768");
	});
});

describe("decision resolution with the local override", () => {
	const DECISION_CONTEXT = { ...CONTEXT, organizationId: "org-1" };
	function stubDecisionEnv(nodeEnv: string) {
		vi.stubEnv("NODE_ENV", nodeEnv);
		vi.stubEnv("FABRIC_LOCAL_DECISIONS_BASE_URL", LOCAL_URL);
		vi.stubEnv("FABRIC_LOCAL_DECISIONS_MODEL", "qwen3:4b-instruct");
	}

	it("in development, decides on the local model without a gateway", async () => {
		stubDecisionEnv("development");
		fetchMock.mockImplementation(async () => letterReply({ A: 0.99 }));

		const { model, metadata } =
			await getAIDecisionModelWithMetadata(DECISION_CONTEXT);
		const { answers } = await experimental_decide({
			model,
			state: [{ type: "text", text: "x" }],
			questions: { ok: { type: "boolean", instructions: "Is it ok?" } },
		});

		expect(metadata).toMatchObject({
			provider: "CUSTOM",
			modelString: "qwen3:4b-instruct",
			selectionSource: "local_development",
		});
		expect(answers.ok).toMatchObject({ type: "boolean" });
		expect(lastRequest().url).toBe(`${LOCAL_URL}/chat/completions`);
	});

	it("in production, still requires the organization's gateway", async () => {
		stubDecisionEnv("production");

		await expect(
			getAIDecisionModelWithMetadata(DECISION_CONTEXT),
		).rejects.toBeInstanceOf(AIProviderNotConfiguredError);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
