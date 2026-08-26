/**
 * AI Model Selection Tests
 * Comprehensive tests for AI model selection across different provider configurations:
 * - Gateway providers (Vercel Gateway, OpenRouter, Cloudflare AI)
 * - Direct providers (OpenAI, Anthropic, Groq, DeepSeek)
 * - Per-task-type model selection
 * - Legacy compatibility
 * Run with: pnpm --filter @repo/ai test
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
// Pure, stateless helpers — imported directly from model-factory (matching the
// applyAzureChatBodyCompat precedent) rather than the tree-shaken public barrel.
//
// `isVercelGatewayKey` belongs here for a second reason: routing it through
// `getModelFunctions()` made five assertions about `"vck_".startsWith` each pay
// a `vi.resetModules()` plus a cold re-import of the whole barrel, which drags
// in @repo/payments and @repo/api. That put the first of them at ~16s against a
// 15s timeout, so ANY edit to index.ts — even to a comment — invalidated the
// transform cache and turned this file red. A pure helper needs none of it.
import { isVercelGatewayKey, needsReasoningExtraction } from "../model-factory";

// Mock @repo/database BEFORE any imports to prevent DATABASE_URL check
// Includes NotificationType / NotificationCategory / AiUsageLimit* enums because
// dynamic-model-selector now imports `assertWithinAiUsageLimits` from
// @repo/payments, which transitively loads @repo/api/lib/notification-service +
// @repo/api/modules/notifications/lib/payloads at module init (chokepoint
// integration;). Without these enums the mock returns `undefined`
// for `NotificationType.STORY_MENTION` etc. and the whole import chain crashes.
vi.mock("@repo/database", () => ({
	db: {},
	getAiProviderApiKey: vi.fn(),
	getAiProviderApiKeyByProvider: vi.fn(),
	// Registry hook called by @repo/payments at module init to wire the AI
	// usage recorder into logAiUsage. Stubbed as a no-op here.
	setAiUsageRecorder: vi.fn(),
	// Notification enums consumed at module init by api/modules/notifications/lib/payloads.ts.
	// Values must mirror packages/database/prisma/schema.prisma exactly.
	NotificationType: {
		STORY_MENTION: "STORY_MENTION",
		STORY_COMMENT_REPLY: "STORY_COMMENT_REPLY",
		STORY_ASSIGNED: "STORY_ASSIGNED",
		TASK_MENTION: "TASK_MENTION",
		TASK_COMMENT_REPLY: "TASK_COMMENT_REPLY",
		COMMENT_MENTION: "COMMENT_MENTION",
		DOCUMENT_MENTION: "DOCUMENT_MENTION",
		AGENT_REPLY_READY: "AGENT_REPLY_READY",
		STORY_STATUS_CHANGED: "STORY_STATUS_CHANGED",
		PM_SYNC_CONFLICT: "PM_SYNC_CONFLICT",
		AI_USAGE_LIMIT_WARNING: "AI_USAGE_LIMIT_WARNING",
		AI_USAGE_LIMIT_REACHED: "AI_USAGE_LIMIT_REACHED",
	},
	NotificationCategory: {
		MENTION: "MENTION",
		REPLY: "REPLY",
		ASSIGNMENT: "ASSIGNMENT",
		STATUS: "STATUS",
		AGENT: "AGENT",
		PROJECT: "PROJECT",
		SYSTEM: "SYSTEM",
		BILLING: "BILLING",
	},
	// AI usage-limits enums consumed at module init by @repo/payments/src/lib/ai-usage-limits.
	AiUsageLimitDimension: { TOKENS: "TOKENS", SPEND_USD: "SPEND_USD" },
	AiUsageLimitWindow: {
		HOURLY: "HOURLY",
		DAILY: "DAILY",
		MONTHLY: "MONTHLY",
	},
	AiUsageLimitEnforcement: { HARD: "HARD", SOFT: "SOFT" },
	Prisma: {},
	// Provider constants needed by gateway-config.ts
	GATEWAY_PROVIDERS: [
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
	] as const,
	DIRECT_PROVIDERS: [
		"OPENAI_DIRECT",
		"ANTHROPIC_DIRECT",
		"GROQ",
		"CEREBRAS",
		"DEEPSEEK",
		"MISTRAL_AI",
		"TOGETHER_AI",
		"COHERE",
		"PERPLEXITY",
		"XAI",
		"FIREWORKS",
		"AZURE_AI_FOUNDRY",
		"GOOGLE_VERTEX_AI",
		"AWS_BEDROCK",
	] as const,
	AI_PROVIDER_METADATA: {
		VERCEL_GATEWAY: {
			id: "VERCEL_GATEWAY",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			keyPrefix: "vck_",
		},
		OPENROUTER: {
			id: "OPENROUTER",
			baseUrl: "https://openrouter.ai/api/v1",
			keyPrefix: "sk-or-",
		},
		CLOUDFLARE_AI: { id: "CLOUDFLARE_AI", baseUrl: "", keyPrefix: "" },
		OPENAI_DIRECT: { id: "OPENAI_DIRECT", baseUrl: "", keyPrefix: "sk-" },
		ANTHROPIC_DIRECT: {
			id: "ANTHROPIC_DIRECT",
			baseUrl: "",
			keyPrefix: "sk-ant-",
		},
		GROQ: { id: "GROQ", baseUrl: "", keyPrefix: "gsk_" },
		DEEPSEEK: {
			id: "DEEPSEEK",
			baseUrl: "https://api.deepseek.com/v1",
			keyPrefix: "sk-",
		},
		CEREBRAS: {
			id: "CEREBRAS",
			baseUrl: "https://api.cerebras.ai/v1",
			keyPrefix: "csk-",
		},
		TOGETHER_AI: {
			id: "TOGETHER_AI",
			baseUrl: "https://api.together.xyz/v1",
			keyPrefix: "",
		},
		MISTRAL_AI: { id: "MISTRAL_AI", baseUrl: "", keyPrefix: "" },
		COHERE: { id: "COHERE", baseUrl: "", keyPrefix: "" },
		PERPLEXITY: {
			id: "PERPLEXITY",
			baseUrl: "https://api.perplexity.ai",
			keyPrefix: "pplx-",
		},
		XAI: { id: "XAI", baseUrl: "https://api.x.ai/v1", keyPrefix: "xai-" },
		FIREWORKS: {
			id: "FIREWORKS",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			keyPrefix: "",
		},
		AZURE_AI_FOUNDRY: {
			id: "AZURE_AI_FOUNDRY",
			baseUrl: "",
			keyPrefix: "",
		},
		GOOGLE_VERTEX_AI: {
			id: "GOOGLE_VERTEX_AI",
			baseUrl: "",
			keyPrefix: "",
		},
		AWS_BEDROCK: { id: "AWS_BEDROCK", baseUrl: "", keyPrefix: "" },
	},
	isGatewayProvider: (provider: string) =>
		["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"].includes(provider),
	isDirectProvider: (provider: string) =>
		[
			"OPENAI_DIRECT",
			"ANTHROPIC_DIRECT",
			"GROQ",
			"CEREBRAS",
			"DEEPSEEK",
			"MISTRAL_AI",
			"TOGETHER_AI",
			"COHERE",
			"PERPLEXITY",
			"XAI",
			"FIREWORKS",
		].includes(provider),
	getProviderDisplayName: (provider: string) => provider.replace(/_/g, " "),
	getProviderMetadata: (provider: string) => ({ id: provider }),
}));

// Mock @repo/logs
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock the AI SDK providers BEFORE importing the module under test
vi.mock("@ai-sdk/openai", () => ({
	createOpenAI: vi.fn((config) => {
		const mockProvider = vi.fn((modelName: string) => ({
			modelId: modelName,
			provider: "openai",
			baseURL: config?.baseURL,
			apiKey: config?.apiKey,
		}));
		// `.chat()` is used by the Azure / Databricks branches to force the
		// chat/completions surface. Return a plain base model so the reasoning
		// middleware wrapping (or lack of it) is observable in tests.
		mockProvider.chat = vi.fn((modelName: string) => ({
			modelId: modelName,
			provider: "openai",
			baseURL: config?.baseURL,
			apiKey: config?.apiKey,
		}));
		mockProvider.embedding = vi.fn((modelName: string) => ({
			modelId: modelName,
			type: "embedding",
			provider: "openai",
			baseURL: config?.baseURL,
			apiKey: config?.apiKey,
		}));
		mockProvider.image = vi.fn((modelName: string) => ({
			modelId: modelName,
			type: "image",
			provider: "openai",
			baseURL: config?.baseURL,
			apiKey: config?.apiKey,
		}));
		mockProvider.textEmbeddingModel = vi.fn((modelName: string) => ({
			modelId: modelName,
			type: "embedding",
			provider: "openai-gateway",
			baseURL: config?.baseURL,
			apiKey: config?.apiKey,
		}));
		return mockProvider;
	}),
}));

vi.mock("@ai-sdk/anthropic", () => ({
	createAnthropic: vi.fn((config) => {
		const mockProvider = vi.fn((modelName: string) => ({
			modelId: modelName,
			provider: "anthropic",
			apiKey: config?.apiKey,
		}));
		return mockProvider;
	}),
}));

vi.mock("@ai-sdk/groq", () => ({
	createGroq: vi.fn((config) => {
		const mockProvider = vi.fn((modelName: string) => ({
			modelId: modelName,
			provider: "groq",
			apiKey: config?.apiKey,
		}));
		return mockProvider;
	}),
}));

vi.mock("@ai-sdk/deepseek", () => ({
	createDeepSeek: vi.fn((config) => {
		const mockProvider = vi.fn((modelName: string) => ({
			modelId: modelName,
			provider: "deepseek",
			apiKey: config?.apiKey,
		}));
		return mockProvider;
	}),
}));

// =============================================================================
// Test Constants
// =============================================================================

const TEST_KEYS = {
	// Gateway keys (vck_* prefix indicates Vercel AI Gateway)
	VERCEL_GATEWAY: "vck_test_vercel_gateway_key_12345",
	// Direct provider keys
	OPENAI_DIRECT: "sk-test-openai-direct-key-12345",
	ANTHROPIC_DIRECT: "sk-ant-test-anthropic-key-12345",
	GROQ_DIRECT: "gsk_test_groq_key_12345",
	DEEPSEEK_DIRECT: "sk-test-deepseek-key-12345",
	// OpenRouter (also a gateway but different key format)
	OPENROUTER: "sk-or-v1-test-openrouter-key-12345",
};

const TEST_MODELS = {
	// OpenAI models
	GPT4O: "gpt-4o",
	GPT4O_MINI: "gpt-4o-mini",
	// Anthropic models
	CLAUDE_SONNET: "claude-3-5-sonnet-latest",
	CLAUDE_HAIKU: "claude-3-5-haiku-latest",
	// Groq models
	LLAMA_70B: "llama-3.3-70b-versatile",
	// DeepSeek models
	DEEPSEEK_CHAT: "deepseek-chat",
	DEEPSEEK_R1: "deepseek-r1",
	// Gateway format models
	GATEWAY_GPT4O: "openai/gpt-4o",
	GATEWAY_CLAUDE: "anthropic/claude-3-5-sonnet-latest",
	// Embedding models
	EMBEDDING_SMALL: "text-embedding-3-small",
	EMBEDDING_LARGE: "text-embedding-3-large",
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Import the module fresh for each test to reset provider caches
 */
