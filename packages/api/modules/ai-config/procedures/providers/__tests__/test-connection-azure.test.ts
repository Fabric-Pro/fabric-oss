/**
 * Azure AI Foundry Test Connection.
 *
 * Three defects stacked in this one flow, each hiding the next:
 *  1. the SSRF allow-list only knew `*.openai.azure.com`, so the hosts the
 *     Azure portal hands out today failed as "Invalid provider URL" before any
 *     request was sent;
 *  2. the deployment name was saved but never sent to the test;
 *  3. the test asked Azure to LIST deployments, which current Azure AI Foundry
 *     resources do not answer, so a working key and deployment still failed.
 *
 * The probe now makes the same deployment chat request as the model factory
 * (the target resolver is shared, and loaded for real below), so a pass means
 * the app's own calls will reach the deployment. A 400 passes only when Azure's
 * error shows the model ran; a project-scoped /openai/v1 endpoint answers a
 * classic-shaped URL with a 400 that used to be read as success.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", async () => ({
	...(await vi.importActual<typeof import("@repo/ai/lib/azure-foundry-url")>(
		"@repo/ai/lib/azure-foundry-url",
	)),
	DatabricksOAuthError: class extends Error {},
	getDatabricksOAuthToken: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		cloudProviderConfig: { findUnique: vi.fn() },
		userCloudProviderConfig: { findUnique: vi.fn() },
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((v: string) => v),
}));

vi.mock("../../../lib/databricks", () => ({
	listDatabricksModels: vi.fn(),
	validateDatabricksToken: vi.fn(),
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: (...args: unknown[]) => unknown) => ({
				_handler: fn,
			}),
		});
		return chainable;
	};
	return {
		get tenantProtectedProcedure() {
			return makeChain();
		},
		resolveOrganizationId: (o: string | null | undefined) => o ?? null,
		requirePermission: vi.fn(() => ({})),
		requireInputOrgPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { db } from "@repo/database";
import {
	testProviderConnectionProcedure,
	testSavedProviderConnectionProcedure,
} from "../test-connection";

type Result = { success: boolean; message: string };
type Handler = { _handler: (args: unknown) => Promise<Result> };

const testNew = (input: Record<string, unknown>) =>
	(testProviderConnectionProcedure as unknown as Handler)._handler({
		input: { provider: "AZURE_AI_FOUNDRY", apiKey: "azure-key", ...input },
		context: { user: { id: "user-1" } },
	});

const testSaved = () =>
	(testSavedProviderConnectionProcedure as unknown as Handler)._handler({
		input: { provider: "AZURE_AI_FOUNDRY", organizationId: "org-1" },
		context: { user: { id: "user-1" }, session: {} },
	});

const fetchMock = vi.fn();

function azureResponds(status: number, body: unknown = {}) {
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

describe("Azure AI Foundry URL allow-list", () => {
	it.each([
		"https://example-resource.openai.azure.com",
		"https://example-resource.cognitiveservices.azure.com/",
		"https://example-resource.services.ai.azure.com",
		"https://example-resource.services.ai.azure.com/api/projects/example-project/openai/v1",
	])("sends the test to Azure for %s", async (baseUrl) => {
		azureResponds(200);

		const result = await testNew({ baseUrl, deploymentName: "chat" });

		expect(result.message).not.toBe("Invalid provider URL");
		expect(result.success).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		"https://example-resource.blob.core.windows.net",
		"https://openai.azure.com.example.com",
		"https://example.com/example-resource.openai.azure.com",
	])("still rejects %s without contacting it", async (baseUrl) => {
		const result = await testNew({ baseUrl, deploymentName: "chat" });

		expect(result).toEqual({
			success: false,
			message: "Invalid provider URL",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("Azure AI Foundry probe", () => {
	const baseUrl = "https://example-resource.cognitiveservices.azure.com/";

	it("probes the typed deployment with the model factory's chat request", async () => {
		azureResponds(200);

		await testNew({ baseUrl, deploymentName: "prod-chat" });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://example-resource.cognitiveservices.azure.com/openai/deployments/prod-chat/chat/completions?api-version=2025-01-01-preview",
		);
		expect(init.method).toBe("POST");
		expect(init.redirect).toBe("error");
		expect(init.headers).toMatchObject({ "api-key": "azure-key" });
		expect(JSON.parse(init.body as string)).toMatchObject({
			max_completion_tokens: 1,
		});
	});

	it("reports a redirect instead of following it with the api key", async () => {
		fetchMock.mockRejectedValue(
			new TypeError("fetch failed", {
				cause: new Error("unexpected redirect"),
			}),
		);

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/Azure redirected the request/);
	});

	it("still reports an unreachable host as a connection failure", async () => {
		fetchMock.mockRejectedValue(
			new TypeError("fetch failed", { cause: new Error("getaddrinfo") }),
		);

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/Could not connect to Azure/);
	});

	it("probes the resource origin when a full request URL is pasted", async () => {
		azureResponds(200);

		await testNew({
			baseUrl:
				"https://example-resource.cognitiveservices.azure.com/openai/deployments/other/chat/completions?api-version=2024-10-21",
			deploymentName: "prod-chat",
		});

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://example-resource.cognitiveservices.azure.com/openai/deployments/prod-chat/chat/completions?api-version=2025-01-01-preview",
		);
	});

	it("never asks Azure to list deployments", async () => {
		azureResponds(404);

		await testNew({ baseUrl, deploymentName: "prod-chat" });

		for (const [url] of fetchMock.mock.calls as [string][]) {
			expect(url).not.toMatch(/\/openai\/(deployments|models)\?/);
		}
	});

	it("asks for the deployment name instead of probing without one", async () => {
		const result = await testNew({ baseUrl });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/requires a deployment name/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("passes when an older deployment rejects the token cap (400)", async () => {
		azureResponds(400, {
			error: {
				code: "unsupported_parameter",
				param: "max_completion_tokens",
				message:
					"Unsupported parameter: 'max_completion_tokens' is not supported with this model.",
			},
		});

		const result = await testNew({ baseUrl, deploymentName: "gpt-4" });

		expect(result.success).toBe(true);
	});

	it("passes when a reasoning model runs out of the one-token cap (400)", async () => {
		azureResponds(400, {
			error: {
				code: "invalid_request_error",
				message:
					"Could not finish the message because max_tokens or model output limit was reached.",
			},
		});

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(true);
	});

	it("fails an unrecognised 400 with Azure's own message", async () => {
		azureResponds(400, {
			error: { code: "BadRequest", message: "Something else is wrong" },
		});

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(false);
		expect(result.message).toBe(
			"Connection failed: Azure rejected the request: Something else is wrong",
		);
	});

	it("fails a 400 that carries no readable error", async () => {
		fetchMock.mockResolvedValue(new Response("not json", { status: 400 }));

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(false);
		expect(result.message).toBe(
			"Connection failed: Azure rejected the request",
		);
	});

	it("fails a deployment that cannot serve chat, from Azure's real code-less body", async () => {
		azureResponds(400, {
			error: { message: "The requested operation is unsupported." },
		});

		const result = await testNew({
			baseUrl,
			deploymentName: "embeddings",
		});

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/does not support chat completions/);
	});

	it("still recognises the OperationNotSupported code", async () => {
		azureResponds(400, {
			error: { code: "OperationNotSupported", message: "Not supported" },
		});

		const result = await testNew({ baseUrl, deploymentName: "embeddings" });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/does not support chat completions/);
	});

	it.each([
		[401, /Invalid credentials/],
		[403, /Insufficient permissions/],
		[404, /no deployment named "prod-chat"/],
		[429, /rate-limiting/],
		[500, /Provider returned an error/],
	])("reports HTTP %i as a failure", async (status, message) => {
		azureResponds(status);

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(message);
	});
});

describe("Azure AI Foundry project-scoped v1 endpoint", () => {
	const baseUrl =
		"https://example-resource.services.ai.azure.com/api/projects/example-project/openai/v1/";

	it("probes <endpoint>/chat/completions with the model in the body and no api-version", async () => {
		azureResponds(200);

		await testNew({ baseUrl, deploymentName: " prod-chat " });

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://example-resource.services.ai.azure.com/openai/v1/chat/completions",
		);
		expect(init.headers).toMatchObject({ "api-key": "azure-key" });
		expect(JSON.parse(init.body as string)).toMatchObject({
			model: "prod-chat",
			max_completion_tokens: 1,
		});
	});

	it("fails a deployment that does not exist (404)", async () => {
		azureResponds(404, { error: { code: "DeploymentNotFound" } });

		const result = await testNew({ baseUrl, deploymentName: "missing" });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/no deployment named "missing"/);
		expect(result.message).toMatch(/\/openai\/v1/);
	});

	it("fails when Azure rejects an api-version parameter (400)", async () => {
		azureResponds(400, {
			error: {
				code: "BadRequest",
				message:
					"api-version query parameter is not allowed when using /v1 path",
			},
		});

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(false);
		expect(result.message).toMatch(
			/api-version query parameter is not allowed/,
		);
	});

	it("passes when the model ran but hit the token cap (400)", async () => {
		azureResponds(400, {
			error: {
				code: "invalid_request_error",
				message:
					"Could not finish the message because max_tokens or model output limit was reached.",
			},
		});

		const result = await testNew({ baseUrl, deploymentName: "prod-chat" });

		expect(result.success).toBe(true);
	});
});

describe("testing a saved Azure AI Foundry provider", () => {
	it("probes the deployment name that was saved", async () => {
		vi.mocked(db.cloudProviderConfig.findUnique).mockResolvedValue({
			provider: "AZURE_AI_FOUNDRY",
			encryptedApiKey: "azure-key",
			clientId: null,
			encryptedClientSecret: null,
			config: {
				baseUrl: "https://example-resource.services.ai.azure.com",
				deploymentName: "saved-deployment",
			},
		} as never);
		azureResponds(200);

		const result = await testSaved();

		expect(result.success).toBe(true);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"https://example-resource.services.ai.azure.com/openai/deployments/saved-deployment/chat/completions?api-version=2025-01-01-preview",
		);
	});
});
