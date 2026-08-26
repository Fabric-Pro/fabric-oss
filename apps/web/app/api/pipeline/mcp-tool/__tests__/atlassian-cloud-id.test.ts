/**
 * Unit tests for the Atlassian Rovo cloudId injection guards used by the generic
 * MCP tool-execution route.
 */

import { describe, expect, it } from "vitest";
import {
	getToolParamNames,
	injectAtlassianCloudId,
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
