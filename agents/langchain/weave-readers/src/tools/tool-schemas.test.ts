/**
 * Tool input-schema rendering tests
 *
 * These tools were originally built with the pre-v5 `parameters` key behind
 * an `as any` cast, so `ai` 6 saw no `inputSchema`, substituted an empty
 * object schema, and advertised every tool to the model with no properties.
 * The model could only call `webSearch` with `{}`, and `execute` received
 * `query` / `url` / `path` as `undefined`.
 *
 * Each test drives a real factory through `generateText` with a mock model
 * and pins the JSON Schema the model is actually sent, so a regression in
 * the option name — or in the zod-to-JSON-Schema conversion — fails here
 * rather than as silently argument-less tool calls in production.
 */

import assert from "node:assert/strict";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, it } from "vitest";
import type { SandboxClient } from "../lib/sandbox-client.js";
import { createReadOnlySandboxTools } from "./sandbox.js";
import { createWebFetchTools } from "./web-fetch.js";
import { createWebSearchTools } from "./web-search.js";

type JsonObjectSchema = {
	type?: string;
	properties?: Record<string, { type?: string }>;
	required?: string[];
};

/**
 * Run one `generateText` call with the given tools and return the JSON
 * Schema each tool was rendered with, keyed by tool name. The mock model
 * answers with plain text so no tool executes; only the request matters.
 */
async function renderToolSchemas(
	tools: Parameters<typeof generateText>[0]["tools"],
): Promise<Record<string, JsonObjectSchema>> {
	let rendered: Array<{
		type: string;
		name?: string;
		inputSchema?: unknown;
	}> = [];

	// AI SDK 7 ships both MockLanguageModelV3 and MockLanguageModelV4. The
	// installed providers implement the v4 language-model spec (and @repo/ai's
	// middleware declares `specificationVersion: "v4"`), so the mock must be V4
	// or this test pins the schema the v3 compatibility path renders rather
	// than the one production sends.
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			rendered = (options.tools ?? []) as typeof rendered;
			return {
				content: [{ type: "text", text: "ok" }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: {
						total: 1,
						noCache: 1,
						cacheRead: 0,
						cacheWrite: 0,
					},
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
	});

	await generateText({ model, tools, prompt: "go" });

	return Object.fromEntries(
		rendered
			.filter((t) => t.type === "function" && typeof t.name === "string")
			.map((t) => [t.name as string, t.inputSchema as JsonObjectSchema]),
	);
}

function assertHasProperties(
	name: string,
	schema: JsonObjectSchema | undefined,
	expected: string[],
) {
	assert.ok(schema, `${name} was not sent to the model`);
	assert.equal(schema.type, "object", `${name} schema type`);
	for (const key of expected) {
		assert.ok(
			schema.properties && key in schema.properties,
			`${name} schema is missing property "${key}" — got ${JSON.stringify(schema)}`,
		);
	}
}

describe("weave-readers tool input schemas", () => {
	it("advertises the web-search tools with their zod fields", async () => {
		const schemas = await renderToolSchemas(createWebSearchTools());

		assertHasProperties("webSearch", schemas.webSearch, [
			"query",
			"numResults",
		]);
		assert.equal(schemas.webSearch?.properties?.query?.type, "string");
		assert.ok(
			schemas.webSearch?.required?.includes("query"),
			"webSearch.query should be required",
		);

		assertHasProperties("fetchUrl", schemas.fetchUrl, ["url"]);
		assertHasProperties("searchNpm", schemas.searchNpm, ["query"]);
		assertHasProperties("searchGitHub", schemas.searchGitHub, ["query"]);
	});

	it("advertises the web-fetch tools with their zod fields", async () => {
		const schemas = await renderToolSchemas(createWebFetchTools());

		assertHasProperties("fetchRfc", schemas.fetchRfc, ["url", "section"]);
		assert.ok(
			schemas.fetchRfc?.required?.includes("url"),
			"fetchRfc.url should be required",
		);
		assert.ok(
			!schemas.fetchRfc?.required?.includes("section"),
			"fetchRfc.section should stay optional",
		);

		// clearRfcCache genuinely takes no input; an empty schema is correct
		// here, which is what makes the non-empty assertions above meaningful.
		assert.ok(schemas.clearRfcCache, "clearRfcCache was not sent");
		assert.deepEqual(schemas.clearRfcCache.properties ?? {}, {});
	});

	it("advertises the read-only sandbox tools with their zod fields", async () => {
		const schemas = await renderToolSchemas(
			createReadOnlySandboxTools({} as SandboxClient),
		);

		for (const name of [
			"readFile",
			"listFiles",
			"searchCode",
			"execCommand",
		]) {
			const schema = schemas[name];
			assert.ok(schema, `${name} was not sent to the model`);
			assert.equal(schema.type, "object", `${name} schema type`);
			assert.ok(
				Object.keys(schema.properties ?? {}).length > 0,
				`${name} rendered with no properties — got ${JSON.stringify(schema)}`,
			);
		}
	});
});
