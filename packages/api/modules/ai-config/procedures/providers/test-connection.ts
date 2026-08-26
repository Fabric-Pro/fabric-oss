import { ORPCError } from "@orpc/server";
import { DatabricksOAuthError, getDatabricksOAuthToken } from "@repo/ai";
import { type AIProvider, db } from "@repo/database";
import { decryptApiKey } from "@repo/utils";
import { z } from "zod";
import { checkRateLimit } from "../../../../lib/rate-limit";
import {
	Permissions,
	requireInputOrgPermission,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	listDatabricksModels,
	validateDatabricksToken,
} from "../../lib/databricks";
import { refineProviderCredentials } from "../../lib/provider-credentials";
// Shared with `providers/upsert.ts` so the SSRF rules applied when TESTING a
// URL are identical to those applied when STORING one.
import { validateProviderUrl } from "../../lib/provider-url";

const AIProviderEnum = z.enum([
	"VERCEL_GATEWAY",
	"CLOUDFLARE_AI",
	"OPENROUTER",
	"AZURE_AI_FOUNDRY",
	"AWS_BEDROCK",
	"GOOGLE_VERTEX_AI",
	"DATABRICKS",
	"OPENAI_DIRECT",
	"ANTHROPIC_DIRECT",
	"GROQ",
	"TOGETHER_AI",
	"DEEPSEEK",
	"COHERE",
	"MISTRAL_AI",
	"FIREWORKS",
	"PERPLEXITY",
	"XAI",
	"CEREBRAS",
]);

type AIProviderType = z.infer<typeof AIProviderEnum>;

interface ConnectionTestResult {
	success: boolean;
	message: string;
	latencyMs?: number;
	models?: string[];
	error?: string;
}

/**
 * Rate limit configuration for connection test endpoints
 * Stricter limits to prevent brute force and resource exhaustion
 */
const CONNECTION_TEST_RATE_LIMIT = {
	limit: 5, // 5 attempts
	windowMs: 60_000, // per minute
};

/**
 * Check rate limit for connection test endpoints
 * Prevents brute force and resource exhaustion attacks
 */
async function checkConnectionTestRateLimit(
	userId: string,
): Promise<{ allowed: boolean; resetInSeconds?: number; statusCode?: number }> {
	const key = `test-connection:${userId}`;
	const result = await checkRateLimit(
		key,
		CONNECTION_TEST_RATE_LIMIT.limit,
		CONNECTION_TEST_RATE_LIMIT.windowMs,
	);
	return {
		allowed: result.allowed,
		resetInSeconds: result.resetInSeconds,
		statusCode: result.statusCode,
	};
}

/**
 * Test connection for OpenAI-compatible providers (OpenAI, Groq, Together, etc.)
 */
async function testOpenAICompatible(
	apiKey: string,
	baseUrl: string,
	providerName: string,
): Promise<ConnectionTestResult> {
	const start = Date.now();
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10000), // 10 second timeout
		});

		if (response.status === 401) {
			return {
				success: false,
				message: "Connection failed: Invalid credentials",
			};
		}

		if (response.status === 403) {
			return {
				success: false,
				message: "Connection failed: Insufficient permissions",
			};
		}

		if (!response.ok) {
			return {
				success: false,
				message: "Connection failed: Provider returned an error",
			};
		}

		const data = (await response.json()) as {
			data?: Array<{ id: string }>;
		};
		const models = data.data?.map((m) => m.id).slice(0, 20);

		return {
			success: true,
			message: `Connected to ${providerName} successfully`,
			latencyMs: Date.now() - start,
			models,
		};
	} catch (error) {
		// Generic error message to prevent information disclosure
		return {
			success: false,
			message: "Connection test failed",
			error:
				error instanceof Error && error.name === "TimeoutError"
					? "Request timed out"
					: undefined,
		};
	}
}

/**
 * Test Anthropic connection
 */
