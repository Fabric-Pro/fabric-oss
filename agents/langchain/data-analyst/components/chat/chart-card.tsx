"use client";

/**
 * ChartCard - Renders chart artifacts using Recharts
 *
 * Standalone version for the data-analyst app.
 * Supports chart types: line, bar, pie, area, scatter
 */

import { useState, useMemo } from "react";
import {
	ResponsiveContainer,
	LineChart,
	Line,
	BarChart,
	Bar,
	PieChart,
	Pie,
	AreaChart,
	Area,
	ScatterChart,
	Scatter,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	Legend,
	Cell,
} from "recharts";

// Chart color palette
const CHART_COLORS = [
	"#2563eb", // blue
	"#16a34a", // green
	"#ea580c", // orange
	"#9333ea", // purple
	"#dc2626", // red
];

interface ChartConfig {
	xAxis: string;
	yAxis: string | string[];
	title?: string;
	series?: string;
	stacked?: boolean;
	showLegend?: boolean;
}

interface ChartArtifact {
	type: "chart";
	id: string;
	chartType: "line" | "bar" | "pie" | "area" | "scatter";
	data: Record<string, unknown>[];
	config: ChartConfig;
	metadata?: {
		createdAt?: string;
		sourceDescription?: string;
		dataPointCount?: number;
	};
}

interface ChartCardProps {
	artifact: ChartArtifact;
	className?: string;
}

function getColor(index: number): string {
	return CHART_COLORS[index % CHART_COLORS.length];
}

