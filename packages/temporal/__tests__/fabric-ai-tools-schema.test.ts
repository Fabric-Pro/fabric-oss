import { describe, expect, it } from "vitest";
import { getAllFabricAiTools } from "../src/activities/orchestrator/tools/fabric-ai-tools";
import {
	type DiscoveredIntegration,
	projectIntegrationTools,
} from "../src/workflows/orchestrator/integration-tool-projection";

const ROOT_COMBINATORS = ["oneOf", "allOf", "anyOf"] as const;

describe("fabric-ai-tools schema compatibility", () => {
	// Anthropic (and Gemini, and OpenAI strict mode) reject tool input_schema that
	// use oneOf / allOf / anyOf at the top level. These combinators are allowed
	// nested inside `properties` / `items`, just not at the root of the schema.
	// See fizzy 000000/cards/1056.
	it("no root schema uses oneOf / allOf / anyOf", () => {
		const offenders: string[] = [];

		for (const toolDef of getAllFabricAiTools()) {
			const schema = toolDef.inputSchema;
			if (!schema) {
				continue;
			}
			for (const keyword of ["oneOf", "allOf", "anyOf"] as const) {
				if (keyword in schema) {
					offenders.push(`${toolDef.name}.${keyword}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});

/**
 * Integration tools are not a static list — the orchestrator projects them at
 * runtime from whatever discovery returned, so they can regress this contract
 * without touching `getAllFabricAiTools`. Every projection shape goes through
 * the same root-combinator check here.
 */
describe("projected integration tools schema compatibility", () => {
	const withSchemas: DiscoveredIntegration = {
		integrationId: "int-1",
		provider: "DATABRICKS_VECTOR_SEARCH",
		description: "Vector search",
		confidence: 0.9,
		operations: [
			{
				name: "query_index",
				description: "Search",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
					additionalProperties: false,
				},
			},
			{
				name: "list_indexes",
				description: "List",
				inputSchema: {
					type: "object",
					properties: { schema: { type: "string" } },
					additionalProperties: false,
				},
			},
		],
	};

	// As recorded before operation schemas were carried.
	const withoutSchemas: DiscoveredIntegration = {
		integrationId: "int-2",
		provider: "NHTSA_VPIC",
		description: "Vehicles",
		confidence: 0.8,
		operations: [{ name: "decode_vin", description: "Decode" }],
	};

	const mixed: DiscoveredIntegration = {
		integrationId: "int-3",
		provider: "SLACK",
		description: "Messaging",
		confidence: 0.7,
		operations: [
			{ name: "no_schema", description: "Legacy" },
			{
				name: "with_schema",
				description: "New",
				inputSchema: { type: "object", properties: {} },
			},
		],
	};

	it.each([
		["schema-bearing", [withSchemas]],
		["old-history fallback", [withoutSchemas]],
		["mixed operations", [mixed]],
		["all shapes together", [withSchemas, withoutSchemas, mixed]],
	])("no root oneOf / allOf / anyOf (%s)", (_label, integrations) => {
		const offenders: string[] = [];

		for (const projection of projectIntegrationTools(
			integrations as DiscoveredIntegration[],
		)) {
			for (const keyword of ROOT_COMBINATORS) {
				if (keyword in projection.inputSchema) {
					offenders.push(`${projection.toolName}.${keyword}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	it("advertises an object schema at the root of every projected tool", () => {
		for (const projection of projectIntegrationTools([
			withSchemas,
			withoutSchemas,
			mixed,
		])) {
			expect(projection.inputSchema.type, projection.toolName).toBe(
				"object",
			);
		}
	});
});
