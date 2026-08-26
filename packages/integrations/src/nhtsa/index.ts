/**
 * NHTSA VPIC Integration
 *
 * Core executor for the NHTSA Vehicle Product Information Catalog (VPIC) API.
 * Public, free API — no authentication required.
 *
 * API docs: https://vpic.nhtsa.dot.gov/api/
 */

const NHTSA_BASE_URL = "https://vpic.nhtsa.dot.gov/api/vehicles";

interface NhtsaApiResponse {
	Count: number;
	Message: string;
	SearchCriteria: string | null;
	Results: Record<string, unknown>[];
}

/**
 * Make a GET request to the NHTSA VPIC API.
 */
async function nhtsaGet(
	path: string,
	opts?: { params?: Record<string, string>; signal?: AbortSignal },
): Promise<NhtsaApiResponse> {
	const url = new URL(`${NHTSA_BASE_URL}/${path}`);
	url.searchParams.set("format", "json");
	if (opts?.params) {
		for (const [key, value] of Object.entries(opts.params)) {
			if (value) {
				url.searchParams.set(key, value);
			}
		}
	}

	const response = await fetch(url.toString(), { signal: opts?.signal });
	if (!response.ok) {
		throw new Error(
			`NHTSA API error: ${response.status} ${response.statusText}`,
		);
	}

	return (await response.json()) as NhtsaApiResponse;
}

/**
 * Make a POST request to the NHTSA VPIC API.
 */
