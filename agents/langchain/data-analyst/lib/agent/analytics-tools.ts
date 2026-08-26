/**
 * Analytics Tools for Data Analyst Agent
 *
 * Provides advanced data analysis capabilities:
 * - Statistical calculations (mean, median, std, percentiles)
 * - Data aggregation and grouping
 * - Trend detection
 * - Multi-source data staging
 * - Integration connection suggestions
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Connection suggestion artifact for prompting user to connect an integration
 */
export interface ConnectionSuggestionArtifact {
	type: "connection_suggestion";
	id: string;
	integration: string;
	integrationDisplayName: string;
	message: string;
	connectUrl: string;
	reason: string;
}

// Shared artifacts for connection suggestions
let connectionSuggestions: ConnectionSuggestionArtifact[] = [];

export function getConnectionSuggestions(): ConnectionSuggestionArtifact[] {
	return [...connectionSuggestions];
}

export function clearConnectionSuggestions(): void {
	connectionSuggestions = [];
}

function addConnectionSuggestion(artifact: ConnectionSuggestionArtifact): void {
	// Avoid duplicates
	if (
		!connectionSuggestions.find(
			(s) => s.integration === artifact.integration,
		)
	) {
		connectionSuggestions.push(artifact);
	}
}

/**
 * Dynamic integration discovery
 *
 * Instead of hardcoding known integrations, we discover them dynamically
 * from the user's connected MCP configs. This allows the system to work
 * with ANY MCP server the user has configured.
 */

/**
 * Extract a display name from an MCP config name
 */
function getDisplayName(name: string): string {
	// Convert snake_case or kebab-case to Title Case
	return name
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

/**
 * Check if a query mentions a specific MCP config
 */
function queryMentionsConfig(
	query: string,
	configName: string,
	serverName?: string,
): boolean {
	const queryLower = query.toLowerCase();
	const nameLower = configName.toLowerCase().replace(/[-_]/g, " ");
	const serverLower = serverName?.toLowerCase().replace(/[-_]/g, " ");

	// Check direct mention
	if (queryLower.includes(nameLower)) return true;
	if (serverLower && queryLower.includes(serverLower)) return true;

	// Check individual words from the name
	const nameWords = nameLower.split(" ");
	for (const word of nameWords) {
		if (word.length > 2 && queryLower.includes(word)) return true;
	}

	return false;
}

/**
 * Create the list_data_sources tool
 * Lists all available data sources the user has connected
 */
export function createListDataSourcesTool(
	connectedMcpConfigs: Array<{ name: string; serverName?: string }>,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "list_data_sources",
		description: [
			"List all available data sources that the user has connected.",
			"Use this tool first to understand what data sources are available for analysis.",
			"Returns a list of connected MCP servers/integrations.",
		].join(" "),
		schema: z.object({}),
		func: async () => {
			const sources = connectedMcpConfigs.map((c) => ({
				name: c.serverName || c.name,
				displayName: getDisplayName(c.serverName || c.name),
				configName: c.name,
			}));

			if (sources.length === 0) {
				return JSON.stringify({
					connected: false,
					message:
						"No data sources connected. The user needs to connect integrations in Settings > MCP Servers to enable data analysis.",
					hint: "Ask the user what data sources they'd like to connect, or suggest they visit Settings > MCP Servers.",
				});
			}

			return JSON.stringify({
				connected: true,
				sources,
				count: sources.length,
				message: `Found ${sources.length} connected data source(s): ${sources.map((s) => s.displayName).join(", ")}. You can use tools from these sources to fetch and analyze data.`,
			});
		},
	});
}

/**
 * Create the suggest_connection tool
 * Suggests an integration the user should connect based on their request
 *
 * This is now fully dynamic - it doesn't rely on a hardcoded list of integrations.
 * It simply suggests connecting whatever the user mentions.
 */