async function testAnthropic(apiKey: string): Promise<ConnectionTestResult> {
	const start = Date.now();
	try {
		// Anthropic doesn't have a /models endpoint, use a minimal message request
		const response = await fetch("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"anthropic-version": "2024-01-01",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "claude-3-5-haiku-latest",
				max_tokens: 1,
				messages: [{ role: "user", content: "." }],
			}),
			signal: AbortSignal.timeout(10000), // 10 second timeout
		});

		if (response.status === 401) {
			return {
				success: false,
				message: "Connection failed: Invalid credentials",
			};
		}

		// 200 or any client error that's not auth-related means key is valid
		if (response.status === 200 || response.status === 400) {
			return {
				success: true,
				message: "Connected to Anthropic successfully",
				latencyMs: Date.now() - start,
				models: [
					"claude-3-5-sonnet-latest",
					"claude-3-5-haiku-latest",
					"claude-3-opus-latest",
				],
			};
		}

		return {
			success: false,
			message: "Connection failed: Provider returned an error",
		};
	} catch (error) {
		return {
			success: false,
			message: "Connection test failed",
			error:
				error instanceof Error && error.name === "TimeoutError"
					? "Request timed out"
					: undefined,
		};
	}
}

/**
 * Test Vercel AI Gateway connection
 */
async function testVercelGateway(
	apiKey: string,
): Promise<ConnectionTestResult> {
	const start = Date.now();
	try {
		// Vercel AI Gateway uses OpenAI-compatible endpoint
		const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10000), // 10 second timeout
		});

		if (response.status === 401 || response.status === 403) {
			return {
				success: false,
				message: "Connection failed: Invalid credentials",
			};
		}

		if (response.ok) {
			return {
				success: true,
				message: "Connected to Vercel AI Gateway successfully",
				latencyMs: Date.now() - start,
			};
		}

		// Gateway might return different status, check key format as fallback
		return {
			success: apiKey.startsWith("vck_"),
			message: apiKey.startsWith("vck_")
				? "Vercel AI Gateway key format is valid"
				: "Connection failed: Invalid key format",
		};
	} catch (error) {
		// Gateway might not have models endpoint, validate key format
		return {
			success: apiKey.startsWith("vck_"),
			message: apiKey.startsWith("vck_")
				? "Vercel AI Gateway key format is valid"
				: "Connection failed: Invalid key format",
			error:
				error instanceof Error && error.name === "TimeoutError"
					? "Request timed out"
					: undefined,
		};
	}
}

/**
 * Test xAI (Grok) connection
 */
async function testXAI(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(apiKey, "https://api.x.ai/v1", "xAI");
}

/**
 * Test Cerebras connection
 */
async function testCerebras(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(
		apiKey,
		"https://api.cerebras.ai/v1",
		"Cerebras",
	);
}

/**
 * Test Cloudflare AI Gateway connection
 * Note: Cloudflare requires a custom baseUrl for each account
 */
async function testCloudflareGateway(
	apiKey: string,
	baseUrl?: string,
): Promise<ConnectionTestResult> {
	if (!baseUrl) {
		return {
			success: false,
			message:
				"Cloudflare AI Gateway requires a custom base URL. Please configure your gateway URL in the format: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai",
		};
	}
	return testOpenAICompatible(apiKey, baseUrl, "Cloudflare AI Gateway");
}

/**
 * Test DeepSeek connection
 */
async function testDeepSeek(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(
		apiKey,
		"https://api.deepseek.com/v1",
		"DeepSeek",
	);
}

/**
 * Test Mistral AI connection
 */
async function testMistral(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(
		apiKey,
		"https://api.mistral.ai/v1",
		"Mistral AI",
	);
}

/**
 * Test Fireworks connection
 */
async function testFireworks(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(
		apiKey,
		"https://api.fireworks.ai/inference/v1",
		"Fireworks",
	);
}

/**
 * Test Perplexity connection
 */
async function testPerplexity(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(
		apiKey,
		"https://api.perplexity.ai",
		"Perplexity",
	);
}

