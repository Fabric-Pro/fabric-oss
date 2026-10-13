/**
 * Unit tests for the Atlassian Rovo cloudId injection guards used by the generic
 * MCP tool-execution route.
 */

import { describe, expect, it, vi } from "vitest";
import {
	clearSiteIdCacheForTests,
	getToolParamNames,
	injectAtlassianCloudId,
	resolveAtlassianSiteId,
	toolDeclaresCloudId,
} from "../atlassian-cloud-id";

// Tool-object shapes mirror what `client.tools()` (AI SDK) yields: either a JSON
// Schema (optionally wrapped as { jsonSchema }) or a Zod schema under
// parameters._def.shape (function in v3, object in v4).
const jsonSchemaTool = (
	props: Record<string, unknown>,
	required?: string[],
) => ({
	inputSchema: {
		type: "object",
		properties: props,
		required: required ?? [],
	},
});
const wrappedTool = (props: Record<string, unknown>) => ({
	inputSchema: { jsonSchema: { type: "object", properties: props } },
});
const zodFnTool = (props: Record<string, unknown>) => ({
	parameters: { _def: { shape: () => props } },
});
const zodObjTool = (props: Record<string, unknown>) => ({
	parameters: { _def: { shape: props } },
});

describe("getToolParamNames", () => {
	it("reads JSON Schema properties", () => {
		expect(
			getToolParamNames(jsonSchemaTool({ cloudId: {}, spaceId: {} })),
		).toEqual(["cloudId", "spaceId"]);
	});

	it("unwraps the { jsonSchema } wrapper", () => {
		expect(
			getToolParamNames(wrappedTool({ cloudId: {}, limit: {} })),
		).toEqual(["cloudId", "limit"]);
	});

	it("reads a Zod shape provided as a function (v3) or object (v4)", () => {
		expect(getToolParamNames(zodFnTool({ cloudId: {}, jql: {} }))).toEqual([
			"cloudId",
			"jql",
		]);
		expect(getToolParamNames(zodObjTool({ cloudId: {}, cql: {} }))).toEqual(
			["cloudId", "cql"],
		);
	});

	it("returns [] for null / param-less tools", () => {
		expect(getToolParamNames(null)).toEqual([]);
		expect(getToolParamNames(jsonSchemaTool({}))).toEqual([]);
	});
});

describe("toolDeclaresCloudId", () => {
	it("detects a cloudId param case-insensitively", () => {
		expect(toolDeclaresCloudId(jsonSchemaTool({ cloudId: {} }))).toBe(true);
		expect(toolDeclaresCloudId(jsonSchemaTool({ CloudID: {} }))).toBe(true);
	});

	it("is false for tools without a cloudId param", () => {
		// getAccessibleAtlassianResources / atlassianUserInfo take no cloudId.
		expect(toolDeclaresCloudId(jsonSchemaTool({}))).toBe(false);
		expect(toolDeclaresCloudId(jsonSchemaTool({ pageId: {} }))).toBe(false);
	});
});

describe("injectAtlassianCloudId", () => {
	const tool = jsonSchemaTool({ cloudId: {}, spaceId: {} }, ["cloudId"]);

	it("injects the stored cloudId when the tool declares the param", () => {
		expect(
			injectAtlassianCloudId({ spaceId: "s1" }, tool, "cloud-123"),
		).toEqual({ spaceId: "s1", cloudId: "cloud-123" });
	});

	it("no-ops when no cloudId is stored (non-Atlassian connection)", () => {
		const params = { spaceId: "s1" };
		expect(injectAtlassianCloudId(params, tool, null)).toBe(params);
		expect(injectAtlassianCloudId(params, tool, undefined)).toBe(params);
		expect(injectAtlassianCloudId(params, tool, "")).toBe(params);
	});

	it("does not overwrite a caller-supplied cloudId (client value wins)", () => {
		const params = { cloudId: "explicit", spaceId: "s1" };
		expect(injectAtlassianCloudId(params, tool, "cloud-123")).toBe(params);
	});

	it("no-ops when the tool does not declare a cloudId param", () => {
		// e.g. atlassianUserInfo / getAccessibleAtlassianResources — must not be polluted.
		const params = {};
		expect(
			injectAtlassianCloudId(params, jsonSchemaTool({}), "cloud-123"),
		).toBe(params);
	});
});

describe("resolveAtlassianSiteId", () => {
	beforeEach(() => {
		clearSiteIdCacheForTests();
	});

	it("caches the resolved site ID for the same cacheKey", async () => {
		const executeMock = vi
			.fn()
			.mockResolvedValue([
				{ id: "22222222-2222-4222-8222-222222222222", name: "Site" },
			]);

		const res1 = await resolveAtlassianSiteId({
			storedSiteId: null,
			resolverTool: { execute: executeMock },
			cacheKey: "cfg-1:1",
		});
		const res2 = await resolveAtlassianSiteId({
			storedSiteId: null,
			resolverTool: { execute: executeMock },
			cacheKey: "cfg-1:1",
		});

		expect(res1).toBe("22222222-2222-4222-8222-222222222222");
		expect(res2).toBe("22222222-2222-4222-8222-222222222222");
		expect(executeMock).toHaveBeenCalledTimes(1);
	});

	it("re-resolves when cacheKey changes (different generation)", async () => {
		const executeMock = vi
			.fn()
			.mockResolvedValueOnce([
				{ id: "11111111-1111-4111-8111-111111111111", name: "Site A" },
			])
			.mockResolvedValueOnce([
				{ id: "22222222-2222-4222-8222-222222222222", name: "Site B" },
			]);

		const res1 = await resolveAtlassianSiteId({
			storedSiteId: null,
			resolverTool: { execute: executeMock },
			cacheKey: "cfg-1:1",
		});
		const res2 = await resolveAtlassianSiteId({
			storedSiteId: null,
			resolverTool: { execute: executeMock },
			cacheKey: "cfg-1:2",
		});

		expect(res1).toBe("11111111-1111-4111-8111-111111111111");
		expect(res2).toBe("22222222-2222-4222-8222-222222222222");
		expect(executeMock).toHaveBeenCalledTimes(2);
	});

	it("returns null without crashing when resolver throws", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const executeMock = vi
			.fn()
			.mockRejectedValue(new Error("network failure"));

		const result = await resolveAtlassianSiteId({
			storedSiteId: null,
			resolverTool: { execute: executeMock },
			cacheKey: "cfg-1:1",
		});

		expect(result).toBeNull();
		warnSpy.mockRestore();
	});

	it("applies parseResult before extracting the site ID", async () => {
		const executeMock = vi.fn().mockResolvedValue({
			content: [
				{
					type: "text",
					text: JSON.stringify([
						{ id: "11111111-1111-4111-8111-111111111111" },
					]),
				},
			],
		});
		const parseResult = (raw: unknown) => {
			const text = (raw as { content: Array<{ text: string }> })
				.content[0]?.text;
			return JSON.parse(text);
		};

		const result = await resolveAtlassianSiteId({
			storedSiteId: null,
			resolverTool: { execute: executeMock },
			cacheKey: "cfg-1:1",
			parseResult,
		});

		expect(result).toBe("11111111-1111-4111-8111-111111111111");
	});
});
