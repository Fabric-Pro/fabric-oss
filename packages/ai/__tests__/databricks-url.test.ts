import { describe, expect, it } from "vitest";
import { toDatabricksInferenceBaseUrl } from "../lib/databricks-url";

const host = "https://example.cloud.databricks.com";
describe("Databricks model-aware inference URL", () => {
	it.each([
		[host, "system.ai.claude-sonnet-5", `${host}/ai-gateway/mlflow/v1`],
		[
			` ${host}/// `,
			"catalog.schema.model",
			`${host}/ai-gateway/mlflow/v1`,
		],
		[
			`${host}/serving-endpoints///`,
			"system.ai.gte-large-en",
			`${host}/ai-gateway/mlflow/v1`,
		],
		...[
			"custom-chat",
			"databricks-claude-haiku-4-5",
			"ai.model",
			"a.b.c.d",
			"a..c",
			".b.c",
			"a.b.",
			"a.b.c/d",
		].map((model) => [host, model, `${host}/serving-endpoints`]),
		[
			`${host}/serving-endpoints/`,
			"custom-chat",
			`${host}/serving-endpoints`,
		],
		[
			`${host}/ai-gateway/mlflow/v1`,
			"custom-chat",
			`${host}/ai-gateway/mlflow/v1`,
		],
		[`${host}/proxy/v1`, "system.ai.claude-sonnet-5", `${host}/proxy/v1`],
		["not-a-url", "system.ai.model", "not-a-url/serving-endpoints"],
		[
			"not-a-url/serving-endpoints",
			"system.ai.model",
			"not-a-url/serving-endpoints",
		],
		[
			"not-a-url/ai-gateway/mlflow/v1",
			"custom-chat",
			"not-a-url/ai-gateway/mlflow/v1",
		],
	])("%s + %s → %s", (baseUrl, modelId, expected) => {
		expect(toDatabricksInferenceBaseUrl(baseUrl, modelId)).toBe(expected);
	});
});
