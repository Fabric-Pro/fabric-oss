/**
 * Built-in Chart Tool for Orchestrator
 *
 * Creates chart artifacts that can be rendered by the UI.
 * This tool is always available to the orchestrator for data visualization.
 *
 * FOOLPROOF DESIGN:
 * Instead of requiring the LLM to pre-aggregate data (which is error-prone),
 * this tool accepts raw data and aggregation instructions, then performs
 * the aggregation deterministically in code.
 */

import { type ChartArtifact, createChartArtifact } from "@repo/agent-tools";
import { tool } from "@repo/ai";
import { z } from "zod";

/**
 * Chart artifact storage for current execution
 */
let currentChartArtifacts: ChartArtifact[] = [];

/**
 * Get all chart artifacts generated during execution
 */
export function getChartArtifacts(): ChartArtifact[] {
	return [...currentChartArtifacts];
}

/**
 * Clear chart artifacts (call at start of new execution)
 */
export function clearChartArtifacts(): void {
	currentChartArtifacts = [];
}

/**
 * Check if a similar chart already exists (same type, same title, similar data)
 */
function isDuplicateChart(newChart: ChartArtifact): boolean {
	return currentChartArtifacts.some((existing) => {
		if (existing.chartType !== newChart.chartType) {
			return false;
		}
		if (existing.config.title !== newChart.config.title) {
			return false;
		}
		if (existing.data.length !== newChart.data.length) {
			return false;
		}

		const existingLabels = existing.data
			.map((d) => String(d[existing.config.xAxis]))
			.sort();
		const newLabels = newChart.data
			.map((d) => String(d[newChart.config.xAxis]))
			.sort();

		return existingLabels.every((label, i) => label === newLabels[i]);
	});
}

/**
 * Perform data aggregation based on the specified method.
 * This is the KEY to making charts foolproof - aggregation happens in code, not LLM.
 */
function aggregateData(
	rawData: Record<string, unknown>[],
	groupByField: string,
	aggregation: "count" | "sum" | "average" | "none",
	valueField?: string,
): { data: Record<string, unknown>[]; yAxisField: string } {
	// If no aggregation needed, return data as-is
	if (aggregation === "none") {
		// Try to find a numeric field for yAxis
		const numericField = valueField || findNumericField(rawData);
		return {
			data: rawData,
			yAxisField: numericField || "value",
		};
	}

	// Group data by the groupByField
	const groups = new Map<string, Record<string, unknown>[]>();

	for (const item of rawData) {
		const key = String(item[groupByField] ?? "Unknown");
		const existing = groups.get(key) || [];
		existing.push(item);
		groups.set(key, existing);
	}

	// Aggregate each group
	const aggregatedData: Record<string, unknown>[] = [];
	let yAxisField = "count";

	for (const [groupKey, items] of groups) {
		const row: Record<string, unknown> = {
			[groupByField]: groupKey,
		};

		switch (aggregation) {
			case "count":
				row.count = items.length;
				yAxisField = "count";
				break;

			case "sum":
				if (valueField) {
					row.total = items.reduce((sum, item) => {
						const val = item[valueField];
						const num =
							typeof val === "number"
								? val
								: Number.parseFloat(String(val));
						return sum + (Number.isNaN(num) ? 0 : num);
					}, 0);
					yAxisField = "total";
				} else {
					row.count = items.length;
					yAxisField = "count";
				}
				break;

			case "average":
				if (valueField && items.length > 0) {
					const sum = items.reduce((acc, item) => {
						const val = item[valueField];
						const num =
							typeof val === "number"
								? val
								: Number.parseFloat(String(val));
						return acc + (Number.isNaN(num) ? 0 : num);
					}, 0);
					row.average = Math.round((sum / items.length) * 100) / 100;
					yAxisField = "average";
				} else {
					row.count = items.length;
					yAxisField = "count";
				}
				break;
		}

		aggregatedData.push(row);
	}

	// Sort by the aggregated value (descending) for better visualization
	aggregatedData.sort((a, b) => {
		const aVal = (a[yAxisField] as number) || 0;
		const bVal = (b[yAxisField] as number) || 0;
		return bVal - aVal;
	});

	return { data: aggregatedData, yAxisField };
}

/**
 * Find the first numeric field in the data
 */
function findNumericField(data: Record<string, unknown>[]): string | null {
	if (data.length === 0) {
		return null;
	}

	const firstRow = data[0];
	for (const [key, value] of Object.entries(firstRow)) {
		if (typeof value === "number") {
			return key;
		}
		if (
			typeof value === "string" &&
			!Number.isNaN(Number.parseFloat(value))
		) {
			return key;
		}
	}
	return null;
}

