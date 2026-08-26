/**
 * Data Source Mapper
 *
 * Maps Fabric data source results to Evidence data sources.
 * Evidence expects data in JSON or CSV format in the sources directory.
 */

import type {
	AiAnalysisResult,
	DataSourceResult,
	DataSourceSchema,
	EvidenceDataSource,
} from "../types";

/**
 * Map Fabric data results to Evidence data sources
 */
export function mapDataSources(
	dataResults: DataSourceResult[],
	aiResults: AiAnalysisResult[],
): EvidenceDataSource[] {
	const sources: EvidenceDataSource[] = [];

	// Map data source results
	for (const result of dataResults) {
		if (result.error || !result.data) {
			continue;
		}

		const source = mapDataSourceResult(result);
		if (source) {
			sources.push(source);
		}
	}

	// Map AI results as text data sources (for reference in pages)
	for (const result of aiResults) {
		if (result.error || !result.content) {
			continue;
		}

		sources.push({
			name: sanitizeSourceName(result.outputVariable),
			type: "json",
			data: [{ content: result.content }],
		});
	}

	return sources;
}

/**
 * Map a single data source result to Evidence format
 */
function mapDataSourceResult(
	result: DataSourceResult,
): EvidenceDataSource | null {
	const data = normalizeDataArray(result.data);

	if (!data || data.length === 0) {
		return null;
	}

	const schema = inferSchema(data);

	return {
		name: sanitizeSourceName(result.sourceId),
		type: "json",
		data,
		schema,
	};
}

/**
 * Normalize various data formats to array of objects
 */
function normalizeDataArray(data: unknown): Record<string, unknown>[] | null {
	if (!data) {
		return null;
	}

	// Already an array
	if (Array.isArray(data)) {
		// Array of objects - ideal format
		if (
			data.length > 0 &&
			typeof data[0] === "object" &&
			data[0] !== null
		) {
			return data as Record<string, unknown>[];
		}

		// Array of primitives - wrap in objects
		if (data.length > 0 && typeof data[0] !== "object") {
			return data.map((value, index) => ({ index, value }));
		}

		return [];
	}

	// Single object - wrap in array
	if (typeof data === "object" && data !== null) {
		return [data as Record<string, unknown>];
	}

	// Primitive value
	return [{ value: data }];
}

/**
 * Infer schema from data
 */
function inferSchema(data: Record<string, unknown>[]): DataSourceSchema {
	if (data.length === 0) {
		return { columns: [] };
	}

	const sample = data[0];
	const columns: DataSourceSchema["columns"] = [];

	for (const [key, value] of Object.entries(sample)) {
		columns.push({
			name: key,
			type: inferColumnType(value, key, data),
		});
	}

	return { columns };
}

/**
 * Infer column type from sample values
 */
function inferColumnType(
	value: unknown,
	key: string,
	data: Record<string, unknown>[],
): "string" | "number" | "boolean" | "date" {
	// Check if column name suggests a date
	const dateKeyPatterns = [
		/date/i,
		/time/i,
		/created/i,
		/updated/i,
		/at$/i,
		/timestamp/i,
	];
	if (dateKeyPatterns.some((p) => p.test(key))) {
		// Verify it looks like a date
		const sampleValues = data.slice(0, 5).map((row) => row[key]);
		if (sampleValues.every((v) => isDateLike(v))) {
			return "date";
		}
	}

	// Check value type
	if (typeof value === "number") {
		return "number";
	}

	if (typeof value === "boolean") {
		return "boolean";
	}

	if (typeof value === "string") {
		// Check if it's a parseable date
		if (isDateLike(value)) {
			return "date";
		}

		// Check if it's a numeric string
		if (!Number.isNaN(Number(value)) && value.trim() !== "") {
			// Sample more values to confirm
			const sampleValues = data.slice(0, 10).map((row) => row[key]);
			if (sampleValues.every((v) => !Number.isNaN(Number(v)))) {
				return "number";
			}
		}

		return "string";
	}

	return "string";
}

/**
 * Check if a value looks like a date
 */
function isDateLike(value: unknown): boolean {
	if (!value) {
		return false;
	}

	if (value instanceof Date) {
		return true;
	}

	if (typeof value === "string") {
		// ISO date format
		if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
			const parsed = new Date(value);
			return !Number.isNaN(parsed.getTime());
		}

		// Common date formats
		if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(value)) {
			return true;
		}
	}

	if (typeof value === "number") {
		// Unix timestamp (reasonable range: 2000-2100)
		const year2000 = 946684800000;
		const year2100 = 4102444800000;
		return value > year2000 && value < year2100;
	}

	return false;
}