/**
 * Spy on the reasoning middleware factory.
 *
 * These tests used to infer "reasoning middleware applied" from whether the
 * returned model carried the wrapper's `specificationVersion`. That proxy
 * stopped working once EVERY model began being wrapped to repair no-parameter
 * tool calls that `@ai-sdk/openai@3` drops (see empty-tool-input-middleware).
 * Asserting on this spy tests the thing Bug #1942 actually cares about —
 * whether <think> extraction is applied — instead of the shape of the return
 * value, so it stays honest no matter what else gets wrapped later.
 *
 * Declared at module scope so its identity survives the `vi.resetModules()`
 * below; the implementation is re-bound to the real one on every re-mock.
 */
const extractReasoningMiddlewareSpy = vi.fn();

async function getModelFunctions() {
	// Clear module cache to get fresh imports
	vi.resetModules();

	vi.doMock("ai", async () => {
		const actual = await vi.importActual<typeof import("ai")>("ai");
		extractReasoningMiddlewareSpy.mockImplementation(
			actual.extractReasoningMiddleware,
		);
		return {
			...actual,
			extractReasoningMiddleware: extractReasoningMiddlewareSpy,
		};
	});

	// Re-apply mocks after reset
	vi.doMock("@ai-sdk/openai", () => ({
		createOpenAI: vi.fn((config) => {
			const mockProvider = vi.fn((modelName: string) => ({
				modelId: modelName,
				provider: "openai",
				baseURL: config?.baseURL,
				apiKey: config?.apiKey,
			}));
			// `.chat()` is used by the Azure / Databricks branches to force the
			// chat/completions surface. Return a plain base model so the
			// reasoning middleware wrapping (or lack of it) is observable.
			mockProvider.chat = vi.fn((modelName: string) => ({
				modelId: modelName,
				provider: "openai",
				baseURL: config?.baseURL,
				apiKey: config?.apiKey,
			}));
			mockProvider.embedding = vi.fn((modelName: string) => ({
				modelId: modelName,
				type: "embedding",
				provider: "openai",
				baseURL: config?.baseURL,
				apiKey: config?.apiKey,
			}));
			mockProvider.image = vi.fn((modelName: string) => ({
				modelId: modelName,
				type: "image",
				provider: "openai",
				baseURL: config?.baseURL,
				apiKey: config?.apiKey,
			}));
			mockProvider.textEmbeddingModel = vi.fn((modelName: string) => ({
				modelId: modelName,
				type: "embedding",
				provider: "openai-gateway",
				baseURL: config?.baseURL,
				apiKey: config?.apiKey,
			}));
			return mockProvider;
		}),
	}));

	vi.doMock("@ai-sdk/anthropic", () => ({
		createAnthropic: vi.fn((config) => {
			const mockProvider = vi.fn((modelName: string) => ({
				modelId: modelName,
				provider: "anthropic",
				apiKey: config?.apiKey,
			}));
			return mockProvider;
		}),
	}));

	vi.doMock("@ai-sdk/groq", () => ({
		createGroq: vi.fn((config) => {
			const mockProvider = vi.fn((modelName: string) => ({
				modelId: modelName,
				provider: "groq",
				apiKey: config?.apiKey,
			}));
			return mockProvider;
		}),
	}));

	vi.doMock("@ai-sdk/deepseek", () => ({
		createDeepSeek: vi.fn((config) => {
			const mockProvider = vi.fn((modelName: string) => ({
				modelId: modelName,
				provider: "deepseek",
				apiKey: config?.apiKey,
			}));
			return mockProvider;
		}),
	}));

	const module = await import("../index");
	return {
		getModel: module.getModel,
		getEmbeddingModel: module.getEmbeddingModel,
		getImageModel: module.getImageModel,
		buildProviderModelString: module.buildProviderModelString,
	};
}