/**
 * Test Cohere connection
 */
async function testCohere(apiKey: string): Promise<ConnectionTestResult> {
	const start = Date.now();
	try {
		const response = await fetch("https://api.cohere.ai/v1/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(10000), // 10 second timeout
		});

		if (response.status === 401) {
			return {
				success: false,
				message: "Connection failed: Invalid credentials",
			};
		}

		if (!response.ok) {
			return {
				success: false,
				message: "Connection failed: Provider returned an error",
			};
		}

		const data = (await response.json()) as {
			models?: Array<{ name: string }>;
		};
		const models = data.models?.map((m) => m.name).slice(0, 20);

		return {
			success: true,
			message: "Connected to Cohere successfully",
			latencyMs: Date.now() - start,
			models,
		};
	} catch (error) {
		return {
			success: false,
			message: "Connection test failed",
			error:
				error instanceof Error && error.name === "TimeoutError"
					? "Request timed out"
					: undefined,
		};
	}
}

/**
 * Test OpenRouter connection
 */
async function testOpenRouter(apiKey: string): Promise<ConnectionTestResult> {
	return testOpenAICompatible(
		apiKey,
		"https://openrouter.ai/api/v1",
		"OpenRouter",
	);
}

/**
 * Test Azure AI Foundry (Azure OpenAI) connection
 * Azure uses api-key header and different endpoint format
 */
async function testAzureAIFoundry(
	apiKey: string,
	baseUrl?: string,
): Promise<ConnectionTestResult> {
	if (!baseUrl) {
		return {
			success: false,
			message:
				"Azure AI Foundry requires a base URL. Please provide your Azure OpenAI resource endpoint (e.g., https://{resource-name}.openai.azure.com)",
		};
	}

	const start = Date.now();
	try {
		// Azure OpenAI uses a different endpoint format and api-key header
		// Try the deployments endpoint first (more reliable)
		const deploymentsUrl = `${baseUrl.replace(/\/$/, "")}/openai/deployments?api-version=2025-01-01-preview`;
		const response = await fetch(deploymentsUrl, {
			headers: {
				"api-key": apiKey,
			},
			signal: AbortSignal.timeout(10000), // 10 second timeout
		});

		if (response.status === 401) {
			return {
				success: false,
				message: "Connection failed: Invalid credentials",
			};
		}

		if (response.status === 403) {
			return {
				success: false,
				message: "Connection failed: Insufficient permissions",
			};
		}

		if (response.status === 404) {
			// Try models endpoint as fallback
			const modelsUrl = `${baseUrl.replace(/\/$/, "")}/openai/models?api-version=2025-01-01-preview`;
			const modelsResponse = await fetch(modelsUrl, {
				headers: {
					"api-key": apiKey,
				},
				signal: AbortSignal.timeout(10000), // 10 second timeout
			});

			if (modelsResponse.status === 401) {
				return {
					success: false,
					message: "Connection failed: Invalid credentials",
				};
			}

			if (modelsResponse.ok) {
				return {
					success: true,
					message: "Connected to Azure AI Foundry successfully",
					latencyMs: Date.now() - start,
				};
			}

			// If both fail with 404, the endpoint might be wrong
			return {
				success: false,
				message:
					"Connection failed: Could not reach Azure OpenAI API. Please verify your resource endpoint URL.",
			};
		}

		if (!response.ok) {
			return {
				success: false,
				message: "Connection failed: Provider returned an error",
			};
		}

		const data = (await response.json()) as {
			data?: Array<{ id: string; model: string }>;
		};
		const models = data.data?.map((d) => d.model || d.id).slice(0, 20);

		return {
			success: true,
			message: "Connected to Azure AI Foundry successfully",
			latencyMs: Date.now() - start,
			models,
		};
	} catch (error) {
		// Check if it's a network error (invalid URL)
		if (error instanceof TypeError && error.message.includes("fetch")) {
			return {
				success: false,
				message:
					"Connection failed: Could not connect to Azure. Please verify your resource endpoint URL.",
				error: error.message,
			};
		}
		return {
			success: false,
			message: "Connection test failed",
			error:
				error instanceof Error && error.name === "TimeoutError"
					? "Request timed out"
					: error instanceof Error
						? error.message
						: undefined,
		};
	}
}

