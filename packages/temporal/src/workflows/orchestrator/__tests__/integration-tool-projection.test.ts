/**
 * Projection of discovered integrations into synthetic chat tools.
 *
 * Two things are load-bearing here: which configuration a provider's tools bind
 * to when a tenant has several, and that each operation's arguments are bound to
 * that operation without any JSON Schema combinator (see the compatibility
 * contract in __tests__/fabric-ai-tools-schema.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
	buildIntegrationToolProjections,
	type DiscoveredIntegration,
	projectIntegrationTools,
} from "../integration-tool-projection";

const QUERY_INDEX_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string" },
		indexNames: { type: "array", items: { type: "string" } },
	},
	required: ["query"],
	additionalProperties: false,
};

const LIST_INDEXES_SCHEMA = {
	type: "object",
	properties: { schema: { type: "string" } },
	additionalProperties: false,
};

function discovered(
	overrides: Partial<DiscoveredIntegration> & { integrationId: string },
): DiscoveredIntegration {
	return {
		provider: "DATABRICKS_VECTOR_SEARCH",
		description: "Vector search",
		confidence: 0.5,
		operations: [
			{
				name: "query_index",
				description: "Search",
				inputSchema: QUERY_INDEX_SCHEMA,
			},
			{
				name: "list_indexes",
				description: "List",
				inputSchema: LIST_INDEXES_SCHEMA,
			},
		],
		...overrides,
	};
}

/** An integration as recorded before operation schemas were carried. */
function legacyDiscovered(integrationId: string): DiscoveredIntegration {
	return {
		integrationId,
		provider: "DATABRICKS_VECTOR_SEARCH",
		description: "Vector search",
		confidence: 0.5,
		operations: [
			{ name: "query_index", description: "Search" },
			{ name: "list_indexes", description: "List" },
		],
	};
}

describe("first-wins provider binding", () => {
	it("binds every operation tool to the highest-confidence configuration", () => {
		// Discovery returns descending confidence, so the first row is the one
		// the user's query matched.
		const projections = projectIntegrationTools([
			discovered({ integrationId: "prod-workspace", confidence: 0.91 }),
			discovered({
				integrationId: "sandbox-workspace",
				confidence: 0.44,
			}),
		]);

		expect(projections).toHaveLength(2);
		for (const projection of projections) {
			expect(projection.configId).toBe(
				"integration:DATABRICKS_VECTOR_SEARCH:prod-workspace",
			);
		}
	});

	it("keeps distinct providers while collapsing repeats of one", () => {
		const projections = projectIntegrationTools([
			discovered({ integrationId: "db-1", confidence: 0.9 }),
			{
				integrationId: "nhtsa-1",
				provider: "NHTSA_VPIC",
				description: "Vehicles",
				confidence: 0.8,
				operations: [
					{
						name: "decode_vin",
						description: "Decode",
						inputSchema: { type: "object", properties: {} },
					},
				],
			},
			discovered({ integrationId: "db-2", confidence: 0.7 }),
		]);

		expect(projections.map((p) => p.toolName)).toEqual([
			"integration__DATABRICKS_VECTOR_SEARCH__query_index",
			"integration__DATABRICKS_VECTOR_SEARCH__list_indexes",
			"integration__NHTSA_VPIC__decode_vin",
		]);
		expect(new Set(projections.map((p) => p.provider)).size).toBe(2);
	});

	it("returns nothing for no results", () => {
		expect(projectIntegrationTools([])).toEqual([]);
	});
});

describe("per-operation tools", () => {
	it("gives each operation its own tool carrying its schema at the root", () => {
		const projections = buildIntegrationToolProjections(
			discovered({ integrationId: "int-1" }),
		);

		expect(projections.map((p) => p.toolName)).toEqual([
			"integration__DATABRICKS_VECTOR_SEARCH__query_index",
			"integration__DATABRICKS_VECTOR_SEARCH__list_indexes",
		]);
		// The operation's schema IS the tool schema — no envelope, no wrapper.
		expect(projections[0].inputSchema).toBe(QUERY_INDEX_SCHEMA);
		expect(projections[1].inputSchema).toBe(LIST_INDEXES_SCHEMA);
	});

	it("binds arguments to their operation by construction", () => {
		const [queryIndexTool] = buildIntegrationToolProjections(
			discovered({ integrationId: "int-1" }),
		);

		// query_index's required field is required at the tool's root, so the
		// model cannot call it without one — no conditional needed.
		expect(queryIndexTool.inputSchema.required).toEqual(["query"]);
		expect(
			Object.keys(
				queryIndexTool.inputSchema.properties as Record<
					string,
					unknown
				>,
			),
		).toEqual(["query", "indexNames"]);
		// list_indexes' field is not reachable from query_index's tool at all.
		expect(queryIndexTool.inputSchema.additionalProperties).toBe(false);
	});

	it("names tools with the character class the repo's sanitizer allows", () => {
		const projections = projectIntegrationTools([
			discovered({ integrationId: "int-1" }),
		]);

		for (const projection of projections) {
			expect(projection.toolName).toMatch(/^[a-zA-Z0-9_]+$/);
			// Defensive bound — no provider tool-name length limit is recorded
			// in this repo, so this just keeps names comfortably short.
			expect(projection.toolName.length).toBeLessThanOrEqual(64);
		}
	});

	it("still gives an operation a tool when discovery carried no schema for it", () => {
		const projections = buildIntegrationToolProjections(
			discovered({
				integrationId: "int-1",
				operations: [
					{ name: "no_schema", description: "Legacy" },
					{
						name: "with_schema",
						description: "New",
						inputSchema: LIST_INDEXES_SCHEMA,
					},
				],
			}),
		);

		expect(projections.map((p) => p.toolName)).toEqual([
			"integration__DATABRICKS_VECTOR_SEARCH__no_schema",
			"integration__DATABRICKS_VECTOR_SEARCH__with_schema",
		]);
		expect(projections[0].inputSchema).toEqual({
			type: "object",
			properties: {},
		});
	});
});

describe("old-history fallback", () => {
	it("keeps the single provider tool with the generic envelope", () => {
		const projections = buildIntegrationToolProjections(
			legacyDiscovered("int-1"),
		);

		expect(projections).toHaveLength(1);
		expect(projections[0].toolName).toBe(
			"integration__DATABRICKS_VECTOR_SEARCH",
		);

		const properties = projections[0].inputSchema.properties as Record<
			string,
			Record<string, unknown>
		>;
		expect(properties.operation.enum).toEqual([
			"query_index",
			"list_indexes",
		]);
		expect(properties.args).toEqual({
			type: "object",
			description: "Arguments for the operation",
		});
		expect(projections[0].inputSchema.required).toEqual(["operation"]);
	});

	it("describes the operations inline as it did before", () => {
		const [projection] = buildIntegrationToolProjections(
			legacyDiscovered("int-1"),
		);

		expect(projection.description).toBe(
			"Vector search. Available operations: query_index: Search; list_indexes: List. Use the 'operation' parameter with one of: query_index, list_indexes",
		);
	});
});
