import { z } from "zod";

// Provider-specific columns are intentionally open; the result envelope is not.
// A provider error string or HTML body must never masquerade as successful data.
const rows = z.array(z.record(z.string(), z.unknown()));
const count = z.number().int().nonnegative();

export const nhtsaResultSchemas: Record<string, z.ZodType> = {
	decode_vin: z.looseObject({ vin: z.string(), results: rows, count }),
	decode_vin_batch: z.looseObject({
		vins: z.array(z.string()),
		results: rows,
		count,
	}),
	decode_wmi: z.looseObject({ wmi: z.string(), results: rows, count }),
	get_all_manufacturers: z.looseObject({ manufacturers: rows, count }),
	get_manufacturer_details: z.looseObject({
		manufacturer: z.string(),
		details: rows,
		count,
	}),
	get_all_makes: z.looseObject({ makes: rows, count }),
	get_models_for_make: z.looseObject({
		make: z.string(),
		models: rows,
		count,
	}),
	get_models_for_make_year: z.looseObject({
		make: z.string(),
		year: z.union([z.string(), z.number()]),
		vehicleType: z.string().nullable(),
		models: rows,
		count,
	}),
	get_vehicle_types_for_make: z.looseObject({
		make: z.string(),
		vehicleTypes: rows,
		count,
	}),
};

export const databricksQueryResultSchema = z.looseObject({
	chunks: z.array(
		z.looseObject({
			indexName: z.string(),
			id: z.string(),
			content: z.string(),
			score: z.number(),
		}),
	),
	failures: z.array(z.string()),
	skippedIndexes: z.array(z.string()),
});

export const databricksIndexesResultSchema = z.array(
	z.looseObject({
		name: z.string(),
		schema: z.string(),
		endpointName: z.string(),
		indexType: z.string(),
	}),
);