/**
 * Get the test function for a provider
 */
async function testDatabricks(
	apiKey: string,
	baseUrl?: string,
): Promise<ConnectionTestResult> {
	if (!baseUrl) {
		return {
			success: false,
			message:
				"Databricks requires a workspace URL (e.g., https://{workspace-id}.cloud.databricks.com)",
		};
	}

	const start = Date.now();

	// Best-effort model listing — this also confirms the credential when it
	// succeeds, and surfaces the available model/endpoint names.
	const list = await listDatabricksModels(baseUrl, apiKey);
	if (list.ok) {
		return {
			success: true,
			message: "Connected to Databricks successfully",
			latencyMs: Date.now() - start,
			models: list.models.slice(0, 20),
		};
	}
	if (list.status === 401) {
		return {
			success: false,
			message: "Connection failed: Invalid credentials",
		};
	}

	// Listing failed for another reason — e.g. the token can query models but
	// not list them, or the configured Unity AI Gateway base exposes no /models
	// route. Fall back to a least-privilege identity check so a valid,
	// inference-capable token still connects rather than false-failing on a 403.
	const auth = await validateDatabricksToken(baseUrl, apiKey);
	if (auth.ok) {
		return {
			success: true,
			message:
				"Connected to Databricks (token valid; could not list models — enter model/endpoint names manually in AI Models)",
			latencyMs: Date.now() - start,
		};
	}
	return {
		success: false,
		message: `Connection failed: ${auth.message}`,
	};
}

/**
 * Exchange a Databricks service principal for a workspace access token so the
 * normal `testDatabricks` checks can run against it.
 *
 * Returns a FAILED `ConnectionTestResult` rather than throwing when the
 * exchange itself fails, so the user can tell "your client ID/secret is wrong"
 * apart from "the workspace rejected an otherwise valid token" — the two have
 * completely different fixes.
 */
async function exchangeServicePrincipalForToken(
	baseUrl: string | undefined,
	clientId: string,
	clientSecret: string,
): Promise<{ token: string } | { failure: ConnectionTestResult }> {
	if (!baseUrl) {
		return {
			failure: {
				success: false,
				message:
					"Databricks service-principal authentication requires a workspace URL (e.g., https://{workspace-id}.cloud.databricks.com)",
			},
		};
	}

	try {
		return {
			token: await getDatabricksOAuthToken(
				baseUrl,
				clientId,
				clientSecret,
			),
		};
	} catch (error) {
		return {
			failure: {
				success: false,
				message:
					"Service principal authentication failed. Check the client ID and client secret, and that the service principal has access to this workspace.",
				error:
					error instanceof DatabricksOAuthError ||
					error instanceof Error
						? error.message
						: undefined,
			},
		};
	}
}

