/**
 * Evidence Chart Component Generators
 *
 * Generates Evidence chart component markup from configuration.
 */

import type { ChartConfig } from "../types";

/**
 * Generate a LineChart component
 */
export function generateLineChart(config: ChartConfig): string {
	const yAxis = Array.isArray(config.yAxis) ? config.yAxis : [config.yAxis];
	const yProps = yAxis.map((y) => `y="${y}"`).join(" ");

	return `<LineChart
	data={${config.dataSource}}
	x="${config.xAxis}"
	${yProps}
	${config.title ? `title="${escapeAttr(config.title)}"` : ""}
	${config.series ? `series="${config.series}"` : ""}
	${config.showLegend !== false ? "" : "legend={false}"}
/>`;
}

/**
 * Generate a BarChart component
 */
export function generateBarChart(config: ChartConfig): string {
	const yAxis = Array.isArray(config.yAxis) ? config.yAxis : [config.yAxis];
	const yProps = yAxis.map((y) => `y="${y}"`).join(" ");

	return `<BarChart
	data={${config.dataSource}}
	x="${config.xAxis}"
	${yProps}
	${config.title ? `title="${escapeAttr(config.title)}"` : ""}
	${config.series ? `series="${config.series}"` : ""}
	${config.stacked ? "stacked={true}" : ""}
	${config.showLegend !== false ? "" : "legend={false}"}
/>`;
}

/**
 * Generate an AreaChart component
 */
export function generateAreaChart(config: ChartConfig): string {
	const yAxis = Array.isArray(config.yAxis) ? config.yAxis : [config.yAxis];
	const yProps = yAxis.map((y) => `y="${y}"`).join(" ");

	return `<AreaChart
	data={${config.dataSource}}
	x="${config.xAxis}"
	${yProps}
	${config.title ? `title="${escapeAttr(config.title)}"` : ""}
	${config.series ? `series="${config.series}"` : ""}
	${config.stacked ? "stacked={true}" : ""}
	${config.showLegend !== false ? "" : "legend={false}"}
/>`;
}

/**
 * Generate a ScatterPlot component
 */
export function generateScatterPlot(config: ChartConfig): string {
	const yAxis = Array.isArray(config.yAxis) ? config.yAxis[0] : config.yAxis;

	return `<ScatterPlot
	data={${config.dataSource}}
	x="${config.xAxis}"
	y="${yAxis}"
	${config.title ? `title="${escapeAttr(config.title)}"` : ""}
	${config.series ? `series="${config.series}"` : ""}
/>`;
}

/**
 * Generate a PieChart/DonutChart component
 */
export function generatePieChart(
	config: ChartConfig,
	options?: { donut?: boolean },
): string {
	const yAxis = Array.isArray(config.yAxis) ? config.yAxis[0] : config.yAxis;
	const Component = options?.donut ? "DonutChart" : "PieChart";

	return `<${Component}
	data={${config.dataSource}}
	name="${config.xAxis}"
	value="${yAxis}"
	${config.title ? `title="${escapeAttr(config.title)}"` : ""}
/>`;
}

/**
 * Generate a Sparkline component (inline mini chart)
 */
export function generateSparkline(config: {
	dataSource: string;
	dateCol: string;
	valueCol: string;
	type?: "line" | "bar" | "area";
}): string {
	return `<Sparkline
	data={${config.dataSource}}
	dateCol="${config.dateCol}"
	valueCol="${config.valueCol}"
	${config.type ? `type="${config.type}"` : ""}
/>`;
}

/**
 * Generate chart based on chartType
 */
export function generateChart(config: ChartConfig): string {
	switch (config.chartType) {
		case "bar":
			return generateBarChart(config);
		case "area":
			return generateAreaChart(config);
		case "scatter":
			return generateScatterPlot(config);
		case "pie":
			return generatePieChart(config);
		default:
			return generateLineChart(config);
	}
}

/**
 * Escape attribute value for safe HTML
 */
function escapeAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
