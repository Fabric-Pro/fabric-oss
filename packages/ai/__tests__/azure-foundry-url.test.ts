import { describe, expect, it } from "vitest";
import {
	AZURE_OPENAI_API_VERSION,
	resolveAzureDeploymentTarget,
} from "../lib/azure-foundry-url";

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
