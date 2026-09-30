import { describe, expect, it } from "vitest";
import {
	AZURE_OPENAI_API_VERSION,
	normalizeAzureEndpoint,
	resolveAzureDeploymentTarget,
} from "../lib/azure-foundry-url";

const origin = "https://example-resource.services.ai.azure.com";

describe("resolveAzureDeploymentTarget", () => {
	describe("classic resource endpoint", () => {
		it("routes by deployment path with the shared api-version", () => {
			expect(
				resolveAzureDeploymentTarget(
					"https://example-resource.openai.azure.com",
					"gpt-4o",
				),
			).toEqual({
				baseURL:
					"https://example-resource.openai.azure.com/openai/deployments/gpt-4o",
				model: "",
				apiVersion: AZURE_OPENAI_API_VERSION,
			});
		});

		it("drops trailing slashes and surrounding whitespace", () => {
			expect(
				resolveAzureDeploymentTarget(
					" https://example-resource.cognitiveservices.azure.com// ",
					" prod-chat ",
				).baseURL,
			).toBe(
				"https://example-resource.cognitiveservices.azure.com/openai/deployments/prod-chat",
			);
		});

		it("keeps a deployment name inside its own path segment", () => {
			expect(
				resolveAzureDeploymentTarget(
					"https://example-resource.openai.azure.com",
					"../models?x=1",
				).baseURL,
			).toBe(
				"https://example-resource.openai.azure.com/openai/deployments/..%2Fmodels%3Fx%3D1",
			);
		});

		it("pins the api-version the model factory and connection test share", () => {
			expect(AZURE_OPENAI_API_VERSION).toBe("2025-01-01-preview");
		});
	});

	describe("pasted URL shapes reduce to the origin", () => {
		const classic = {
			baseURL: `${origin}/openai/deployments/prod-chat`,
			model: "",
			apiVersion: AZURE_OPENAI_API_VERSION,
		};
		const v1 = {
			baseURL: `${origin}/openai/v1`,
			model: "prod-chat",
			apiVersion: null,
		};

		it.each([
			[
				"portal Target URI",
				`${origin}/openai/deployments/prod-chat/chat/completions?api-version=2024-10-21`,
				classic,
			],
			["trailing /openai", `${origin}/openai`, classic],
			["/models path", `${origin}/models`, classic],
			[
				"project path without /openai/v1",
				`${origin}/api/projects/example-project`,
				classic,
			],
			["query string and fragment", `${origin}/?x=1#frag`, classic],
			["v1 request URL", `${origin}/openai/v1/chat/completions`, v1],
			["v1 embeddings URL", `${origin}/openai/v1/embeddings?x=1`, v1],
			["mixed-case /OpenAI/V1", `${origin}/OpenAI/V1`, v1],
			[
				"project v1 request URL",
				`${origin}/api/projects/example-project/openai/v1/chat/completions`,
				v1,
			],
			[
				"upper-case host",
				"https://EXAMPLE-RESOURCE.services.ai.azure.com/openai/v1/",
				v1,
			],
		])("%s", (_label, baseUrl, expected) => {
			expect(resolveAzureDeploymentTarget(baseUrl, "prod-chat")).toEqual(
				expected,
			);
		});

		it("does not treat /openai/v10 as v1", () => {
			expect(normalizeAzureEndpoint(`${origin}/openai/v10`).isV1).toBe(
				false,
			);
		});
	});

	describe("project-scoped v1 endpoint", () => {
		const projectV1 =
			"https://example-resource.services.ai.azure.com/api/projects/example-project/openai/v1";
		const resourceV1 =
			"https://example-resource.services.ai.azure.com/openai/v1";

		it.each([projectV1, `${projectV1}/`, ` ${projectV1}// `])(
			"collapses a project URL to the resource-level base with the deployment as model and no api-version for %j",
			(baseUrl) => {
				expect(
					resolveAzureDeploymentTarget(baseUrl, " prod-chat "),
				).toEqual({
					baseURL: resourceV1,
					model: "prod-chat",
					apiVersion: null,
				});
			},
		);

		it.each([resourceV1, `${resourceV1}/`])(
			"leaves a resource-level v1 URL as it is for %j",
			(baseUrl) => {
				expect(
					resolveAzureDeploymentTarget(baseUrl, "prod-chat"),
				).toEqual({
					baseURL: resourceV1,
					model: "prod-chat",
					apiVersion: null,
				});
			},
		);
	});
});