export function createSuggestConnectionTool(
	connectedMcpConfigs: Array<{ name: string; serverName?: string }>,
	fabricApiUrl: string,
): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "suggest_connection",
		description: [
			"Suggest that the user connect a specific integration to enable the requested analysis.",
			"Use this when the user asks about data that requires an integration they haven't connected.",
			"Returns a connection suggestion that the UI will display as a card with a connect button.",
		].join(" "),
		schema: z.object({
			integration: z
				.string()
				.describe(
					"The name of the integration/service the user needs (e.g., 'HubSpot', 'Google Sheets', 'Stripe', 'My Custom API')",
				),
			reason: z
				.string()
				.describe(
					"Brief explanation of why this integration is needed for their request",
				),
		}),
		func: async (input) => {
			const integrationId = input.integration
				.toLowerCase()
				.replace(/\s+/g, "_");

			// Check if already connected - use dynamic matching
			const isConnected = connectedMcpConfigs.some((c) =>
				queryMentionsConfig(input.integration, c.name, c.serverName),
			);

			if (isConnected) {
				const matchedConfig = connectedMcpConfigs.find((c) =>
					queryMentionsConfig(
						input.integration,
						c.name,
						c.serverName,
					),
				);
				const displayName = matchedConfig
					? getDisplayName(
							matchedConfig.serverName || matchedConfig.name,
						)
					: input.integration;
				return JSON.stringify({
					success: false,
					message: `${displayName} is already connected. You can use its tools for analysis.`,
				});
			}

			// Use the user-provided name for display
			const displayName = getDisplayName(input.integration);
			const connectUrl = `${fabricApiUrl}/app/settings/mcp-servers`;

			// Create connection suggestion artifact
			const artifact: ConnectionSuggestionArtifact = {
				type: "connection_suggestion",
				id: `conn_${Date.now()}`,
				integration: integrationId,
				integrationDisplayName: displayName,
				message: `To ${input.reason}, you'll need to connect ${displayName}.`,
				connectUrl,
				reason: input.reason,
			};

			addConnectionSuggestion(artifact);

			return JSON.stringify({
				success: true,
				message: `I've suggested connecting ${displayName}. The user will see a connection prompt.`,
				artifact: artifact,
			});
		},
	});
}

/**
 * Create the calculate_statistics tool
 * Calculates statistical measures on numeric data
 */
export function createCalculateStatisticsTool(): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "calculate_statistics",
		description: [
			"Calculate statistical measures on a numeric dataset.",
			"Computes: count, sum, mean, median, min, max, standard deviation, and percentiles.",
			"Use this for analyzing numeric data from any source.",
		].join(" "),
		schema: z.object({
			data: z
				.array(z.number())
				.describe("Array of numeric values to analyze"),
			fieldName: z
				.string()
				.optional()
				.describe("Name of the field being analyzed (for reporting)"),
			percentiles: z
				.array(z.number())
				.optional()
				.describe(
					"Percentiles to calculate (e.g., [25, 50, 75, 90, 95])",
				),
		}),
		func: async (input) => {
			const data = input.data.filter(
				(n) => !Number.isNaN(n) && Number.isFinite(n),
			);
			const fieldName = input.fieldName || "values";
			const percentilesRequested = input.percentiles || [25, 50, 75, 90];

			if (data.length === 0) {
				return JSON.stringify({
					error: "No valid numeric data provided",
					fieldName,
				});
			}

			// Sort for percentile calculations
			const sorted = [...data].sort((a, b) => a - b);

			// Basic statistics
			const count = data.length;
			const sum = data.reduce((a, b) => a + b, 0);
			const mean = sum / count;
			const min = sorted[0];
			const max = sorted[sorted.length - 1];

			// Median
			const mid = Math.floor(count / 2);
			const median =
				count % 2 === 0
					? (sorted[mid - 1] + sorted[mid]) / 2
					: sorted[mid];

			// Standard deviation
			const squaredDiffs = data.map((n) => Math.pow(n - mean, 2));
			const avgSquaredDiff =
				squaredDiffs.reduce((a, b) => a + b, 0) / count;
			const stdDev = Math.sqrt(avgSquaredDiff);

			// Percentiles
			const percentiles: Record<string, number> = {};
			for (const p of percentilesRequested) {
				const index = (p / 100) * (count - 1);
				const lower = Math.floor(index);
				const upper = Math.ceil(index);
				if (lower === upper) {
					percentiles[`p${p}`] = sorted[lower];
				} else {
					percentiles[`p${p}`] =
						sorted[lower] +
						(index - lower) * (sorted[upper] - sorted[lower]);
				}
			}

			return JSON.stringify({
				fieldName,
				statistics: {
					count,
					sum: Math.round(sum * 100) / 100,
					mean: Math.round(mean * 100) / 100,
					median: Math.round(median * 100) / 100,
					min,
					max,
					range: max - min,
					stdDev: Math.round(stdDev * 100) / 100,
					...percentiles,
				},
			});
		},
	});
}

/**
 * Create the aggregate_data tool
 * Aggregates data by a grouping field
 */