function getProviderTester(
	provider: AIProviderType,
): (
	apiKey: string,
	config?: Record<string, unknown>,
) => Promise<ConnectionTestResult> {
	switch (provider) {
		case "OPENAI_DIRECT":
			return (apiKey) =>
				testOpenAICompatible(
					apiKey,
					"https://api.openai.com/v1",
					"OpenAI",
				);
		case "GROQ":
			return (apiKey) =>
				testOpenAICompatible(
					apiKey,
					"https://api.groq.com/openai/v1",
					"Groq",
				);
		case "TOGETHER_AI":
			return (apiKey) =>
				testOpenAICompatible(
					apiKey,
					"https://api.together.xyz/v1",
					"Together AI",
				);
		case "ANTHROPIC_DIRECT":
			return testAnthropic;
		case "VERCEL_GATEWAY":
			return testVercelGateway;
		case "DEEPSEEK":
			return testDeepSeek;
		case "MISTRAL_AI":
			return testMistral;
		case "FIREWORKS":
			return testFireworks;
		case "PERPLEXITY":
			return testPerplexity;
		case "COHERE":
			return testCohere;
		case "OPENROUTER":
			return testOpenRouter;
		case "CLOUDFLARE_AI":
			return (apiKey, config) =>
				testCloudflareGateway(
					apiKey,
					config?.baseUrl as string | undefined,
				);
		case "XAI":
			return testXAI;
		case "CEREBRAS":
			return testCerebras;
		case "AZURE_AI_FOUNDRY":
			return (apiKey, config) =>
				testAzureAIFoundry(
					apiKey,
					config?.baseUrl as string | undefined,
				);
		case "DATABRICKS":
			return (apiKey, config) =>
				testDatabricks(apiKey, config?.baseUrl as string | undefined);
		case "AWS_BEDROCK":
		case "GOOGLE_VERTEX_AI":
			return async () => ({
				success: false,
				message: `${provider} connection testing not yet implemented`,
			});
		default:
			return async () => ({
				success: false,
				message: `Unknown provider: ${provider}`,
			});
	}
}

export const testProviderConnectionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "POST",
		path: "/ai-config/providers/test",
		tags: ["AI Config"],
		summary: "Test AI provider connection",
		description:
			"Test if an AI provider API key is valid and the connection works",
	})
	.input(
		z
			.object({
				provider: AIProviderEnum,
				// Optional so a Databricks service principal can be tested
				// instead; the superRefine below requires one of the two.
				apiKey: z.string().min(1).optional(),
				clientId: z.string().min(1).optional(),
				clientSecret: z.string().min(1).optional(),
				baseUrl: z.string().url().optional(),
				config: z.record(z.string(), z.unknown()).optional(),
			})
			.superRefine((input, ctx) => {
				// Identical rules to `upsert` — including rejecting BOTH modes
				// at once, which previously slipped through here and silently
				// tested only the PAT, greenlighting an unverified credential.
				refineProviderCredentials(
					input,
					ctx,
					input.provider === "DATABRICKS",
					input.provider,
				);
			}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
			latencyMs: z.number().optional(),
			models: z.array(z.string()).optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Check rate limit before processing
		const rateLimitResult = await checkConnectionTestRateLimit(
			context.user.id,
		);
		if (!rateLimitResult.allowed) {
			if (rateLimitResult.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many connection test attempts. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
			});
		}

		// Validate baseUrl if provided (SSRF protection)
		if (input.baseUrl) {
			const urlValidation = validateProviderUrl(
				input.baseUrl,
				input.provider,
			);
			if (!urlValidation.valid) {
				return {
					success: false,
					message: urlValidation.error || "Invalid URL",
				};
			}
		}

		// Service-principal mode: mint a workspace access token first, then run
		// the ordinary provider checks against it. A failed exchange returns
		// its own distinct message rather than a generic connection failure.
		let bearerToken = input.apiKey;
		if (!bearerToken && input.clientId && input.clientSecret) {
			const exchanged = await exchangeServicePrincipalForToken(
				input.baseUrl,
				input.clientId,
				input.clientSecret,
			);
			if ("failure" in exchanged) {
				return exchanged.failure;
			}
			bearerToken = exchanged.token;
		}

		if (!bearerToken) {
			return {
				success: false,
				message: "No credentials supplied to test",
			};
		}

		const tester = getProviderTester(input.provider);

		try {
			// Merge baseUrl into config for providers that need it
			const configWithBaseUrl = {
				...input.config,
				baseUrl: input.baseUrl,
			};
			const result = await tester(bearerToken, configWithBaseUrl);
			return result;
		} catch (_error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to test provider connection",
			});
		}
	});

/**
 * Test a saved/configured provider connection
 * Uses the stored encrypted API key to test the connection
 */