// =============================================================================
// Tests: isVercelGatewayKey
// =============================================================================

describe("isVercelGatewayKey", () => {
	it("should identify Vercel Gateway keys (vck_ prefix)", () => {
		expect(isVercelGatewayKey(TEST_KEYS.VERCEL_GATEWAY)).toBe(true);
	});

	it("should not identify direct OpenAI keys as gateway keys", () => {
		expect(isVercelGatewayKey(TEST_KEYS.OPENAI_DIRECT)).toBe(false);
	});

	it("should not identify Anthropic keys as gateway keys", () => {
		expect(isVercelGatewayKey(TEST_KEYS.ANTHROPIC_DIRECT)).toBe(false);
	});

	it("should not identify Groq keys as gateway keys", () => {
		expect(isVercelGatewayKey(TEST_KEYS.GROQ_DIRECT)).toBe(false);
	});

	it("should return false for empty string", () => {
		expect(isVercelGatewayKey("")).toBe(false);
	});
});

// =============================================================================
// Tests: getModel with Gateway Providers
// =============================================================================

describe("getModel - Gateway Providers", () => {
	describe("VERCEL_GATEWAY provider", () => {
		it("should route OpenAI models through gateway", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});

			// Model should be formatted for gateway (openai/gpt-4o)
			expect(model).toBeDefined();
			expect(model.modelId).toContain("openai/gpt-4o");
		});

		it("should route Anthropic models through gateway", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toContain("anthropic/claude");
		});

		it("should handle gateway-formatted model names", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GATEWAY_GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toContain("openai/gpt-4o");
		});
	});

	describe("OPENROUTER provider", () => {
		it("should route models through OpenRouter gateway", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.OPENROUTER,
				provider: "OPENROUTER",
			});

			expect(model).toBeDefined();
		});

		it("should handle Anthropic models via OpenRouter", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.OPENROUTER,
				provider: "OPENROUTER",
			});

			expect(model).toBeDefined();
		});
	});

	describe("CLOUDFLARE_AI provider", () => {
		it("should route models through Cloudflare AI gateway", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: "cf_test_key",
				provider: "CLOUDFLARE_AI",
			});

			expect(model).toBeDefined();
		});
	});
});

// =============================================================================
// Tests: getModel with Direct Providers
// =============================================================================

