import { embed, generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddingModel, getModel } from "../model-factory";

const fetchMock = vi.fn();

const chatReply = {
	id: "chatcmpl-1",
	object: "chat.completion",
	created: 1,
	model: "prod-chat",
	choices: [
		{
			index: 0,
			message: { role: "assistant", content: "ok" },
			finish_reason: "stop",
		},
	],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const embeddingReply = {
	object: "list",
	data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }],
	model: "prod-embed",
	usage: { prompt_tokens: 1, total_tokens: 1 },
};

function lastRequest() {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
	return {
		url: new URL(url),
		headers: new Headers(init.headers),
		body: JSON.parse(init.body as string) as Record<string, unknown>,
	};
}

beforeEach(() => {
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const v1Endpoint =
	"https://example-resource.services.ai.azure.com/api/projects/example-project/openai/v1";
const classicEndpoint = "https://example-resource.openai.azure.com";

describe("Azure AI Foundry chat requests", () => {
	const respond = () =>
		fetchMock.mockImplementation(async () => Response.json(chatReply));

	it("sends a project-scoped v1 endpoint to /chat/completions with the deployment as model and no api-version", async () => {
		respond();

		await generateText({
			model: getModel("azure-ai-foundry/gpt-4o", {
				provider: "AZURE_AI_FOUNDRY",
				apiKey: "azure-key",
				baseUrl: `${v1Endpoint}/`,
				deploymentName: "prod-chat",
			}),
			prompt: "hi",
		});

		const { url, headers, body } = lastRequest();
		expect(`${url.origin}${url.pathname}`).toBe(
			`${v1Endpoint}/chat/completions`,
		);
		expect(url.searchParams.has("api-version")).toBe(false);
		expect(headers.get("api-key")).toBe("azure-key");
		expect(body.model).toBe("prod-chat");
	});

	it("keeps routing a classic endpoint by deployment path with api-version", async () => {
		respond();

		await generateText({
			model: getModel("azure-ai-foundry/gpt-4o", {
				provider: "AZURE_AI_FOUNDRY",
				apiKey: "azure-key",
				baseUrl: classicEndpoint,
				deploymentName: "prod-chat",
			}),
			prompt: "hi",
		});

		const { url, body } = lastRequest();
		expect(url.pathname).toBe(
			"/openai/deployments/prod-chat/chat/completions",
		);
		expect(url.searchParams.get("api-version")).toBe("2025-01-01-preview");
		expect(body.model).toBe("");
	});
});

describe("Azure AI Foundry embedding requests", () => {
	const respond = () =>
		fetchMock.mockImplementation(async () => Response.json(embeddingReply));

	it("sends a v1 endpoint to /embeddings with the deployment as model and no api-version", async () => {
		respond();

		await embed({
			model: getEmbeddingModel("text-embedding-3-small", {
				provider: "AZURE_AI_FOUNDRY",
				apiKey: "azure-key",
				baseUrl: v1Endpoint,
				deploymentName: "prod-embed",
			}),
			value: "hi",
		});

		const { url, body } = lastRequest();
		expect(`${url.origin}${url.pathname}`).toBe(`${v1Endpoint}/embeddings`);
		expect(url.searchParams.has("api-version")).toBe(false);
		expect(body.model).toBe("prod-embed");
	});

	it("keeps routing a classic endpoint by deployment path with api-version", async () => {
		respond();

		await embed({
			model: getEmbeddingModel("text-embedding-3-small", {
				provider: "AZURE_AI_FOUNDRY",
				apiKey: "azure-key",
				baseUrl: classicEndpoint,
				deploymentName: "prod-embed",
			}),
			value: "hi",
		});

		const { url } = lastRequest();
		expect(url.pathname).toBe("/openai/deployments/prod-embed/embeddings");
		expect(url.searchParams.get("api-version")).toBe("2025-01-01-preview");
	});
});