export function ChartCard({ artifact, className }: ChartCardProps) {
	const [isExpanded, setIsExpanded] = useState(true);
	const { data, config, chartType, metadata } = artifact;
	const yAxisFields = Array.isArray(config.yAxis)
		? config.yAxis
		: [config.yAxis];

	const chartHeight = 300;

	const renderChart = useMemo(() => {
		const commonProps = {
			data: data as any[],
			margin: { top: 10, right: 30, left: 0, bottom: 0 },
		};

		switch (chartType) {
			case "line":
				return (
					<LineChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis dataKey={config.xAxis} tick={{ fontSize: 12 }} />
						<YAxis tick={{ fontSize: 12 }} />
						<Tooltip />
						{config.showLegend !== false && <Legend />}
						{yAxisFields.map((field, idx) => (
							<Line
								key={field}
								type="monotone"
								dataKey={field}
								stroke={getColor(idx)}
								strokeWidth={2}
								dot={{ r: 3 }}
								activeDot={{ r: 5 }}
							/>
						))}
					</LineChart>
				);

			case "bar":
				return (
					<BarChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis dataKey={config.xAxis} tick={{ fontSize: 12 }} />
						<YAxis tick={{ fontSize: 12 }} />
						<Tooltip />
						{config.showLegend !== false && <Legend />}
						{yAxisFields.map((field, idx) => (
							<Bar
								key={field}
								dataKey={field}
								fill={getColor(idx)}
								stackId={config.stacked ? "stack" : undefined}
							/>
						))}
					</BarChart>
				);

			case "area":
				return (
					<AreaChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis dataKey={config.xAxis} tick={{ fontSize: 12 }} />
						<YAxis tick={{ fontSize: 12 }} />
						<Tooltip />
						{config.showLegend !== false && <Legend />}
						{yAxisFields.map((field, idx) => (
							<Area
								key={field}
								type="monotone"
								dataKey={field}
								stroke={getColor(idx)}
								fill={getColor(idx)}
								fillOpacity={0.3}
								stackId={config.stacked ? "stack" : undefined}
							/>
						))}
					</AreaChart>
				);

			case "pie":
				return (
					<PieChart>
						<Pie
							data={data as any[]}
							cx="50%"
							cy="50%"
							labelLine={false}
							label={({ name, percent }) =>
								`${name}: ${((percent ?? 0) * 100).toFixed(0)}%`
							}
							outerRadius={100}
							dataKey={yAxisFields[0]}
							nameKey={config.xAxis}
						>
							{(data as any[]).map((_, index) => (
								<Cell
									key={`cell-${index}`}
									fill={getColor(index)}
								/>
							))}
						</Pie>
						<Tooltip />
						{config.showLegend !== false && <Legend />}
					</PieChart>
				);

			case "scatter":
				return (
					<ScatterChart {...commonProps}>
						<CartesianGrid strokeDasharray="3 3" stroke="#e5e5e5" />
						<XAxis
							type="number"
							dataKey={config.xAxis}
							name={config.xAxis}
							tick={{ fontSize: 12 }}
						/>
						<YAxis
							type="number"
							dataKey={yAxisFields[0]}
							name={yAxisFields[0]}
							tick={{ fontSize: 12 }}
						/>
						<Tooltip cursor={{ strokeDasharray: "3 3" }} />
						<Scatter
							name={config.title || "Data"}
							data={data as any[]}
							fill={getColor(0)}
						/>
					</ScatterChart>
				);

			default:
				return null;
		}
	}, [data, config, chartType, yAxisFields]);

	const handleDownload = () => {
		const csvContent = [
			Object.keys(data[0] || {}).join(","),
			...data.map((row) => Object.values(row).join(",")),
		].join("\n");

		const blob = new Blob([csvContent], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${config.title || "chart"}-data.csv`;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div
			className={`rounded-lg border border-ui-border bg-ui-card overflow-hidden ${className || ""}`}
		>
			{/* Header */}
			<div className="px-3 py-2 border-b border-ui-border bg-ui-secondary/50 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-tx-primary">
						{config.title ||
							`${chartType.charAt(0).toUpperCase() + chartType.slice(1)} Chart`}
					</span>
					{metadata?.dataPointCount && (
						<span className="text-xs text-tx-secondary">
							({metadata.dataPointCount} points)
						</span>
					)}
				</div>

				<div className="flex items-center gap-1">
					<button
						onClick={handleDownload}
						className="p-1.5 rounded hover:bg-ui-secondary text-tx-secondary hover:text-tx-primary transition-colors"
						title="Download data as CSV"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="7 10 12 15 17 10" />
							<line x1="12" y1="15" x2="12" y2="3" />
						</svg>
					</button>
					<button
						onClick={() => setIsExpanded(!isExpanded)}
						className="p-1.5 rounded hover:bg-ui-secondary text-tx-secondary hover:text-tx-primary transition-colors"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							{isExpanded ? (
								<polyline points="18 15 12 9 6 15" />
							) : (
								<polyline points="6 9 12 15 18 9" />
							)}
						</svg>
					</button>
				</div>
			</div>

			{/* Chart */}
			{isExpanded && (
				<div className="p-4">
					<ResponsiveContainer width="100%" height={chartHeight}>
						{renderChart}
					</ResponsiveContainer>
					{metadata?.sourceDescription && (
						<p className="text-xs text-tx-secondary mt-2 text-center">
							Source: {metadata.sourceDescription}
						</p>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Type guard to check if an object is a ChartArtifact
 */
function isChartArtifact(obj: unknown): obj is ChartArtifact {
	if (!obj || typeof obj !== "object") return false;
	const artifact = obj as Record<string, unknown>;
	return (
		artifact.type === "chart" &&
		typeof artifact.id === "string" &&
		typeof artifact.chartType === "string" &&
		["line", "bar", "pie", "area", "scatter"].includes(
			artifact.chartType as string,
		) &&
		Array.isArray(artifact.data) &&
		artifact.config !== null &&
		typeof artifact.config === "object"
	);
}

/**
 * Try to extract a chart artifact from a tool result
 */
export function extractChartArtifact(result: unknown): ChartArtifact | null {
	if (!result) return null;

	if (isChartArtifact(result)) {
		return result;
	}

	if (typeof result === "string") {
		try {
			const parsed = JSON.parse(result);
			if (parsed.artifact && isChartArtifact(parsed.artifact)) {
				return parsed.artifact;
			}
			if (isChartArtifact(parsed)) {
				return parsed;
			}
		} catch {
			// Not JSON
		}
	}

	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		if (obj.artifact && isChartArtifact(obj.artifact)) {
			return obj.artifact as ChartArtifact;
		}
		if (Array.isArray(obj.artifacts)) {
			const chartArtifact = obj.artifacts.find(isChartArtifact);
			if (chartArtifact) {
				return chartArtifact as ChartArtifact;
			}
		}
	}

	return null;
}