describe("getModel - Direct Providers", () => {
	describe("OPENAI_DIRECT provider", () => {
		it("should use OpenAI SDK directly for OpenAI models", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toBe(TEST_MODELS.GPT4O);
		});

		it("should strip gateway prefix for direct provider", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GATEWAY_GPT4O, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
			});

			// Should strip the "openai/" prefix
			expect(model).toBeDefined();
			expect(model.modelId).toBe(TEST_MODELS.GPT4O);
		});
	});

	describe("ANTHROPIC_DIRECT provider", () => {
		it("should use Anthropic SDK directly", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.ANTHROPIC_DIRECT,
				provider: "ANTHROPIC_DIRECT",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toBe(TEST_MODELS.CLAUDE_SONNET);
			expect(model.provider).toBe("anthropic");
		});

		it("should strip gateway prefix for Anthropic models", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.GATEWAY_CLAUDE, {
				apiKey: TEST_KEYS.ANTHROPIC_DIRECT,
				provider: "ANTHROPIC_DIRECT",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toBe(TEST_MODELS.CLAUDE_SONNET);
		});
	});

	describe("GROQ provider", () => {
		it("should use Groq SDK directly", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.LLAMA_70B, {
				apiKey: TEST_KEYS.GROQ_DIRECT,
				provider: "GROQ",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toBe(TEST_MODELS.LLAMA_70B);
			expect(model.provider).toBe("groq");
		});
	});

	describe("DEEPSEEK provider", () => {
		it("should use DeepSeek SDK directly", async () => {
			const { getModel } = await getModelFunctions();
			const model = getModel(TEST_MODELS.DEEPSEEK_CHAT, {
				apiKey: TEST_KEYS.DEEPSEEK_DIRECT,
				provider: "DEEPSEEK",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toBe(TEST_MODELS.DEEPSEEK_CHAT);
			expect(model.provider).toBe("deepseek");
		});
	});
});

// =============================================================================
// Tests: API key without provider should throw error
// =============================================================================

describe("getModel - API key without provider", () => {
	it("should throw error when API key provided without provider", async () => {
		const { getModel } = await getModelFunctions();

		expect(() => {
			getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				// No provider specified - should throw error
			});
		}).toThrow("Provider must be specified when providing an API key");
	});

	it("should throw error for any API key without provider specification", async () => {
		const { getModel } = await getModelFunctions();

		expect(() => {
			getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				// No provider - should throw
			});
		}).toThrow("Provider must be specified");
	});
});

// =============================================================================
// Tests: getEmbeddingModel
// =============================================================================

describe("getEmbeddingModel", () => {
	describe("with provider context", () => {
		it("should route through gateway when VERCEL_GATEWAY provider specified", async () => {
			const { getEmbeddingModel } = await getModelFunctions();
			const model = getEmbeddingModel(TEST_MODELS.EMBEDDING_SMALL, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});

			expect(model).toBeDefined();
			// Gateway embedding uses textEmbeddingModel which returns model with gateway prefix
			expect(model.modelId).toContain(TEST_MODELS.EMBEDDING_SMALL);
		});

		it("should use OpenAI directly when OPENAI_DIRECT provider specified", async () => {
			const { getEmbeddingModel } = await getModelFunctions();
			const model = getEmbeddingModel(TEST_MODELS.EMBEDDING_SMALL, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
			});

			expect(model).toBeDefined();
			expect(model.type).toBe("embedding");
			expect(model.provider).toBe("openai");
		});

		it("should handle OPENROUTER as gateway provider", async () => {
			const { getEmbeddingModel } = await getModelFunctions();
			const model = getEmbeddingModel(TEST_MODELS.EMBEDDING_SMALL, {
				apiKey: TEST_KEYS.OPENROUTER,
				provider: "OPENROUTER",
			});

			expect(model).toBeDefined();
		});
	});

	describe("API key without provider should throw", () => {
		it("should throw error when API key provided without provider", async () => {
			const { getEmbeddingModel } = await getModelFunctions();

			expect(() => {
				getEmbeddingModel(TEST_MODELS.EMBEDDING_SMALL, {
					apiKey: TEST_KEYS.OPENAI_DIRECT,
					// No provider - should throw
				});
			}).toThrow("Provider must be specified");
		});
	});

	describe("default model", () => {
		it("should require model name (no hardcoded fallback)", async () => {
			const { getEmbeddingModel } = await getModelFunctions();

			// With new centralized approach, model name must come from database
			// No hardcoded fallbacks allowed
			expect(() => {
				getEmbeddingModel(undefined, {
					apiKey: TEST_KEYS.OPENAI_DIRECT,
					provider: "OPENAI_DIRECT",
				});
			}).toThrow("Embedding model name is required");
		});
	});
});

// =============================================================================
// Tests: getImageModel
// =============================================================================

describe("getImageModel", () => {
	it("should route through gateway when VERCEL_GATEWAY provider specified", async () => {
		const { getImageModel } = await getModelFunctions();
		const model = getImageModel("dall-e-3", {
			apiKey: TEST_KEYS.VERCEL_GATEWAY,
			provider: "VERCEL_GATEWAY",
		});

		expect(model).toBeDefined();
		expect(model.type).toBe("image");
	});

	it("should use OpenAI directly when OPENAI_DIRECT provider specified", async () => {
		const { getImageModel } = await getModelFunctions();
		const model = getImageModel("dall-e-3", {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
			provider: "OPENAI_DIRECT",
		});

		expect(model).toBeDefined();
		expect(model.type).toBe("image");
	});

	it("should strip provider prefix from model name", async () => {
		const { getImageModel } = await getModelFunctions();
		const model = getImageModel("openai/dall-e-3", {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
			provider: "OPENAI_DIRECT",
		});

		expect(model).toBeDefined();
		expect(model.modelId).toBe("dall-e-3");
	});

	it("should throw error for unsupported image models", async () => {
		const { getImageModel } = await getModelFunctions();

		expect(() => {
			getImageModel("unsupported-model", {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
			});
		}).toThrow("Unsupported image model");
	});

	it("should use dall-e-3 as default", async () => {
		const { getImageModel } = await getModelFunctions();
		const model = getImageModel(undefined, {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
		});

		expect(model).toBeDefined();
		expect(model.modelId).toBe("dall-e-3");
	});
});