export function createAggregateDataTool(): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "aggregate_data",
		description: [
			"Aggregate data by a grouping field, calculating sum, count, or average for numeric fields.",
			"Similar to SQL GROUP BY or pandas groupby().",
			"Use this to summarize data by categories.",
		].join(" "),
		schema: z.object({
			data: z
				.array(z.record(z.unknown()))
				.describe("Array of data objects to aggregate"),
			groupBy: z.string().describe("Field name to group by"),
			aggregations: z
				.array(
					z.object({
						field: z.string().describe("Field to aggregate"),
						operation: z
							.enum(["sum", "count", "avg", "min", "max"])
							.describe("Aggregation operation"),
						alias: z
							.string()
							.optional()
							.describe("Output field name"),
					}),
				)
				.describe("Aggregations to perform"),
		}),
		func: async (input) => {
			const { data, groupBy, aggregations } = input;

			// Group the data
			const groups: Record<string, Record<string, unknown>[]> = {};
			for (const row of data) {
				const key = String(row[groupBy] ?? "null");
				if (!groups[key]) groups[key] = [];
				groups[key].push(row);
			}

			// Aggregate each group
			const result: Record<string, unknown>[] = [];
			for (const [key, rows] of Object.entries(groups)) {
				const aggregated: Record<string, unknown> = { [groupBy]: key };

				for (const agg of aggregations) {
					const values = rows
						.map((r) => r[agg.field])
						.filter((v) => v !== null && v !== undefined);
					const numericValues = values
						.map((v) => Number(v))
						.filter((n) => !Number.isNaN(n));

					const outputField =
						agg.alias || `${agg.operation}_${agg.field}`;

					switch (agg.operation) {
						case "count":
							aggregated[outputField] = values.length;
							break;
						case "sum":
							aggregated[outputField] =
								numericValues.length > 0
									? Math.round(
											numericValues.reduce(
												(a, b) => a + b,
												0,
											) * 100,
										) / 100
									: 0;
							break;
						case "avg":
							aggregated[outputField] =
								numericValues.length > 0
									? Math.round(
											(numericValues.reduce(
												(a, b) => a + b,
												0,
											) /
												numericValues.length) *
												100,
										) / 100
									: 0;
							break;
						case "min":
							aggregated[outputField] =
								numericValues.length > 0
									? Math.min(...numericValues)
									: null;
							break;
						case "max":
							aggregated[outputField] =
								numericValues.length > 0
									? Math.max(...numericValues)
									: null;
							break;
					}
				}

				result.push(aggregated);
			}

			return JSON.stringify({
				groupedBy: groupBy,
				groups: Object.keys(groups).length,
				data: result,
			});
		},
	});
}

/**
 * Create the detect_trends tool
 * Detects trends in time-series data
 */
export function createDetectTrendsTool(): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "detect_trends",
		description: [
			"Detect trends in time-series or sequential data.",
			"Calculates: direction (up/down/stable), percent change, moving averages.",
			"Use this for analyzing trends over time.",
		].join(" "),
		schema: z.object({
			data: z
				.array(z.number())
				.describe("Array of numeric values in chronological order"),
			labels: z
				.array(z.string())
				.optional()
				.describe("Labels for each data point (e.g., dates)"),
			windowSize: z
				.number()
				.optional()
				.describe("Moving average window size (default: 3)"),
		}),
		func: async (input) => {
			const { data, labels, windowSize = 3 } = input;

			if (data.length < 2) {
				return JSON.stringify({
					error: "Need at least 2 data points for trend analysis",
				});
			}

			// Calculate percent change
			const firstValue = data[0];
			const lastValue = data[data.length - 1];
			const percentChange =
				firstValue !== 0
					? ((lastValue - firstValue) / Math.abs(firstValue)) * 100
					: 0;

			// Determine trend direction
			let trend: "up" | "down" | "stable";
			if (percentChange > 5) trend = "up";
			else if (percentChange < -5) trend = "down";
			else trend = "stable";

			// Calculate moving average
			const movingAverage: number[] = [];
			for (let i = 0; i < data.length; i++) {
				const start = Math.max(0, i - windowSize + 1);
				const window = data.slice(start, i + 1);
				const avg = window.reduce((a, b) => a + b, 0) / window.length;
				movingAverage.push(Math.round(avg * 100) / 100);
			}

			// Find peaks and troughs
			const peaks: number[] = [];
			const troughs: number[] = [];
			for (let i = 1; i < data.length - 1; i++) {
				if (data[i] > data[i - 1] && data[i] > data[i + 1])
					peaks.push(i);
				if (data[i] < data[i - 1] && data[i] < data[i + 1])
					troughs.push(i);
			}

			return JSON.stringify({
				trend,
				percentChange: Math.round(percentChange * 100) / 100,
				startValue: firstValue,
				endValue: lastValue,
				dataPoints: data.length,
				movingAverage: {
					windowSize,
					values: movingAverage,
				},
				peaks: peaks.map((i) => ({
					index: i,
					value: data[i],
					label: labels?.[i],
				})),
				troughs: troughs.map((i) => ({
					index: i,
					value: data[i],
					label: labels?.[i],
				})),
			});
		},
	});
}

