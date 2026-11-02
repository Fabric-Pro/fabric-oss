export interface ChartConfig {
	xAxis: string;
	yAxis: string | string[];
	title?: string;
	series?: string;
	stacked?: boolean;
	showLegend?: boolean;
}

export interface ChartArtifact {
	type: "chart";
	id: string;
	chartType: "line" | "bar" | "pie" | "area" | "scatter";
	data: Record<string, unknown>[];
	config: ChartConfig;
	metadata?: {
		createdAt?: string;
		sourceDescription?: string;
		dataPointCount?: number;
		totalValue?: number;
	};
}

export function isChartArtifact(obj: unknown): obj is ChartArtifact {
	return (
		obj !== null &&
		typeof obj === "object" &&
		"type" in obj &&
		obj.type === "chart" &&
		"id" in obj &&
		typeof obj.id === "string" &&
		"chartType" in obj &&
		typeof obj.chartType === "string" &&
		["line", "bar", "pie", "area", "scatter"].includes(obj.chartType) &&
		"data" in obj &&
		Array.isArray(obj.data) &&
		"config" in obj &&
		obj.config !== null &&
		typeof obj.config === "object"
	);
}
