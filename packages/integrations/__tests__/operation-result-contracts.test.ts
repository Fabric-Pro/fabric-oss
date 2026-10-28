import { afterEach, describe, expect, it, vi } from "vitest";
import {
	executeRegisteredIntegrationOperation,
	getIntegrationOperation,
} from "../src/executor-registry";

// Exercise the real VPIC adapter through the registry. Only the HTTP boundary is
// mocked: a registry test's invented executor payload cannot prove this contract.
const cases: [string, Record<string, unknown>][] = [
	["decode_vin", { vin: "1FT" }],
	["decode_vin_batch", { vins: ["1FT"] }],
	["decode_wmi", { wmi: "1FT" }],
	["get_all_manufacturers", {}],
	["get_manufacturer_details", { manufacturer: "Example" }],
	["get_all_makes", {}],
	["get_models_for_make", { make: "Example" }],
	["get_models_for_make_year", { make: "Example", year: 2024 }],
	["get_vehicle_types_for_make", { make: "Example" }],
];
afterEach(() => vi.unstubAllGlobals());

describe("real provider result contracts", () => {
	it.each(cases)(
		"validates %s without losing provider columns",
		async (operation, args) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(
						JSON.stringify({
							Count: 1,
							Message: "Results returned",
							Results: [{ ExampleColumn: "Example value" }],
						}),
						{ status: 200 },
					),
				),
			);
			const result = await executeRegisteredIntegrationOperation({
				provider: "NHTSA_VPIC",
				operation,
				args,
			});
			expect(
				getIntegrationOperation(
					"NHTSA_VPIC",
					operation,
				)?.resultSchema.safeParse(result.data).success,
			).toBe(true);
			expect(result.text).toContain("ExampleColumn");
			expect(JSON.parse(result.text)).toEqual(result.data);
		},
	);
});