/**
 * Create the join_datasets tool
 * Joins two datasets on a common key
 */
export function createJoinDatasetsTool(): DynamicStructuredTool {
	return new DynamicStructuredTool({
		name: "join_datasets",
		description: [
			"Join two datasets on a common key field.",
			"Supports: inner, left, right, and full outer joins.",
			"Use this to combine data from multiple sources.",
		].join(" "),
		schema: z.object({
			leftData: z.array(z.record(z.unknown())).describe("Left dataset"),
			rightData: z.array(z.record(z.unknown())).describe("Right dataset"),
			leftKey: z.string().describe("Key field in left dataset"),
			rightKey: z.string().describe("Key field in right dataset"),
			joinType: z
				.enum(["inner", "left", "right", "full"])
				.default("inner")
				.describe("Type of join"),
		}),
		func: async (input) => {
			const { leftData, rightData, leftKey, rightKey, joinType } = input;

			// Index the right data
			const rightIndex: Record<string, Record<string, unknown>[]> = {};
			for (const row of rightData) {
				const key = String(row[rightKey] ?? "");
				if (!rightIndex[key]) rightIndex[key] = [];
				rightIndex[key].push(row);
			}

			// Index the left data for full/right joins
			const leftIndex: Record<string, Record<string, unknown>[]> = {};
			for (const row of leftData) {
				const key = String(row[leftKey] ?? "");
				if (!leftIndex[key]) leftIndex[key] = [];
				leftIndex[key].push(row);
			}

			const result: Record<string, unknown>[] = [];
			const matchedRightKeys = new Set<string>();

			// Process left data
			for (const leftRow of leftData) {
				const key = String(leftRow[leftKey] ?? "");
				const rightMatches = rightIndex[key] || [];

				if (rightMatches.length > 0) {
					for (const rightRow of rightMatches) {
						result.push({ ...leftRow, ...rightRow });
					}
					matchedRightKeys.add(key);
				} else if (joinType === "left" || joinType === "full") {
					result.push({ ...leftRow });
				}
			}

			// For right/full joins, add unmatched right rows
			if (joinType === "right" || joinType === "full") {
				for (const rightRow of rightData) {
					const key = String(rightRow[rightKey] ?? "");
					if (!matchedRightKeys.has(key)) {
						result.push({ ...rightRow });
					}
				}
			}

			return JSON.stringify({
				joinType,
				leftCount: leftData.length,
				rightCount: rightData.length,
				resultCount: result.length,
				data: result,
			});
		},
	});
}

/**
 * Check if a specific integration/service is mentioned in the query
 * but not connected. This is now dynamic - it doesn't use a hardcoded list.
 *
 * @returns The mentioned integration name if not connected, null otherwise
 */
export function detectMentionedButNotConnected(
	query: string,
	connectedMcpConfigs: Array<{ name: string; serverName?: string }>,
): string | null {
	// Common patterns that indicate the user is asking about a specific service
	// e.g., "my HubSpot data", "from Stripe", "in Salesforce"
	const patterns = [
		/\bmy\s+(\w+)\s+(?:data|account|contacts|deals|records)/i,
		/\bfrom\s+(\w+)/i,
		/\bin\s+(\w+)/i,
		/\b(\w+)\s+(?:integration|api|account)/i,
	];

	for (const pattern of patterns) {
		const match = query.match(pattern);
		if (match?.[1]) {
			const mentioned = match[1];
			// Skip common words that aren't service names
			if (
				["the", "my", "your", "our", "their", "a", "an"].includes(
					mentioned.toLowerCase(),
				)
			) {
				continue;
			}

			// Check if this service is connected
			const isConnected = connectedMcpConfigs.some((c) =>
				queryMentionsConfig(mentioned, c.name, c.serverName),
			);

			if (!isConnected) {
				return mentioned;
			}
		}
	}

	return null;
}