// =============================================================================
// Tests: Task Type Scenarios (Integration-like tests)
// =============================================================================

describe("Task Type Scenarios", () => {
	describe("User has Gateway + Direct providers configured", () => {
		it("Scenario: User selects Gateway for CHAT, Direct for EMBEDDING", async () => {
			const { getModel, getEmbeddingModel } = await getModelFunctions();

			// CHAT task uses Gateway
			const chatModel = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});
			expect(chatModel.modelId).toContain("openai/gpt-4o");

			// EMBEDDING task uses Direct OpenAI
			const embeddingModel = getEmbeddingModel(
				TEST_MODELS.EMBEDDING_SMALL,
				{
					apiKey: TEST_KEYS.OPENAI_DIRECT,
					provider: "OPENAI_DIRECT",
				},
			);
			expect(embeddingModel.provider).toBe("openai");
		});

		it("Scenario: User selects Anthropic Direct for REASONING, Gateway for SIMPLE", async () => {
			const { getModel } = await getModelFunctions();

			// REASONING task uses Anthropic Direct
			const reasoningModel = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.ANTHROPIC_DIRECT,
				provider: "ANTHROPIC_DIRECT",
			});
			expect(reasoningModel.provider).toBe("anthropic");
			expect(reasoningModel.modelId).toBe(TEST_MODELS.CLAUDE_SONNET);

			// SIMPLE task uses Gateway
			const simpleModel = getModel(TEST_MODELS.GPT4O_MINI, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});
			expect(simpleModel.modelId).toContain("openai/gpt-4o-mini");
		});

		it("Scenario: Different gateways for different tasks", async () => {
			const { getModel } = await getModelFunctions();

			// Task 1 uses Vercel Gateway
			const model1 = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});
			expect(model1).toBeDefined();

			// Task 2 uses OpenRouter Gateway
			const model2 = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.OPENROUTER,
				provider: "OPENROUTER",
			});
			expect(model2).toBeDefined();
		});
	});

	describe("Organization vs Personal context", () => {
		it("should work with organization context metadata", async () => {
			const { getModel } = await getModelFunctions();

			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
				organizationId: "org_123",
			});

			expect(model).toBeDefined();
		});

		it("should work with user context metadata", async () => {
			const { getModel } = await getModelFunctions();

			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
				userId: "user_123",
			});

			expect(model).toBeDefined();
		});
	});
});

// =============================================================================
// Tests: Edge Cases
// =============================================================================

describe("Edge Cases", () => {
	it("should handle unknown provider by checking key format", async () => {
		const { getModel } = await getModelFunctions();

		// Unknown provider with gateway key should route through gateway
		const model = getModel(TEST_MODELS.GPT4O, {
			apiKey: TEST_KEYS.VERCEL_GATEWAY,
			provider: "UNKNOWN_PROVIDER" as any,
		});

		expect(model).toBeDefined();
	});

	it("should handle unknown provider with non-gateway key", async () => {
		const { getModel } = await getModelFunctions();

		// Unknown provider with non-gateway key should fall back to OpenAI-compatible
		const model = getModel(TEST_MODELS.GPT4O, {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
			provider: "UNKNOWN_PROVIDER" as any,
		});

		expect(model).toBeDefined();
	});

	it("should require model name (no hardcoded fallback)", async () => {
		const { getModel } = await getModelFunctions();

		// With new centralized approach, model name must come from database
		// No hardcoded fallbacks allowed
		expect(() => {
			getModel(undefined, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
			});
		}).toThrow("Model name is required");
	});

	it("should handle nested provider prefixes (groq/openai/model)", async () => {
		const { getModel } = await getModelFunctions();

		const model = getModel("groq/openai/gpt-oss-120b", {
			apiKey: TEST_KEYS.VERCEL_GATEWAY,
			provider: "VERCEL_GATEWAY",
		});

		expect(model).toBeDefined();
	});
});

// =============================================================================
// Tests: Provider Caching
// =============================================================================

describe("Provider Caching", () => {
	it("should reuse provider instances for same API key", async () => {
		const { getModel } = await getModelFunctions();

		// Call twice with same key
		const model1 = getModel(TEST_MODELS.GPT4O, {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
			provider: "OPENAI_DIRECT",
		});

		const model2 = getModel(TEST_MODELS.GPT4O_MINI, {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
			provider: "OPENAI_DIRECT",
		});

		// Both should work
		expect(model1).toBeDefined();
		expect(model2).toBeDefined();
	});

	it("should create separate provider instances for different keys", async () => {
		const { getModel } = await getModelFunctions();

		const model1 = getModel(TEST_MODELS.GPT4O, {
			apiKey: TEST_KEYS.OPENAI_DIRECT,
			provider: "OPENAI_DIRECT",
		});

		const model2 = getModel(TEST_MODELS.CLAUDE_SONNET, {
			apiKey: TEST_KEYS.ANTHROPIC_DIRECT,
			provider: "ANTHROPIC_DIRECT",
		});

		expect(model1).toBeDefined();
		expect(model2).toBeDefined();
		expect(model1.provider).not.toBe(model2.provider);
	});
});

// =============================================================================
// Tests: Regression Prevention - Critical User Scenarios
// =============================================================================

