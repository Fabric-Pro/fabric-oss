/**
 * Evidence Metric Component Generators
 *
 * Generates BigValue, Delta, and other metric display components.
 */

import type { MetricConfig } from "../types";

/**
 * Generate a BigValue component
 */
export function generateBigValue(config: MetricConfig): string {
	return `<BigValue
	data={${config.dataSource}}
	value="${config.value}"
	title="${escapeAttr(config.title)}"
	${config.format ? `fmt="${config.format}"` : ""}
	${config.comparison ? `comparison="${config.comparison}"` : ""}
	${config.comparisonTitle ? `comparisonTitle="${escapeAttr(config.comparisonTitle)}"` : ""}
/>`;
}

/**
 * Generate multiple BigValue components in a row
 */
export function generateMetricsRow(metrics: MetricConfig[]): string {
	const bigValues = metrics.map((m) => generateBigValue(m)).join("\n");

	return `<div class="metrics-row">
${bigValues}
</div>`;
}

/**
 * Generate a Delta component (change indicator)
 */
export function generateDelta(config: {
	dataSource: string;
	value: string;
	comparison?: string;
	format?: string;
	positive?: "up" | "down"; // Which direction is positive
}): string {
	return `<Delta
	data={${config.dataSource}}
	value="${config.value}"
	${config.comparison ? `comparison="${config.comparison}"` : ""}
	${config.format ? `fmt="${config.format}"` : ""}
	${config.positive ? `positive="${config.positive}"` : ""}
/>`;
}

/**
 * Generate a Progress component
 */
export function generateProgress(config: {
	value: number;
	max?: number;
	label?: string;
	format?: string;
}): string {
	return `<Progress
	value={${config.value}}
	${config.max ? `max={${config.max}}` : ""}
	${config.label ? `label="${escapeAttr(config.label)}"` : ""}
	${config.format ? `fmt="${config.format}"` : ""}
/>`;
}

/**
 * Generate a Badge/Chip component for status display
 */
export function generateBadge(config: {
	text: string;
	color?: "info" | "positive" | "warning" | "negative" | "neutral";
}): string {
	return `<Badge
	text="${escapeAttr(config.text)}"
	${config.color ? `color="${config.color}"` : ""}
/>`;
}

/**
 * Generate a Callout component for highlighting information
 */
export function generateCallout(config: {
	title?: string;
	content: string;
	type?: "info" | "tip" | "warning" | "caution";
}): string {
	const typeMap = {
		info: "note",
		tip: "tip",
		warning: "warning",
		caution: "caution",
	};

	const evidenceType = typeMap[config.type || "info"];

	if (config.title) {
		return `> [!${evidenceType}] ${escapeAttr(config.title)}
> ${config.content}`;
	}

	return `> [!${evidenceType}]
> ${config.content}`;
}

/**
 * Generate a Grid layout for metrics
 */
export function generateMetricsGrid(
	metrics: MetricConfig[],
	columns = 3,
): string {
	const bigValues = metrics.map((m) => generateBigValue(m)).join("\n");

	return `<Grid cols={${columns}}>
${bigValues}
</Grid>`;
}

/**
 * Generate an inline metric for embedding in text
 */
export function generateInlineMetric(config: {
	dataSource: string;
	value: string;
	format?: string;
}): string {
	return `<Value data={${config.dataSource}} column="${config.value}" ${config.format ? `fmt="${config.format}"` : ""} />`;
}

/**
 * Escape attribute value
 */
function escapeAttr(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
