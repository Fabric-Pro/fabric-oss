import { MODELS } from "@repo/database/prisma/ai-model-catalog";
import { describe, expect, it } from "vitest";
import {
	EMBEDDING_MODEL_CONFIG,
	embeddingModelFitsVectorStore,
	getEmbeddingDimensions,
} from "../dimensions";

describe("embedding widths", () => {
	it("records a width for catalog embedding capabilities and tasks", () => {
		const missing = MODELS.filter(
			(model) =>
				model.capabilities.includes("EMBEDDING") ||
				model.suitableForTasks.includes("EMBEDDING"),
		)
			.filter(
				(model) =>
					!Object.hasOwn(EMBEDDING_MODEL_CONFIG, model.canonicalName),
			)
			.map((model) => model.canonicalName);
		expect(missing).toEqual([]);
	});
	it.each([
		"databricks-gte-large-en",
		"databricks-bge-large-en",
		"mistral-embed",
		"cohere-embed-english",
		"cohere-embed-multilingual",
		"text-embedding-3-large",
		"unknown-embedding",
		"toString",
		"openai/text-embedding-3-small",
	])("refuses %s by canonical name", (name) => {
		expect(embeddingModelFitsVectorStore(name)).toBe(false);
	});
	it.each([
		"text-embedding-3-small",
		"text-embedding-ada-002",
		"cohere-embed-v4",
	])("accepts %s", (name) => {
		expect(embeddingModelFitsVectorStore(name)).toBe(true);
	});
	it("retains the provider-string request hint fallback", () => {
		expect(getEmbeddingDimensions("openai/text-embedding-3-large")).toBe(
			3072,
		);
		expect(getEmbeddingDimensions("custom-deployment")).toBe(1536);
	});
});