describe("Regression Prevention - Critical User Scenarios", () => {
	describe("Scenario: User has Vercel Gateway (default) + OpenAI Direct (for embeddings)", () => {
		/**
		 * This is the exact scenario that was broken:
		 * - User configures Vercel AI Gateway as their DEFAULT provider
		 * - User also configures OpenAI Direct provider
		 * - In AI Models page, for EMBEDDING task, user selects model via OpenAI Direct
		 * Expected: Embeddings should use OpenAI Direct key, not gateway key
		 * Bug was: System always used gateway key because provider info wasn't passed through
		 */

		it("EMBEDDING task should use OpenAI Direct (not Gateway) when user selected it", async () => {
			const { getEmbeddingModel } = await getModelFunctions();

			// This is what the RAG embedding generator should now do:
			// Pass the resolved provider from selectModelDynamic to getEmbeddingModel
			const model = getEmbeddingModel(TEST_MODELS.EMBEDDING_SMALL, {
				apiKey: TEST_KEYS.OPENAI_DIRECT, // Direct key for embeddings
				provider: "OPENAI_DIRECT", // User selected this for EMBEDDING task
			});

			expect(model).toBeDefined();
			expect(model.provider).toBe("openai"); // Should be direct, not gateway
			expect(model.apiKey).toBe(TEST_KEYS.OPENAI_DIRECT);
		});

		it("CHAT task should use Gateway when user selected it", async () => {
			const { getModel } = await getModelFunctions();

			// Default chat uses gateway
			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});

			expect(model).toBeDefined();
			expect(model.modelId).toContain("openai/gpt-4o"); // Gateway format
		});
	});

	describe("Scenario: User has multiple gateways with different provider selections", () => {
		/**
		 * User configures:
		 * - Vercel Gateway with OpenAI + Anthropic enabled
		 * - OpenRouter with Groq + Mistral enabled
		 * User selects:
		 * - SIMPLE task: GPT-4o-mini via Vercel Gateway
		 * - COMPLEX task: Claude via Vercel Gateway
		 * - REASONING task: Llama via OpenRouter
		 */

		it("should route to correct gateway based on task type selection", async () => {
			const { getModel } = await getModelFunctions();

			// SIMPLE via Vercel
			const simpleModel = getModel(TEST_MODELS.GPT4O_MINI, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});
			expect(simpleModel).toBeDefined();

			// COMPLEX via Vercel
			const complexModel = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});
			expect(complexModel).toBeDefined();

			// REASONING via OpenRouter
			const reasoningModel = getModel(TEST_MODELS.LLAMA_70B, {
				apiKey: TEST_KEYS.OPENROUTER,
				provider: "OPENROUTER",
			});
			expect(reasoningModel).toBeDefined();
		});
	});

	describe("Scenario: Mix of gateways and direct providers", () => {
		/**
		 * User configures:
		 * - Vercel Gateway (for most tasks)
		 * - Anthropic Direct (for specific reasoning)
		 * - Groq Direct (for fast inference)
		 * Task selections:
		 * - SIMPLE: GPT-4o-mini via Vercel Gateway
		 * - REASONING: Claude via Anthropic Direct (user prefers direct for critical tasks)
		 * - TOOL_CALLING: Llama via Groq Direct (for speed)
		 * - EMBEDDING: text-embedding-3-small via Vercel Gateway
		 */

		it("should use correct provider for each task type", async () => {
			const { getModel, getEmbeddingModel } = await getModelFunctions();

			// SIMPLE - Gateway
			const simpleModel = getModel(TEST_MODELS.GPT4O_MINI, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});
			expect(simpleModel.modelId).toContain("openai/");

			// REASONING - Anthropic Direct
			const reasoningModel = getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.ANTHROPIC_DIRECT,
				provider: "ANTHROPIC_DIRECT",
			});
			expect(reasoningModel.provider).toBe("anthropic");
			expect(reasoningModel.modelId).toBe(TEST_MODELS.CLAUDE_SONNET);

			// TOOL_CALLING - Groq Direct
			const toolModel = getModel(TEST_MODELS.LLAMA_70B, {
				apiKey: TEST_KEYS.GROQ_DIRECT,
				provider: "GROQ",
			});
			expect(toolModel.provider).toBe("groq");
			expect(toolModel.modelId).toBe(TEST_MODELS.LLAMA_70B);

			// EMBEDDING - Gateway
			const embeddingModel = getEmbeddingModel(
				TEST_MODELS.EMBEDDING_SMALL,
				{
					apiKey: TEST_KEYS.VERCEL_GATEWAY,
					provider: "VERCEL_GATEWAY",
				},
			);
			expect(embeddingModel).toBeDefined();
			expect(embeddingModel.modelId).toContain(
				TEST_MODELS.EMBEDDING_SMALL,
			);
		});
	});

	describe("Scenario: Provider key must match provider type", () => {
		/**
		 * Critical security/correctness check:
		 * When user selects "OPENAI_DIRECT" provider, the system should use the
		 * OpenAI Direct API key (sk-..), NOT the gateway key (vck_..)
		 * This was the root cause of the original bug.
		 */

		it("OPENAI_DIRECT provider should NOT use gateway key", async () => {
			const { getModel } = await getModelFunctions();

			// Correct usage: OpenAI Direct with OpenAI key
			getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.OPENAI_DIRECT,
				provider: "OPENAI_DIRECT",
			});

			// Asserted on what reached the SDK rather than on a property
			// echoed back by the model object: every model is now wrapped to
			// repair dropped no-parameter tool calls, and a wrapper does not
			// forward arbitrary fields like `apiKey`. This is the stronger
			// check anyway — it pins the key actually handed to the provider.
			const { createOpenAI } = await import("@ai-sdk/openai");
			const configs = vi
				.mocked(createOpenAI)
				.mock.calls.map(([config]) => config?.apiKey);

			expect(configs).toContain(TEST_KEYS.OPENAI_DIRECT);
			expect(configs).not.toContain(TEST_KEYS.VERCEL_GATEWAY);
		});

		it("ANTHROPIC_DIRECT provider should use Anthropic key", async () => {
			const { getModel } = await getModelFunctions();

			getModel(TEST_MODELS.CLAUDE_SONNET, {
				apiKey: TEST_KEYS.ANTHROPIC_DIRECT,
				provider: "ANTHROPIC_DIRECT",
			});

			const { createAnthropic } = await import("@ai-sdk/anthropic");
			const configs = vi
				.mocked(createAnthropic)
				.mock.calls.map(([config]) => config?.apiKey);

			expect(configs).toContain(TEST_KEYS.ANTHROPIC_DIRECT);
		});

		it("VERCEL_GATEWAY provider should route through gateway", async () => {
			const { getModel } = await getModelFunctions();

			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: TEST_KEYS.VERCEL_GATEWAY,
				provider: "VERCEL_GATEWAY",
			});

			// Gateway models have provider/ prefix in modelId
			expect(model.modelId).toContain("openai/");
			expect(model).toBeDefined();
		});
	});
});

