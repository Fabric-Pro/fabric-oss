import {
	contextFieldsForProviders,
	parseTemplateDefinition,
	parseTemplateWorkspaces,
	pickPrefillContext,
} from "@saas/reports/lib/report-template-definition";
import type { ProviderContextField } from "@saas/shared/components/DataSourceDefinitionBuilder";
import { describe, expect, it } from "vitest";

const FIELDS: Record<string, ProviderContextField[]> = {
	fizzy: [
		{
			key: "accountSlug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
			helpText: "",
		},
		{
			key: "boardId",
			label: "Board",
			placeholder: "12345",
			required: true,
			helpText: "",
		},
	],
	azure_devops: [
		{
			key: "project",
			label: "Project Name",
			placeholder: "MyProject",
			required: true,
			helpText: "",
		},
		{
			key: "team",
			label: "Team Name",
			placeholder: "MyTeam",
			required: false,
			helpText: "",
		},
	],
	linear: [
		{
			key: "team",
			label: "Team Name",
			placeholder: "Engineering",
			required: true,
			helpText: "",
		},
	],
};

describe("parseTemplateDefinition", () => {
	it("keeps data sources that name a provider, and the user prompt", () => {
		const parsed = parseTemplateDefinition({
			userPrompt: "Summarize the sprint",
			dataSources: [
				{ id: "ds-1", type: "mcp", provider: "fizzy" },
				{ id: "ds-2", type: "mcp", provider: "" },
				{ id: "ds-3", type: "workspace" },
				"not an object",
			],
		});
		expect(parsed.userPrompt).toBe("Summarize the sprint");
		expect(parsed.dataSources).toEqual([
			{
				id: "ds-1",
				type: "mcp",
				provider: "fizzy",
				operation: undefined,
			},
		]);
	});

	it("reads a source without a known type as an MCP source", () => {
		const parsed = parseTemplateDefinition({
			dataSources: [{ id: "ds-1", provider: "fizzy" }],
		});
		expect(parsed.dataSources[0]?.type).toBe("mcp");
	});

	it("returns no data sources for a missing or malformed definition", () => {
		expect(parseTemplateDefinition(null).dataSources).toEqual([]);
		expect(parseTemplateDefinition("x").dataSources).toEqual([]);
		expect(
			parseTemplateDefinition({ dataSources: "x" }).dataSources,
		).toEqual([]);
	});
});

describe("parseTemplateWorkspaces", () => {
	it("reads the document-library requirement", () => {
		expect(
			parseTemplateWorkspaces({
				workspaces: { enabled: true, description: "Pick a library" },
			}),
		).toEqual({ enabled: true, description: "Pick a library" });
		expect(parseTemplateWorkspaces(null)).toEqual({ enabled: false });
	});
});

describe("contextFieldsForProviders", () => {
	it("lists each key once, owned by the first provider that declares it", () => {
		const fields = contextFieldsForProviders(
			["azure_devops", "linear"],
			FIELDS,
		);
		expect(fields.map((f) => `${f.provider}:${f.key}`)).toEqual([
			"azure_devops:project",
			"azure_devops:team",
		]);
	});

	it("skips providers without context fields", () => {
		expect(contextFieldsForProviders(["slack"], FIELDS)).toEqual([]);
	});
});

describe("pickPrefillContext", () => {
	const fizzyFields = contextFieldsForProviders(["fizzy"], FIELDS);

	it("copies a saved context of a report bound to the same provider", () => {
		const prefill = pickPrefillContext(
			{
				mcpBindings: { fizzy: "cfg-1", "ds-1": "cfg-1" },
				context: { accountSlug: " 123 ", boardId: "42", other: "x" },
			},
			fizzyFields,
		);
		expect(prefill).toEqual({ accountSlug: "123", boardId: "42" });
	});

	it("copies nothing across providers", () => {
		const adoFields = contextFieldsForProviders(["azure_devops"], FIELDS);
		const prefill = pickPrefillContext(
			{
				mcpBindings: { linear: "cfg-2" },
				context: { team: "Engineering" },
			},
			adoFields,
		);
		expect(prefill).toEqual({});
	});

	it("ignores empty values and malformed connections", () => {
		expect(
			pickPrefillContext(
				{ mcpBindings: { fizzy: "cfg-1" }, context: { boardId: "  " } },
				fizzyFields,
			),
		).toEqual({});
		expect(pickPrefillContext(null, fizzyFields)).toEqual({});
		expect(
			pickPrefillContext({ mcpBindings: "x", context: 3 }, fizzyFields),
		).toEqual({});
	});
});
