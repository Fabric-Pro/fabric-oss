import { describe, expect, it } from "vitest";
import {
	ADO_FIELD_MAPPING_PROVIDER,
	type FieldMappingConfig,
	fieldMappingConfigSchema,
	parseFieldMappingConfig,
	readFieldMappingConfig,
} from "../src/field-mapping-schema";

/**
 * Task 7.2 — provider-agnostic `fieldMapping` config schema.
 *
 * The schema is the single source of truth shared by the oRPC API input
 * validation and the temporal aggregation reader. Contract: valid shapes
 * round-trip; an empty `fields: []` is a VALID config (persisted on explicit
 * clear), not null; malformed/legacy shapes defensively parse to the `null`
 * "no config" sentinel instead of throwing; `readFieldMappingConfig` extracts and
 * parses the `.fieldMapping` key out of an `additionalContext` blob.
 */
describe("fieldMappingConfigSchema", () => {
	const valid: FieldMappingConfig = {
		provider: ADO_FIELD_MAPPING_PROVIDER,
		fields: [
			{
				id: "Microsoft.VSTS.Common.AcceptanceCriteria",
				displayName: "Acceptance Criteria",
			},
			{ id: "Custom.BusinessRules", displayName: "Business Rules" },
		],
	};

	it("round-trips a valid config unchanged", () => {
		const parsed = fieldMappingConfigSchema.parse(valid);
		expect(parsed).toEqual(valid);
		// Order is significant (array index == display order) — preserved.
		expect(parsed.fields.map((f) => f.id)).toEqual([
			"Microsoft.VSTS.Common.AcceptanceCriteria",
			"Custom.BusinessRules",
		]);
	});

	it("uses the concrete detectedType provider value, not the shorthand", () => {
		expect(ADO_FIELD_MAPPING_PROVIDER).toBe("azure-devops");
	});
});

describe("parseFieldMappingConfig", () => {
	it("returns a valid config", () => {
		const result = parseFieldMappingConfig({
			provider: "azure-devops",
			fields: [{ id: "System.Description", displayName: "Description" }],
		});
		expect(result).not.toBeNull();
		expect(result?.fields).toHaveLength(1);
	});

	it("treats an empty `fields: []` as VALID (not null)", () => {
		const result = parseFieldMappingConfig({
			provider: "azure-devops",
			fields: [],
		});
		expect(result).toEqual({ provider: "azure-devops", fields: [] });
	});

	it.each([
		["null", null],
		["undefined", undefined],
		["a bare string", "azure-devops"],
		["a number", 42],
		["an empty object", {}],
		["missing provider", { fields: [] }],
		["missing fields", { provider: "azure-devops" }],
		["non-array fields", { provider: "azure-devops", fields: "nope" }],
		[
			"a field missing displayName",
			{
				provider: "azure-devops",
				fields: [{ id: "System.Description" }],
			},
		],
		[
			"a field with a blank id",
			{
				provider: "azure-devops",
				fields: [{ id: "", displayName: "X" }],
			},
		],
		[
			"a legacy shape (bare array)",
			[{ id: "System.Description", displayName: "Description" }],
		],
	])("defensively returns null for %s", (_label, input) => {
		expect(parseFieldMappingConfig(input)).toBeNull();
	});
});

describe("readFieldMappingConfig", () => {
	it("extracts and parses the `.fieldMapping` key from an additionalContext blob", () => {
		const additionalContext = {
			// Sibling keys the panel preserves on save.
			someOtherSetting: true,
			pmContainerId: "board-1",
			fieldMapping: {
				provider: "azure-devops",
				fields: [
					{
						id: "Custom.BusinessRules",
						displayName: "Business Rules",
					},
				],
			},
		};
		const result = readFieldMappingConfig(additionalContext);
		expect(result).toEqual({
			provider: "azure-devops",
			fields: [
				{ id: "Custom.BusinessRules", displayName: "Business Rules" },
			],
		});
	});

	it("returns null when the blob is absent, not an object, or lacks fieldMapping", () => {
		expect(readFieldMappingConfig(null)).toBeNull();
		expect(readFieldMappingConfig(undefined)).toBeNull();
		expect(readFieldMappingConfig("string")).toBeNull();
		expect(readFieldMappingConfig({ otherKey: 1 })).toBeNull();
	});

	it("returns null (not throw) when fieldMapping is malformed/legacy", () => {
		expect(
			readFieldMappingConfig({
				fieldMapping: { provider: "azure-devops" },
			}),
		).toBeNull();
		expect(
			readFieldMappingConfig({ fieldMapping: "legacy-string" }),
		).toBeNull();
	});

	it("returns a valid-but-empty config when fields were explicitly cleared", () => {
		const result = readFieldMappingConfig({
			fieldMapping: { provider: "azure-devops", fields: [] },
		});
		expect(result).toEqual({ provider: "azure-devops", fields: [] });
	});
});