// =============================================================================
// Tests: All Supported Provider Types
// =============================================================================

describe("All Supported Provider Types", () => {
	const allProviders = [
		{
			provider: "VERCEL_GATEWAY",
			key: TEST_KEYS.VERCEL_GATEWAY,
			isGateway: true,
		},
		{ provider: "OPENROUTER", key: TEST_KEYS.OPENROUTER, isGateway: true },
		{ provider: "CLOUDFLARE_AI", key: "cf_test_key", isGateway: true },
		{
			provider: "OPENAI_DIRECT",
			key: TEST_KEYS.OPENAI_DIRECT,
			isGateway: false,
		},
		{
			provider: "ANTHROPIC_DIRECT",
			key: TEST_KEYS.ANTHROPIC_DIRECT,
			isGateway: false,
		},
		{ provider: "GROQ", key: TEST_KEYS.GROQ_DIRECT, isGateway: false },
		{
			provider: "DEEPSEEK",
			key: TEST_KEYS.DEEPSEEK_DIRECT,
			isGateway: false,
		},
	];

	for (const { provider, key, isGateway } of allProviders) {
		it(`should handle ${provider} provider correctly`, async () => {
			const { getModel } = await getModelFunctions();

			const model = getModel(TEST_MODELS.GPT4O, {
				apiKey: key,
				provider: provider,
			});

			expect(model).toBeDefined();

			if (isGateway) {
				// Gateway providers format model names with prefix
				expect(model.modelId).toContain("/");
			} else if (provider === "OPENAI_DIRECT") {
				// Direct OpenAI uses model name as-is
				expect(model.modelId).toBe(TEST_MODELS.GPT4O);
			}
		});
	}
});

// =============================================================================
// Tests: buildProviderModelString (canonical/providerModelId -> provider string)
// Regression guard for the model-override mapping bug: a user-selected model
// override (a canonical name) is mapped through the catalog to the provider's
// actual model ID, then normalized here. Databricks Unity AI Gateway ids like
// "system.ai.claude-sonnet-5" must pass through a DIRECT provider unchanged —
// they contain dots but no "/", so they must not be prefixed or truncated.
// =============================================================================

describe("buildProviderModelString", () => {
	it("passes a Databricks system.ai.* id through a direct provider unchanged", async () => {
		const { buildProviderModelString } = await getModelFunctions();
		expect(
			buildProviderModelString("system.ai.claude-sonnet-5", "DATABRICKS"),
		).toBe("system.ai.claude-sonnet-5");
	});

	it("keeps a plain direct-provider id as-is", async () => {
		const { buildProviderModelString } = await getModelFunctions();
		expect(buildProviderModelString("gpt-4o", "OPENAI_DIRECT")).toBe(
			"gpt-4o",
		);
	});

	it("strips a stray prefix for a direct provider", async () => {
		const { buildProviderModelString } = await getModelFunctions();
		expect(buildProviderModelString("openai/gpt-4o", "OPENAI_DIRECT")).toBe(
			"gpt-4o",
		);
	});

	it("adds a routing prefix for a gateway provider", async () => {
		const { buildProviderModelString } = await getModelFunctions();
		expect(buildProviderModelString("gpt-4o", "VERCEL_GATEWAY")).toBe(
			"openai/gpt-4o",
		);
	});

	it("keeps an existing prefix for a gateway provider", async () => {
		const { buildProviderModelString } = await getModelFunctions();
		expect(
			buildProviderModelString("openai/gpt-4o", "VERCEL_GATEWAY"),
		).toBe("openai/gpt-4o");
	});

	it("keeps an inference-provider id as-is (no stripping)", async () => {
		const { buildProviderModelString } = await getModelFunctions();
		expect(buildProviderModelString("openai/gpt-oss-120b", "GROQ")).toBe(
			"openai/gpt-oss-120b",
		);
	});
});

// =============================================================================
// Tests: needsReasoningExtraction (DeepSeek-R1 <think>-tag middleware decision)
// Bug #1942 (U3): a DeepSeek-R1 endpoint *served over Databricks* returns
// reasoning as raw <think> tags on the OpenAI-compatible surface (unlike the
// DeepSeek *direct* provider, which parses it into `reasoning_content`). The
// serving-endpoint name can be `deepseek-r1`/`deepseek-reasoner`, so the
// name-derived provider is "deepseek" — but the RESOLVED provider is DATABRICKS
// and the tags must still be extracted. The decision must key off the resolved
// provider, not the model name.
// =============================================================================