/**
 * The create_chart tool schema for LLM
 * Designed for FOOLPROOF operation - LLM passes raw data, tool does aggregation
 */
const chartToolSchema = z.object({
	chartType: z
		.enum(["line", "bar", "pie", "area", "scatter"])
		.describe(
			"Chart type: 'pie' for distribution/proportions, 'bar' for comparisons, 'line' for trends over time.",
		),
	data: z
		.array(z.object({}).passthrough())
		.describe(
			"Array of raw data objects from API responses. Pass the ACTUAL data you received - the tool will aggregate it.",
		),
	groupBy: z
		.string()
		.describe(
			"Field name to group data by (becomes X axis). Example: 'status', 'category', 'board_name', 'assignee'.",
		),
	aggregation: z
		.enum(["count", "sum", "average", "none"])
		.describe(
			"How to aggregate: 'count' to count items per group, 'sum' to total a value field, 'average' for mean, 'none' if data is pre-aggregated.",
		),
	valueField: z
		.string()
		.optional()
		.describe(
			"Field to sum/average (required for 'sum' and 'average' aggregation). Not needed for 'count'.",
		),
	title: z.string().describe("Chart title describing what the chart shows."),
	sourceDescription: z
		.string()
		.optional()
		.describe("Brief description of where the data came from."),
});

type ChartToolInput = z.infer<typeof chartToolSchema>;

/**
 * Create the chart tool for the orchestrator
 */
export function createChartTool() {
	return tool({
		description: [
			"Creates interactive charts from data. Pass RAW data from API responses - the tool handles aggregation.",
			"",
			"USAGE: Pass the actual data array you received from other tools, specify how to group and aggregate it.",
			"",
			"For 'distribution of X across Y' charts:",
			"  - data: the raw items array from API",
			"  - groupBy: field to categorize by (e.g., 'board_name', 'status', 'type')",
			"  - aggregation: 'count' to count items per category",
			"",
			"For 'total X by Y' charts:",
			"  - aggregation: 'sum'",
			"  - valueField: the numeric field to sum",
			"",
			"Example: To show card distribution across boards, if API returned [{board_name: 'A', ...}, {board_name: 'B', ...}, ...]",
			"  Call with: data: <raw_api_data>, groupBy: 'board_name', aggregation: 'count', chartType: 'pie'",
			"",
			"The tool will count items per board and create the chart. DO NOT pre-aggregate - pass raw data.",
		].join("\n"),
		inputSchema: chartToolSchema,
		execute: async (input: ChartToolInput) => {
			console.log(`[ChartTool] Received ${input.data.length} raw items`);
			console.log(
				`[ChartTool] Aggregation: ${input.aggregation} by ${input.groupBy}`,
			);

			// Perform aggregation
			const { data: aggregatedData, yAxisField } = aggregateData(
				input.data,
				input.groupBy,
				input.aggregation,
				input.valueField,
			);

			console.log(
				`[ChartTool] Aggregated to ${aggregatedData.length} groups`,
			);
			console.log("[ChartTool] Aggregated data:", aggregatedData);

			// Create the artifact
			const artifact = createChartArtifact({
				chartType: input.chartType,
				data: aggregatedData,
				config: {
					xAxis: input.groupBy,
					yAxis: yAxisField,
					title: input.title,
					showLegend: true,
				},
				sourceDescription: input.sourceDescription,
			});

			// Check for duplicate charts
			if (isDuplicateChart(artifact)) {
				console.log(
					`[ChartTool] Skipping duplicate chart: ${input.title}`,
				);
				return JSON.stringify({
					success: true,
					type: "chart_artifact",
					message: `Chart "${input.title}" already exists, skipping duplicate.`,
					duplicate: true,
				});
			}

			// Store the artifact
			currentChartArtifacts.push(artifact);

			// Return success with details
			return JSON.stringify({
				success: true,
				type: "chart_artifact",
				message: `Created ${input.chartType} chart: ${input.title}`,
				artifactId: artifact.id,
				groupCount: aggregatedData.length,
				totalItems: input.data.length,
				aggregatedData: aggregatedData,
				artifact: artifact,
			});
		},
	});
}

/**
 * Get the chart tool as a record for merging with other tools
 */
export function getChartToolRecord(): Record<string, unknown> {
	return {
		create_chart: createChartTool(),
	};
}