async function nhtsaPost(
	path: string,
	body: string,
	signal?: AbortSignal,
): Promise<NhtsaApiResponse> {
	const url = `${NHTSA_BASE_URL}/${path}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal,
	});
	if (!response.ok) {
		throw new Error(
			`NHTSA API error: ${response.status} ${response.statusText}`,
		);
	}

	return (await response.json()) as NhtsaApiResponse;
}

/**
 * Filter out empty/null values from VIN decode results for cleaner output.
 */
function filterEmptyValues(
	results: Record<string, unknown>[],
): Record<string, unknown>[] {
	if (!results?.length) {
		return results;
	}
	return results.map((result) => {
		const filtered: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(result)) {
			if (
				value !== null &&
				value !== undefined &&
				value !== "" &&
				value !== "Not Applicable"
			) {
				filtered[key] = value;
			}
		}
		return filtered;
	});
}

// ─── Tool Implementations ────────────────────────────────────────────────────

/**
 * Decode a VIN (Vehicle Identification Number).
 * Returns vehicle information like make, model, year, engine, etc.
 */
async function decodeVin(args: Record<string, unknown>, signal?: AbortSignal) {
	const vin = args.vin as string;
	if (!vin) {
		throw new Error("VIN is required");
	}

	const params: Record<string, string> = {};
	if (args.modelYear) {
		params.modelyear = String(args.modelYear);
	}

	const data = await nhtsaGet(`DecodeVinValues/${encodeURIComponent(vin)}`, {
		params,
		signal,
	});
	return {
		vin,
		results: filterEmptyValues(data.Results),
		count: data.Count,
	};
}

/**
 * Decode multiple VINs in a single batch request.
 * Maximum of 50 VINs per request.
 */
async function decodeVinBatch(
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	// Normalize input: accept string[] or semicolon-delimited string
	const rawVins = args.vins;
	const vins: string[] = Array.isArray(rawVins)
		? rawVins
		: typeof rawVins === "string"
			? rawVins
					.split(";")
					.map((v) => v.trim())
					.filter(Boolean)
			: [];
	if (!vins.length) {
		throw new Error("At least one VIN is required");
	}
	if (vins.length > 50) {
		throw new Error("Maximum 50 VINs per batch request");
	}

	// Format: VIN;VIN;VIN (semicolon-separated)
	const vinList = vins.join(";");
	const data = await nhtsaPost(
		"DecodeVINValuesBatch/",
		`DATA=${encodeURIComponent(vinList)}&format=json`,
		signal,
	);

	return {
		vins,
		results: filterEmptyValues(data.Results),
		count: data.Count,
	};
}

/**
 * Decode a World Manufacturer Identifier (WMI).
 * WMI is the first 3 or 6 characters of a VIN.
 */
async function decodeWmi(args: Record<string, unknown>, signal?: AbortSignal) {
	const wmi = args.wmi as string;
	if (!wmi) {
		throw new Error("WMI is required");
	}
	if (wmi.length !== 3 && wmi.length !== 6) {
		throw new Error("WMI must be 3 or 6 characters");
	}

	const data = await nhtsaGet(`DecodeWMI/${encodeURIComponent(wmi)}`, {
		signal,
	});
	return {
		wmi,
		results: data.Results,
		count: data.Count,
	};
}

/**
 * Get all vehicle manufacturers.
 * Supports pagination and filtering by manufacturer type.
 */
async function getAllManufacturers(
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const params: Record<string, string> = {};
	if (args.page) {
		params.page = String(args.page);
	}
	if (args.manufacturerType) {
		params.ManufacturerType = String(args.manufacturerType);
	}

	const data = await nhtsaGet("GetAllManufacturers", { params, signal });
	return {
		manufacturers: data.Results,
		count: data.Count,
	};
}

/**
 * Get detailed information about a specific manufacturer.
 * Accepts manufacturer name or Manufacturer ID.
 */
async function getManufacturerDetails(
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const manufacturer = args.manufacturer as string;
	if (!manufacturer) {
		throw new Error("Manufacturer name or ID is required");
	}

	const data = await nhtsaGet(
		`GetManufacturerDetails/${encodeURIComponent(manufacturer)}`,
		{ signal },
	);
	return {
		manufacturer,
		details: data.Results,
		count: data.Count,
	};
}

/**
 * Get all vehicle makes.
 */
async function getAllMakes(
	_args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const data = await nhtsaGet("GetAllMakes", { signal });
	return {
		makes: data.Results,
		count: data.Count,
	};
}

/**
 * Get vehicle models for a specific make.
 */
async function getModelsForMake(
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const make = args.make as string;
	if (!make) {
		throw new Error("Make is required");
	}

	const data = await nhtsaGet(
		`GetModelsForMake/${encodeURIComponent(make)}`,
		{
			signal,
		},
	);
	return {
		make,
		models: data.Results,
		count: data.Count,
	};
}

/**
 * Get vehicle models for a specific make and year.
 * Optionally filter by vehicle type.
 */
async function getModelsForMakeYear(
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const make = args.make as string;
	const year = args.year as string | number;
	if (!make) {
		throw new Error("Make is required");
	}
	if (!year) {
		throw new Error("Year is required");
	}

	let path = `GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${encodeURIComponent(String(year))}`;
	if (args.vehicleType) {
		path += `/vehicletype/${encodeURIComponent(String(args.vehicleType))}`;
	}

	const data = await nhtsaGet(path, { signal });
	return {
		make,
		year,
		vehicleType: args.vehicleType || null,
		models: data.Results,
		count: data.Count,
	};
}

/**
 * Get vehicle types for a specific make.
 */
async function getVehicleTypesForMake(
	args: Record<string, unknown>,
	signal?: AbortSignal,
) {
	const make = args.make as string;
	if (!make) {
		throw new Error("Make is required");
	}

	const data = await nhtsaGet(
		`GetVehicleTypesForMake/${encodeURIComponent(make)}`,
		{ signal },
	);
	return {
		make,
		vehicleTypes: data.Results,
		count: data.Count,
	};
}

// ─── Public API ──────────────────────────────────────────────────────────────

type NhtsaToolHandler = (
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;

const NHTSA_TOOLS: Record<string, NhtsaToolHandler> = {
	decode_vin: decodeVin,
	decode_vin_batch: decodeVinBatch,
	decode_wmi: decodeWmi,
	get_all_manufacturers: getAllManufacturers,
	get_manufacturer_details: getManufacturerDetails,
	get_all_makes: getAllMakes,
	get_models_for_make: getModelsForMake,
	get_models_for_make_year: getModelsForMakeYear,
	get_vehicle_types_for_make: getVehicleTypesForMake,
};

/**
 * Execute an NHTSA VPIC tool by method name.
 *
 * @param methodName - One of the 9 supported tool names
 * @param args - Tool-specific arguments
 * @param options.signal - Aborts the underlying request, so a caller that has
 *   already timed out does not leave the fetch running in the background
 * @returns Tool result
 */
export async function executeNhtsaTool(
	methodName: string,
	args: Record<string, unknown>,
	options?: { signal?: AbortSignal },
): Promise<unknown> {
	const handler = NHTSA_TOOLS[methodName];
	if (!handler) {
		throw new Error(`Unknown NHTSA tool: ${methodName}`);
	}
	return handler(args, options?.signal);
}