describe("needsReasoningExtraction", () => {
	it("extracts <think> for a Databricks-served DeepSeek-R1 endpoint (Bug #1942)", () => {
		// Databricks strips the prefix, so a `deepseek-r1` serving endpoint
		// reaches getModel as "deepseek-r1" → name-derived provider "deepseek".
		expect(
			needsReasoningExtraction("deepseek-r1", "deepseek", "DATABRICKS"),
		).toBe(true);
		expect(
			needsReasoningExtraction(
				"deepseek-reasoner",
				"deepseek",
				"DATABRICKS",
			),
		).toBe(true);
	});

	it("does NOT extract for the DeepSeek direct provider (native reasoning_content)", () => {
		expect(
			needsReasoningExtraction(
				"deepseek-reasoner",
				"deepseek",
				"DEEPSEEK",
			),
		).toBe(false);
		// Preserves the pre-existing name-only default (gateway / no resolved
		// provider) so gateway routing is unchanged.
		expect(
			needsReasoningExtraction("deepseek-r1", "deepseek", undefined),
		).toBe(false);
	});

	it("does NOT extract for a non-reasoning model, even on Databricks", () => {
		expect(
			needsReasoningExtraction(
				"databricks-claude-sonnet-5",
				"openai",
				"DATABRICKS",
			),
		).toBe(false);
		expect(
			needsReasoningExtraction("deepseek-chat", "deepseek", "DATABRICKS"),
		).toBe(false);
		expect(needsReasoningExtraction("gpt-4o", "openai", "DATABRICKS")).toBe(
			false,
		);
	});

	it("extracts for R1-architecture models on other OpenAI-compatible surfaces", () => {
		// Together-served R1 (prefixed id → name provider "deepseek-ai").
		expect(
			needsReasoningExtraction(
				"deepseek-ai/DeepSeek-R1",
				"deepseek-ai",
				"TOGETHER_AI",
			),
		).toBe(true);
		// A distill endpoint on Databricks named without the "deepseek" prefix.
		expect(
			needsReasoningExtraction(
				"r1-distill-llama-70b",
				"openai",
				"DATABRICKS",
			),
		).toBe(true);
	});

	it("uses the explicit isReasoningModel signal for an opaque Databricks alias (Bug #1942 review)", () => {
		// An R1 model mapped to an opaque serving alias: the NAME check misses it,
		// but the caller-resolved canonical signal catches it.
		expect(
			needsReasoningExtraction("prod-chat", "openai", "DATABRICKS"),
		).toBe(false); // no signal → name fallback → missed (the old limitation)
		expect(
			needsReasoningExtraction("prod-chat", "openai", "DATABRICKS", true),
		).toBe(true); // explicit canonical signal → extracted (the fix)
	});

	it("an explicit false signal suppresses extraction even for an R1-looking name", () => {
		expect(
			needsReasoningExtraction(
				"deepseek-r1",
				"openai",
				"DATABRICKS",
				false,
			),
		).toBe(false);
	});

	it("still skips the DeepSeek direct provider even with an explicit true signal (native)", () => {
		expect(
			needsReasoningExtraction(
				"deepseek-reasoner",
				"deepseek",
				"DEEPSEEK",
				true,
			),
		).toBe(false);
	});
});

// =============================================================================
// Tests: getModel reasoning-middleware wiring (integration)
// Asserts the DATABRICKS branch actually threads the resolved provider into
// the middleware decision, by spying on the reasoning-middleware factory.
//
// These used to read the returned model's `specificationVersion` — present on
// a wrapped model, absent on a bare one. That proxy died when every model
// started being wrapped to repair the no-parameter tool calls
// `@ai-sdk/openai@3` drops (see empty-tool-input-middleware.ts). The spy tests
// what Bug #1942 is actually about: whether <think> extraction is applied.
// =============================================================================

describe("getModel - Databricks DeepSeek-R1 reasoning middleware (Bug #1942)", () => {
	const DATABRICKS_KEY = "dapi-test-databricks-key-12345";
	const DATABRICKS_BASE = "https://dbc-test.cloud.databricks.com";

	beforeEach(() => {
		extractReasoningMiddlewareSpy.mockClear();
	});

	it("wraps a Databricks DeepSeek-R1 endpoint with <think> extraction middleware", async () => {
		const { getModel } = await getModelFunctions();
		const model = getModel("deepseek-r1", {
			apiKey: DATABRICKS_KEY,
			provider: "DATABRICKS",
			baseUrl: DATABRICKS_BASE,
		});
		expect(model).toBeDefined();
		// Wrapped: the reasoning middleware wrapper reports its own spec version.
		expect(extractReasoningMiddlewareSpy).toHaveBeenCalled();
	});

	it("does NOT wrap a Databricks non-reasoning endpoint", async () => {
		const { getModel } = await getModelFunctions();
		const model = getModel("databricks-claude-sonnet-5", {
			apiKey: DATABRICKS_KEY,
			provider: "DATABRICKS",
			baseUrl: DATABRICKS_BASE,
		});
		expect(model).toBeDefined();
		expect(extractReasoningMiddlewareSpy).not.toHaveBeenCalled();
	});

	it("does NOT wrap DeepSeek-R1 on the DeepSeek direct provider (native reasoning)", async () => {
		const { getModel } = await getModelFunctions();
		const model = getModel("deepseek-reasoner", {
			apiKey: TEST_KEYS.DEEPSEEK_DIRECT,
			provider: "DEEPSEEK",
		});
		expect(model).toBeDefined();
		expect(extractReasoningMiddlewareSpy).not.toHaveBeenCalled();
	});

	it("wraps a Databricks R1 endpoint with an OPAQUE alias via the isReasoningModel signal (Bug #1942 review)", async () => {
		const { getModel } = await getModelFunctions();
		// Alias "prod-chat" matches no R1 name pattern; only the explicit
		// canonical-derived signal marks it as reasoning.
		const model = getModel("prod-chat", {
			apiKey: DATABRICKS_KEY,
			provider: "DATABRICKS",
			baseUrl: DATABRICKS_BASE,
			isReasoningModel: true,
		});
		expect(model).toBeDefined();
		expect(extractReasoningMiddlewareSpy).toHaveBeenCalled();
	});

	it("does NOT wrap the same opaque alias without the signal (name fallback misses it)", async () => {
		const { getModel } = await getModelFunctions();
		const model = getModel("prod-chat", {
			apiKey: DATABRICKS_KEY,
			provider: "DATABRICKS",
			baseUrl: DATABRICKS_BASE,
		});
		expect(model).toBeDefined();
		expect(extractReasoningMiddlewareSpy).not.toHaveBeenCalled();
	});
});