/**
 * Sanitize source name for Evidence (alphanumeric + underscore)
 */
export function sanitizeSourceName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_+/g, "_")
		.substring(0, 64);
}

/**
 * Generate Evidence data source file content
 */
export function generateDataSourceContent(source: EvidenceDataSource): string {
	if (source.type === "csv") {
		return generateCsvContent(source.data as Record<string, unknown>[]);
	}

	return JSON.stringify(source.data, null, 2);
}

/**
 * Generate CSV content from data array
 */
function generateCsvContent(data: Record<string, unknown>[]): string {
	if (data.length === 0) {
		return "";
	}

	const headers = Object.keys(data[0]);
	const rows = [
		headers.join(","),
		...data.map((row) =>
			headers.map((h) => escapeCsvValue(row[h])).join(","),
		),
	];

	return rows.join("\n");
}

/**
 * Escape CSV value
 */
function escapeCsvValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}

	const str = String(value);

	// Quote if contains comma, quote, or newline
	if (/[,"\n\r]/.test(str)) {
		return `"${str.replace(/"/g, '""')}"`;
	}

	return str;
}

/**
 * Get data source file path for Evidence project
 */
export function getDataSourcePath(source: EvidenceDataSource): string {
	const ext = source.type === "csv" ? "csv" : "json";
	return `sources/${source.name}/${source.name}.${ext}`;
}

/**
 * Create aggregated metrics from data source
 */
export function createMetricsFromData(
	sourceId: string,
	data: Record<string, unknown>[],
	config: {
		groupBy?: string;
		aggregate: Array<{
			field: string;
			operation: "sum" | "avg" | "count" | "min" | "max";
			alias?: string;
		}>;
	},
): EvidenceDataSource {
	if (!config.aggregate || config.aggregate.length === 0) {
		return {
			name: `${sanitizeSourceName(sourceId)}_metrics`,
			type: "json",
			data: [],
		};
	}

	// Simple aggregation (no grouping)
	if (!config.groupBy) {
		const result: Record<string, unknown> = {};

		for (const agg of config.aggregate) {
			const values = data
				.map((row) => row[agg.field])
				.filter((v) => typeof v === "number") as number[];

			const alias = agg.alias || `${agg.operation}_${agg.field}`;

			switch (agg.operation) {
				case "sum":
					result[alias] = values.reduce((a, b) => a + b, 0);
					break;
				case "avg":
					result[alias] =
						values.length > 0
							? values.reduce((a, b) => a + b, 0) / values.length
							: 0;
					break;
				case "count":
					result[alias] = values.length;
					break;
				case "min":
					result[alias] = values.length > 0 ? Math.min(...values) : 0;
					break;
				case "max":
					result[alias] = values.length > 0 ? Math.max(...values) : 0;
					break;
			}
		}

		return {
			name: `${sanitizeSourceName(sourceId)}_metrics`,
			type: "json",
			data: [result],
		};
	}

	// Grouped aggregation
	const groups = new Map<string, Record<string, unknown>[]>();

	for (const row of data) {
		const key = String(row[config.groupBy] ?? "");
		if (!groups.has(key)) {
			groups.set(key, []);
		}
		groups.get(key)?.push(row);
	}

	const aggregatedData: Record<string, unknown>[] = [];

	for (const [groupKey, groupData] of groups) {
		const result: Record<string, unknown> = {
			[config.groupBy]: groupKey,
		};

		for (const agg of config.aggregate) {
			const values = groupData
				.map((row) => row[agg.field])
				.filter((v) => typeof v === "number") as number[];

			const alias = agg.alias || `${agg.operation}_${agg.field}`;

			switch (agg.operation) {
				case "sum":
					result[alias] = values.reduce((a, b) => a + b, 0);
					break;
				case "avg":
					result[alias] =
						values.length > 0
							? values.reduce((a, b) => a + b, 0) / values.length
							: 0;
					break;
				case "count":
					result[alias] = values.length;
					break;
				case "min":
					result[alias] = values.length > 0 ? Math.min(...values) : 0;
					break;
				case "max":
					result[alias] = values.length > 0 ? Math.max(...values) : 0;
					break;
			}
		}

		aggregatedData.push(result);
	}

	return {
		name: `${sanitizeSourceName(sourceId)}_metrics`,
		type: "json",
		data: aggregatedData,
	};
}