export const testSavedProviderConnectionProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.ORG_AI_CONFIG_READ))
	.route({
		method: "POST",
		path: "/ai-config/providers/test-saved",
		tags: ["AI Config"],
		summary: "Test saved AI provider connection",
		description:
			"Test if a saved AI provider configuration is still valid and working",
	})
	.input(
		z.object({
			provider: AIProviderEnum,
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			success: z.boolean(),
			message: z.string(),
			latencyMs: z.number().optional(),
			models: z.array(z.string()).optional(),
			error: z.string().optional(),
		}),
	)
	.handler(async ({ input, context: { user, session } }) => {
		// Check rate limit before processing
		const rateLimitResult = await checkConnectionTestRateLimit(user.id);
		if (!rateLimitResult.allowed) {
			if (rateLimitResult.statusCode === 503) {
				throw new ORPCError("SERVICE_UNAVAILABLE", {
					message: "Rate limit service temporarily unavailable",
				});
			}
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many connection test attempts. Please try again in ${rateLimitResult.resetInSeconds} seconds.`,
			});
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);
		const provider = input.provider as AIProvider;

		// Get the saved provider config
		let config: {
			provider: string;
			encryptedApiKey: string | null;
			clientId: string | null;
			encryptedClientSecret: string | null;
			config: unknown;
		} | null = null;

		if (organizationId) {
			config = await db.cloudProviderConfig.findUnique({
				where: {
					organizationId_provider: {
						organizationId,
						provider,
					},
				},
			});
		} else {
			config = await db.userCloudProviderConfig.findUnique({
				where: {
					userId_provider: {
						userId: user.id,
						provider,
					},
				},
			});
		}

		if (!config) {
			return {
				success: false,
				message: `Provider ${provider} is not configured`,
			};
		}

		const configData = (config.config as Record<string, unknown>) || {};
		// Check both new encryptedApiKey column and legacy config.apiKey for backward compatibility
		const encryptedApiKey =
			config.encryptedApiKey || (configData.apiKey as string | undefined);
		// A service-principal config has no stored API key — it mints one.
		const hasServicePrincipal = !!(
			config.clientId && config.encryptedClientSecret
		);

		if (!encryptedApiKey && !hasServicePrincipal) {
			return {
				success: false,
				message: `No credentials found for provider ${provider}`,
			};
		}

		// Validate baseUrl if present (SSRF protection)
		const baseUrl = configData.baseUrl as string | undefined;
		if (baseUrl) {
			const urlValidation = validateProviderUrl(baseUrl, input.provider);
			if (!urlValidation.valid) {
				return {
					success: false,
					message:
						urlValidation.error ||
						"Invalid provider URL configuration",
				};
			}
		}

		// Resolve the bearer token: decrypt the stored key, or exchange the
		// stored service principal for a workspace access token.
		let apiKey: string;
		if (encryptedApiKey) {
			try {
				apiKey = decryptApiKey(encryptedApiKey);
			} catch (error) {
				return {
					success: false,
					message:
						"Failed to decrypt API key. Please reconfigure the provider.",
					error:
						error instanceof Error
							? error.message
							: "Decryption failed",
				};
			}
		} else {
			let clientSecret: string;
			try {
				clientSecret = decryptApiKey(
					config.encryptedClientSecret as string,
				);
			} catch (error) {
				return {
					success: false,
					message:
						"Failed to decrypt the service principal secret. Please reconfigure the provider.",
					error:
						error instanceof Error
							? error.message
							: "Decryption failed",
				};
			}

			const exchanged = await exchangeServicePrincipalForToken(
				baseUrl,
				config.clientId as string,
				clientSecret,
			);
			if ("failure" in exchanged) {
				return exchanged.failure;
			}
			apiKey = exchanged.token;
		}

		// Get the tester for this provider
		const tester = getProviderTester(input.provider);

		try {
			const testConfig = {
				baseUrl: configData.baseUrl as string | undefined,
			};
			const result = await tester(apiKey, testConfig);
			return result;
		} catch (error) {
			return {
				success: false,
				message: "Failed to test provider connection",
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});
